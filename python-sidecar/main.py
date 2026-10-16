import sys
import json
import asyncio
from datetime import datetime

# Import fingerprint and download modules
from fingerprint import fingerprint_file, is_network_error
from download import download_track

stdout_lock = asyncio.Lock()

def log(message: str) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write(f"[{now}] [PYTHON] {message}\n")
    sys.stderr.flush()

async def send_response(resp: dict) -> None:
    async with stdout_lock:
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()

async def handle_request(data: dict) -> None:
    method = data.get("method")
    msg_id = data.get("id")
    params = data.get("params", {})

    if method == "ping":
        await send_response({"id": msg_id, "result": "pong"})
    elif method == "fingerprint":
        path = params.get("path")
        try:
            result = await fingerprint_file(path)
            resp = {"id": msg_id, "result": result}
        except ValueError as ve:
            resp = {"id": msg_id, "error": str(ve)}
        except Exception as e:
            log(f"Error fingerprinting: {e}")
            err_code = "network_error" if is_network_error(e) else "unidentified"
            resp = {"id": msg_id, "error": err_code}
        await send_response(resp)
    elif method == "download":
        deezer_id = params.get("deezer_id")
        output_format = params.get("output_format")
        staged_path = params.get("staged_path")
        try:
            result = await download_track(deezer_id, output_format, staged_path)
            resp = {"id": msg_id, "result": result}
        except ValueError as ve:
            resp = {"id": msg_id, "error": str(ve)}
        except Exception as e:
            log(f"Error downloading: {e}")
            resp = {"id": msg_id, "error": "download_failed"}
        await send_response(resp)
    else:
        log(f"Received unknown method: {method}")
        await send_response({"id": msg_id, "error": f"unknown_method: {method}"})

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
            # Dispatch concurrently without blocking the stdin reader loop
            asyncio.create_task(handle_request(data))
        except json.JSONDecodeError as e:
            log(f"JSON decode error: {e}")
            continue

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("Python sidecar interrupted.")
