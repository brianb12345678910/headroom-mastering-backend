import io
import json
import math
import struct
import wave

import pytest
from fastapi.testclient import TestClient

from main import app
from processing import CONSOLES, ffmpeg_available

client = TestClient(app)
needs_ffmpeg = pytest.mark.skipif(not ffmpeg_available(), reason="ffmpeg not installed")


def make_wav(seconds: float = 3.0, rate: int = 44100, amplitude: float = 0.2) -> bytes:
    """Stereo 16-bit test signal: a 220 Hz tone with a 3 Hz tremolo."""
    frames = bytearray()
    for i in range(int(seconds * rate)):
        t = i / rate
        v = amplitude * math.sin(2 * math.pi * 220 * t) * (0.6 + 0.4 * math.sin(2 * math.pi * 3 * t))
        s = int(max(-1.0, min(1.0, v)) * 32767)
        frames += struct.pack("<hh", s, s)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return buf.getvalue()


def read_wav_header(data: bytes) -> dict:
    """Minimal RIFF parser; handles WAVE_FORMAT_EXTENSIBLE, which ffmpeg uses for 24-bit."""
    assert data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    pos, info = 12, {}
    while pos + 8 <= len(data):
        cid, size = data[pos:pos + 4], struct.unpack("<I", data[pos + 4:pos + 8])[0]
        if cid == b"fmt ":
            _, ch, rate, _, block, bits = struct.unpack("<HHIIHH", data[pos + 8:pos + 24])
            info.update(channels=ch, rate=rate, bits=bits, block=block)
        elif cid == b"data":
            info["frames"] = size // info["block"]
            break
        pos += 8 + size + (size & 1)
    return info


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_console_ui_served():
    res = client.get("/")
    assert res.status_code == 200
    assert "Headroom Console" in res.text
    for asset in ("/static/console.js", "/static/console.css", "/static/worklets.js"):
        assert client.get(asset).status_code == 200


def test_list_consoles():
    ids = [c["id"] for c in client.get("/consoles").json()]
    assert ids == list(CONSOLES)


def test_master_rejects_bad_settings():
    files = {"file": ("mix.wav", b"RIFF", "audio/wav")}
    assert client.post("/master", files=files, data={"console": "nope"}).status_code == 400
    assert client.post("/master", files=files, data={"target_lufs": "3"}).status_code == 400
    assert client.post("/master", files=files, data={"bit_depth": "8"}).status_code == 400


@needs_ffmpeg
def test_master_rejects_garbage_audio():
    files = {"file": ("mix.wav", b"not audio at all", "audio/wav")}
    assert client.post("/master", files=files).status_code == 422


@needs_ffmpeg
def test_analyze():
    res = client.post("/analyze", files={"file": ("mix.wav", make_wav(), "audio/wav")})
    assert res.status_code == 200
    body = res.json()
    assert body["sample_rate"] == 44100
    assert -40 < body["integrated_lufs"] < -10


@needs_ffmpeg
@pytest.mark.parametrize("console", list(CONSOLES))
def test_master_hits_loudness_target(console):
    res = client.post(
        "/master",
        files={"file": ("my mix.wav", make_wav(), "audio/wav")},
        data={"console": console, "target_lufs": "-16", "true_peak": "-1", "bit_depth": "24"},
    )
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "audio/wav"
    assert 'filename="my_mix_mastered.wav"' in res.headers["content-disposition"]

    stats = json.loads(res.headers["x-headroom-stats"])
    assert abs(stats["output"]["integrated_lufs"] - -16) < 1.0
    assert stats["output"]["true_peak_db"] <= -0.5

    header = read_wav_header(res.content)
    assert header["rate"] == 44100
    assert header["bits"] == 24
    assert header["channels"] == 2
    assert abs(header["frames"] / 44100 - 3.0) < 0.1

    # Independent re-measurement of the returned file.
    check = client.post("/analyze", files={"file": ("m.wav", res.content, "audio/wav")}).json()
    assert abs(check["integrated_lufs"] - -16) < 1.0
