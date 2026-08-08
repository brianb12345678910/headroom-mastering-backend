# Headroom Mastering Backend

FastAPI + ffmpeg mastering backend with two-pass EBU R128 loudness normalization.

## Run locally

pip install -r requirements.txt
uvicorn main:app --reload --port 8000

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project → Deploy from GitHub
3. Railway auto-detects the Dockerfile
4. ffmpeg installs automatically
5. Backend runs on port 8000

## Test

curl https://your-railway-url/health
curl -X POST https://your-railway-url/master -F "file=@track.wav" -F "console=neve8078" -o mastered.wav
