"""ffmpeg-based mastering chain with two-pass EBU R128 loudness normalization."""

import json
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field

FFMPEG = os.environ.get("FFMPEG_BIN", "ffmpeg")

# Each console is a coloration chain that runs *before* loudness normalization.
# Levels are kept conservative: the loudnorm stage sets the final loudness and
# true-peak ceiling, so these only shape tone and dynamics.
CONSOLES: dict[str, dict] = {
    "none": {
        "label": "Clean",
        "description": "Transparent: loudness and true-peak only.",
        "filters": [],
    },
    "ssl4000": {
        "label": "SSL 4000 G Bus",
        "description": "Punchy VCA bus compression (4:1, fast attack, auto-release feel).",
        "filters": [
            "highpass=f=25:poles=2",
            "equalizer=f=100:t=q:w=0.8:g=0.8",
            "equalizer=f=3500:t=q:w=1.0:g=0.6",
            "acompressor=threshold=-16dB:ratio=4:attack=10:release=120:knee=2:makeup=2dB",
        ],
    },
    "sl9000j": {
        "label": "SSL 9000 J",
        "description": "Cleaner, wider SuperAnalogue glue with gentle 2:1 compression.",
        "filters": [
            "highpass=f=20:poles=2",
            "highshelf=f=10000:g=1.0",
            "acompressor=threshold=-20dB:ratio=2:attack=30:release=200:knee=4:makeup=1.5dB",
            "extrastereo=m=1.1:c=false",
        ],
    },
    "neve8078": {
        "label": "Neve 8078",
        "description": "Warm transformer color: low-end weight, silky top, slow opto-style glue.",
        "filters": [
            "highpass=f=22:poles=2",
            "lowshelf=f=90:g=1.5",
            "equalizer=f=400:t=q:w=1.2:g=-0.6",
            "highshelf=f=12000:g=1.2",
            "acompressor=threshold=-18dB:ratio=2:attack=35:release=300:knee=6:makeup=1.5dB",
            "volume=2dB",
            "asoftclip=type=tanh:threshold=0.95",
            "volume=-2dB",
        ],
    },
    "tape": {
        "label": "Tape Machine",
        "description": "Half-inch tape: soft saturation, head bump, rolled-off highs.",
        "filters": [
            "highpass=f=28:poles=2",
            "equalizer=f=65:t=q:w=1.0:g=1.8",
            "highshelf=f=15000:g=-1.5",
            "volume=3dB",
            "asoftclip=type=atan:threshold=0.9",
            "volume=-3dB",
            "acompressor=threshold=-14dB:ratio=1.5:attack=5:release=80:knee=6",
        ],
    },
}

TARGET_LUFS_RANGE = (-30.0, -5.0)
TRUE_PEAK_RANGE = (-9.0, 0.0)
WIDTH_RANGE = (0.0, 2.0)
BIT_DEPTHS = {16: "pcm_s16le", 24: "pcm_s24le"}


class ProcessingError(RuntimeError):
    """Raised when ffmpeg fails or produces unusable output."""


@dataclass
class MasterSettings:
    console: str = "none"
    target_lufs: float = -14.0
    true_peak: float = -1.0
    width: float = 1.0
    bit_depth: int = 24

    def validate(self) -> None:
        if self.console not in CONSOLES:
            raise ValueError(f"Unknown console '{self.console}'. Choose one of: {', '.join(CONSOLES)}")
        _check_range("target_lufs", self.target_lufs, TARGET_LUFS_RANGE)
        _check_range("true_peak", self.true_peak, TRUE_PEAK_RANGE)
        _check_range("width", self.width, WIDTH_RANGE)
        if self.bit_depth not in BIT_DEPTHS:
            raise ValueError("bit_depth must be 16 or 24")


@dataclass
class MasterResult:
    audio: bytes
    input_stats: dict = field(default_factory=dict)  # the file as uploaded
    colored_stats: dict = field(default_factory=dict)  # after console coloration, before loudnorm
    output_stats: dict = field(default_factory=dict)


def _check_range(name: str, value: float, bounds: tuple[float, float]) -> None:
    lo, hi = bounds
    if not lo <= value <= hi:
        raise ValueError(f"{name} must be between {lo} and {hi}")


def ffmpeg_available() -> bool:
    return shutil.which(FFMPEG) is not None


