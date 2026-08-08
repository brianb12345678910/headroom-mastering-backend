import subprocess
import tempfile
import os

def process_track(input_bytes: bytes, console: str):
    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as input_file:
        input_file.write(input_bytes)
        input_path = input_file.name

    output_path = input_path.replace(".wav", "_mastered.wav")

    console_filter = {
        "none": "",
        "sl9000j": "acompressor",
        "ssl4000": "acompressor",
        "neve8078": "acompressor",
        "tape": "alimiter"
    }.get(console, "")

    cmd = [
        "ffmpeg",
        "-i", input_path,
        "-af", f"loudnorm=I=-14:TP=-1{',' + console_filter if console_filter else ''}",
        output_path,
        "-y"
    ]

    subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    with open(output_path, "rb") as f:
        data = f.read()
