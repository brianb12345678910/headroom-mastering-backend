# Headroom Mastering Backend

A browser mixing console plus a FastAPI + ffmpeg mastering backend with two-pass EBU R128 loudness normalization.

## Run locally

```bash
pip install -r requirements.txt   # ffmpeg must be on PATH (or set FFMPEG_BIN)
uvicorn main:app --reload --port 8000
```

Open http://localhost:8000 for the console.

## The console

Click **Load demo song** to try it with a six-track song generated in the browser, or drop your own stems (WAV, MP3, FLAC, OGG, M4A, AIFF) anywhere on the page. Each file becomes a channel.

**Channel strip** (top to bottom)
- **Input:** trim (±24 dB) and a low-cut filter.
- **EQ:** high shelf, a mid band with adjustable frequency and Q, and a low shelf. Each band goes to ±15 dB.
- **Compressor:** threshold, ratio, attack, release, makeup gain and a gain-reduction meter.
- **Reverb send** (post-fader), **pan**, **mute / solo**, a fader and a peak meter.
- **Presets** for vocal, kick, snare, hats, bass, guitar, keys and lead. When a file's name suggests an instrument (for example `kick.wav` or `lead vox.wav`), the matching preset is applied when it loads.

**Reverb return:** a shared reverb with decay, pre-delay, tone and a low cut that cleans up the low end.

**Master bus:** EQ, glue compressor, stereo width (mid/side) and a lookahead brickwall limiter (drive, ceiling, release). Loudness is metered live to BS.1770 / EBU R128: momentary, short-term and integrated LUFS, plus peak.

**Controls:** drag knobs up or down (hold Shift for fine moves), or use the mouse wheel or arrow keys. Double-click a knob or fader to reset it. Space plays and pauses, Home jumps back to the start, and clicking the waveform overview seeks.

**Bounce:** renders the mix faster than real time through the same audio graph you hear, so the export matches playback. It downloads a 24- or 16-bit WAV; 16-bit files get TPDF dither. **Match target** re-renders the mix and moves the limiter drive until the bounce reaches the chosen LUFS target.

**Server master:** uploads the bounce to `/master` to add console coloration and apply true-peak-safe loudness normalization. You get A/B players and a download link. The browser limiter only limits sample peaks, so use the server master when you need a true-peak ceiling.

**Save mix / Load mix:** saves or loads every setting as JSON. Settings are matched to channels by name.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Service status and ffmpeg availability |
| GET | `/consoles` | Console coloration presets |
| POST | `/analyze` | `file`, returns integrated LUFS, true peak (dBTP) and loudness range (LU) |
| POST | `/master` | `file`, `console`, `target_lufs` (-30..-5), `true_peak` (-9..0), `width` (0..2), `bit_depth` (16/24). Returns WAV; stats in the `X-Headroom-Stats` header |

Consoles: `none`, `ssl4000`, `sl9000j`, `neve8078`, `tape`.

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/master -F "file=@track.wav" -F "console=neve8078" -F "target_lufs=-14" -o mastered.wav
```

## Tests

```bash
pip install pytest httpx
pytest
```

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project → Deploy from GitHub
3. Railway auto-detects the Dockerfile
4. ffmpeg installs automatically
5. Backend runs on port 8000
