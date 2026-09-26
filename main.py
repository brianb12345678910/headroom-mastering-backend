import json
import os
import re
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from processing import (
    CONSOLES,
    MasterSettings,
    ProcessingError,
    analyze_track,
    ffmpeg_available,
    process_track,
)

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "250")) * 1024 * 1024
STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="Headroom Mastering Backend",
    description="Audio mixing console and mastering backend API",
    version="1.1.0",
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def console_ui() -> FileResponse:
    """Serve the browser mixing console."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Return the service health status."""
    return {"status": "ok", "ffmpeg": "available" if ffmpeg_available() else "missing"}


@app.get("/consoles")
async def list_consoles() -> list[dict[str, str]]:
    """List the available console coloration presets for /master."""
    return [
        {"id": key, "label": preset["label"], "description": preset["description"]}
        for key, preset in CONSOLES.items()
    ]


async def _read_upload(file: UploadFile) -> tuple[bytes, str]:
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Uploaded file is too large")
    ext = Path(file.filename or "").suffix.lower()
    suffix = ext if re.fullmatch(r"\.[a-z0-9]{1,5}", ext) else ".wav"
    return data, suffix


@app.post("/analyze")
async def analyze(file: UploadFile = File(...)) -> dict:
    """Measure integrated loudness (LUFS), true peak (dBTP) and loudness range (LU)."""
    data, suffix = await _read_upload(file)
    try:
        return await run_in_threadpool(analyze_track, data, suffix)
    except ProcessingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/master")
async def master(
    file: UploadFile = File(...),
    console: str = Form("none"),
    target_lufs: float = Form(-14.0),
    true_peak: float = Form(-1.0),
    width: float = Form(1.0),
    bit_depth: int = Form(24),
) -> Response:
    """Master a track: console coloration, then two-pass EBU R128 loudness normalization.

    Returns a WAV file. Loudness stats are in the X-Headroom-Stats header (JSON).
    """
    settings = MasterSettings(
        console=console,
        target_lufs=target_lufs,
        true_peak=true_peak,
        width=width,
        bit_depth=bit_depth,
    )
    try:
        settings.validate()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    data, suffix = await _read_upload(file)
    try:
        result = await run_in_threadpool(process_track, data, settings, suffix)
    except ProcessingError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    stem = Path(file.filename or "track").stem or "track"
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem)[:80]
    stats = {
        "input": result.input_stats,
        "colored": result.colored_stats,
        "output": result.output_stats,
        "settings": settings.__dict__,
    }
    return Response(
        content=result.audio,
        media_type="audio/wav",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_stem}_mastered.wav"',
            "X-Headroom-Stats": json.dumps(stats),
            "Access-Control-Expose-Headers": "X-Headroom-Stats",
        },
    )
