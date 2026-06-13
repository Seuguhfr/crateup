import os
import sys
import asyncio
import shutil
import tempfile
import re
import json
from typing import Dict, Any, Optional
from datetime import datetime
from pathlib import Path

def log(message: str) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write(f"[{now}] [DOWNLOAD] {message}\n")
    sys.stderr.flush()

def get_arl() -> Optional[str]:
    if os.environ.get("DEEZER_ARL"):
        arl = os.environ.get("DEEZER_ARL").strip()
        sys.stderr.write(f"[DOWNLOAD] ARL read from env var DEEZER_ARL: {len(arl)} chars\n")
        sys.stderr.flush()
        return arl
    
    script_dir = Path(__file__).resolve().parent
    local_paths = [
        script_dir.parent / ".arl",
        script_dir / ".arl",
        Path(".arl").resolve(),
        Path.home() / ".config" / "deemix" / ".arl",
        Path.home() / "Library" / "Application Support" / "deemix" / ".arl"
    ]
    
    for path in local_paths:
        sys.stderr.write(f"[DOWNLOAD] Checking ARL path: {path}\n")
        sys.stderr.flush()
        if path.exists():
            try:
                arl = path.read_text(encoding="utf-8").strip()
                if arl:
                    sys.stderr.write(f"[DOWNLOAD] ARL found at {path}: {len(arl)} chars\n")
                    sys.stderr.flush()
                    return arl
            except Exception as e:
                log(f"Failed to read ARL from {path}: {e}")
                
    sys.stderr.write("[DOWNLOAD] No ARL found in any path\n")
    sys.stderr.flush()
    return None

async def transcode_file(input_path: str, output_path: str) -> None:
    cmd = [
        'ffmpeg', '-y',
        '-i', input_path,
        # Preserve tags if supported
        '-write_id3v2', '1',
        output_path
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise Exception(f"Transcoding failed: {stderr.decode('utf-8', errors='ignore')}")

async def create_proxy_mp3(aiff_path: str, proxy_path: str) -> None:
    cmd = [
        'ffmpeg', '-y',
        '-i', aiff_path,
        '-codec:a', 'libmp3lame',
        '-qscale:a', '4',
        proxy_path
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise Exception(f"Proxy MP3 extraction failed: {stderr.decode('utf-8', errors='ignore')}")

async def download_track(deezer_id: int, output_format: str, staged_path: str) -> Dict[str, Any]:
    log(f"Starting download: ID={deezer_id}, format={output_format}, target={staged_path}")
    
    arl = get_arl()
    if not arl:
        log("Error: No Deezer ARL token found.")
        raise ValueError("missing_arl")
        
    for config_dir in [Path.home() / ".config" / "deemix", 
                       Path.home() / "Library" / "Application Support" / "deemix"]:
        try:
            config_dir.mkdir(parents=True, exist_ok=True)
            arl_path = config_dir / ".arl"
            arl_path.write_text(arl.strip(), encoding="utf-8")
            # Verify
            written = arl_path.read_text(encoding="utf-8").strip()
            print(f"[DOWNLOAD] ARL written to {arl_path}: {len(written)} chars", 
                  file=sys.stderr)
            assert len(written) > 100, f"ARL too short: {len(written)} chars"
        except AssertionError as ae:
            log(f"ARL verification failed: {ae}")
            raise ae
        except Exception as e:
            log(f"Failed to write ARL to {config_dir}: {e}")
        
    temp_dir = tempfile.mkdtemp(prefix="crateup_deemix_")
    
    # Deezer download is requested as FLAC if the output format is lossless (FLAC, AIFF, WAV)
    target_format_lower = output_format.lower()
    is_lossless = target_format_lower in ["flac", "aiff", "wav"]
    bitrate = "FLAC" if is_lossless else "320"
    
    track_url = f"https://www.deezer.com/track/{deezer_id}"
    
    python_bin = sys.executable
    cmd = [
        python_bin, "-m", "deemix",
        "-b", bitrate,
        "-p", temp_dir,
        track_url
    ]
    
    import subprocess
    log("ARL written to config dirs, spawning deemix...")
    log(f"Spawning: {' '.join(cmd)}")
    
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.PIPE
    )
    stdout, stderr = await proc.communicate(input=arl.encode('utf-8') + b"\n")
    
    if proc.returncode != 0:
        log(f"deemix failed: {stderr.decode('utf-8', errors='ignore')}")
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise Exception("download_failed")
        
    # Search for downloaded file in temp_dir
    downloaded_files = []
    for root, _, files in os.walk(temp_dir):
        for file in files:
            if not file.startswith('.'):
                downloaded_files.append(os.path.join(root, file))
                
    if not downloaded_files:
        log("No files downloaded by deemix.")
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise Exception("download_failed")
        
    downloaded_file = downloaded_files[0]
    log(f"Deemix output: {downloaded_file}")
    
    # Ensure final directory exists
    os.makedirs(os.path.dirname(staged_path), exist_ok=True)
    
    proxy_path = None
    
    try:
        # Transcode/move as required
        if target_format_lower == "flac":
            # Simple move
            shutil.move(downloaded_file, staged_path)
            log(f"Saved FLAC to {staged_path}")
        elif target_format_lower in ["aiff", "wav"]:
            # Need to transcode FLAC to AIFF/WAV
            temp_transcode = os.path.join(temp_dir, f"transcoded.{target_format_lower}")
            log(f"Transcoding FLAC to {target_format_lower.upper()}...")
            await transcode_file(downloaded_file, temp_transcode)
            
            # Move transcoded file to final location
            shutil.move(temp_transcode, staged_path)
            log(f"Saved {target_format_lower.upper()} to {staged_path}")
            
            if target_format_lower == "aiff":
                # For AIFF, also extract proxy MP3
                # Proxy name: track.proxy.mp3 (alongside staged_path track.aiff)
                base_path_without_ext = os.path.splitext(staged_path)[0]
                proxy_path = f"{base_path_without_ext}.proxy.mp3"
                log("Extracting proxy MP3 for AIFF playback...")
                try:
                    await create_proxy_mp3(staged_path, proxy_path)
                    log(f"Saved proxy MP3 to {proxy_path}")
                except Exception as pe:
                    log(f"Proxy extraction warning: {pe}")
                    proxy_path = None
        else:
            # MP3 (or any other format) - simple move
            shutil.move(downloaded_file, staged_path)
            log(f"Saved file to {staged_path}")
            
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
        
    # Return result dict in correct schema format
    result = {
        "staged_path": staged_path
    }
    if proxy_path:
        result["proxy_path"] = proxy_path
        
    return result
