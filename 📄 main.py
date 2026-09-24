from fastapi import FastAPI

app = FastAPI(
    title="Headroom Mastering Backend",
    description="Audio mastering backend API",
    version="1.0.0",
)


@app.get("/health")
async def health_check() -> dict[str, str]:
    """Return the service health status."""
    return {"status": "ok"}
