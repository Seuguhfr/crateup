import sys
import json
import asyncio
from datetime import datetime

# Import fingerprint and download modules
from fingerprint import fingerprint_file
from download import download_track

def log(message: str) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write(f"[{now}] [PYTHON] {message}\n")
    sys.stderr.flush()

async def main() -> None:
    log("Python sidecar started.")
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line_bytes = await reader.readline()
        if not line_bytes:
            log("Stdin EOF reached. Exiting.")
            break
        line = line_bytes.decode('utf-8').strip()
        if not line:
            continue
        log(f"Received message: {line}")
        try:
            data = json.loads(line)
        except json.JSONDecodeError as e:
            log(f"JSON decode error: {e}")
            continue

        method = data.get("method")
        msg_id = data.get("id")
        params = data.get("params", {})

        if method == "ping":
            resp = {"id": msg_id, "result": "pong"}
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        elif method == "fingerprint":
            path = params.get("path")
            try:
                result = await fingerprint_file(path)
                resp = {"id": msg_id, "result": result}
            except ValueError as ve:
                resp = {"id": msg_id, "error": str(ve)}
            except Exception as e:
                log(f"Error fingerprinting: {e}")
                resp = {"id": msg_id, "error": "unidentified"}
            
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        elif method == "download":
            deezer_id = params.get("deezer_id")
            output_format = params.get("output_format")
            staged_path = params.get("staged_path")
            try:
                result = await download_track(deezer_id, output_format, staged_path)
                resp = {"id": msg_id, "result": result}
            except Exception as e:
                log(f"Error downloading: {e}")
                resp = {"id": msg_id, "error": "download_failed"}
                
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        else:
            log(f"Received unknown method: {method}")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("Python sidecar interrupted.")