def _run(cmd: list[str]) -> str:
    """Run ffmpeg and return stderr (where loudnorm prints its report)."""
    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=600)
    except FileNotFoundError as exc:
        raise ProcessingError("ffmpeg is not installed on the server") from exc
    except subprocess.TimeoutExpired as exc:
        raise ProcessingError("ffmpeg timed out") from exc
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-5:])
        raise ProcessingError(f"ffmpeg failed: {tail}")
    return proc.stderr


def _parse_loudnorm_json(stderr: str) -> dict:
    # loudnorm prints a single flat JSON object as the last {...} block.
    matches = re.findall(r"\{[^{}]*\}", stderr, re.DOTALL)
    if not matches:
        raise ProcessingError("Could not read loudness measurement from ffmpeg output")
    return json.loads(matches[-1])


def _to_float(value: str) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    # Silence reports -inf, which is not JSON serializable.
    return number if number not in (float("inf"), float("-inf")) else None


def _stats(report: dict, prefix: str) -> dict:
    return {
        "integrated_lufs": _to_float(report.get(f"{prefix}_i")),
        "true_peak_db": _to_float(report.get(f"{prefix}_tp")),
        "loudness_range_lu": _to_float(report.get(f"{prefix}_lra")),
    }


def build_chain(settings: MasterSettings) -> list[str]:
    chain = ["aformat=channel_layouts=stereo"]
    chain += CONSOLES[settings.console]["filters"]
    if abs(settings.width - 1.0) > 1e-3:
        chain.append(f"extrastereo=m={settings.width:.3f}:c=false")
    return chain


def _probe_sample_rate(stderr: str) -> int:
    match = re.search(r"Audio:.*?(\d{4,6}) Hz", stderr)
    return int(match.group(1)) if match else 48000


def _measure(input_path: str, chain: list[str], settings: MasterSettings) -> tuple[dict, int]:
    loudnorm = f"loudnorm=I={settings.target_lufs}:TP={settings.true_peak}:LRA=11:print_format=json"
    stderr = _run([
        FFMPEG, "-hide_banner", "-nostdin", "-i", input_path,
        "-af", ",".join(chain + [loudnorm]),
        "-f", "null", "-",
    ])
    return _parse_loudnorm_json(stderr), _probe_sample_rate(stderr)


def analyze_file(input_path: str) -> dict:
    """Measure integrated loudness, true peak and loudness range of a file as-is."""
    report, sample_rate = _measure(input_path, ["aformat=channel_layouts=stereo"], MasterSettings())
    return {**_stats(report, "input"), "sample_rate": sample_rate}


def master_file(input_path: str, output_path: str, settings: MasterSettings) -> MasterResult:
    settings.validate()
    chain = build_chain(settings)
    source_stats = analyze_file(input_path)

    # Pass 1: measure the colored signal so pass 2 can apply a linear gain.
    measured, sample_rate = _measure(input_path, chain, settings)
    loudnorm = (
        f"loudnorm=I={settings.target_lufs}:TP={settings.true_peak}:LRA=11"
        f":measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}:linear=true:print_format=json"
    )
    # loudnorm resamples to 192 kHz internally; bring it back to the source rate.
    stderr = _run([
        FFMPEG, "-hide_banner", "-nostdin", "-y", "-i", input_path,
        "-af", ",".join(chain + [loudnorm]),
        "-ar", str(sample_rate),
        "-c:a", BIT_DEPTHS[settings.bit_depth],
        output_path,
    ])
    final = _parse_loudnorm_json(stderr)

    with open(output_path, "rb") as f:
        audio = f.read()
    if not audio:
        raise ProcessingError("ffmpeg produced an empty file")

    return MasterResult(
        audio=audio,
        input_stats=source_stats,
        colored_stats=_stats(measured, "input"),
        output_stats={**_stats(final, "output"), "normalization": final.get("normalization_type")},
    )


def process_track(input_bytes: bytes, settings: MasterSettings, suffix: str = ".wav") -> MasterResult:
    """Master an in-memory audio file and return the mastered WAV bytes plus loudness stats."""
    with tempfile.TemporaryDirectory(prefix="headroom-") as workdir:
        input_path = os.path.join(workdir, f"input{suffix}")
        output_path = os.path.join(workdir, "mastered.wav")
        with open(input_path, "wb") as f:
            f.write(input_bytes)
        return master_file(input_path, output_path, settings)


def analyze_track(input_bytes: bytes, suffix: str = ".wav") -> dict:
    with tempfile.TemporaryDirectory(prefix="headroom-") as workdir:
        input_path = os.path.join(workdir, f"input{suffix}")
        with open(input_path, "wb") as f:
            f.write(input_bytes)
        return analyze_file(input_path)
