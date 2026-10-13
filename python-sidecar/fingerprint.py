import os
import sys
import asyncio
import tempfile
import re
import random
import aiohttp
from typing import Dict, Any, Optional
from shazamio import Shazam
from datetime import datetime

def log(message: str) -> None:
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    sys.stderr.write(f"[{now}] [FINGERPRINT] {message}\n")
    sys.stderr.flush()

async def get_audio_duration(file_path: str) -> float:
    # 1. Try instantaneous ffprobe duration read (no audio stream decoding)
    try:
        cmd_probe = [
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            file_path
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd_probe,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await proc.communicate()
        out_str = stdout.decode('utf-8', errors='ignore').strip()
        if out_str:
            return float(out_str)
    except Exception:
        pass

    # 2. Fallback: inspect ffmpeg Duration header without decoding full stream
    cmd_fallback = ['ffmpeg', '-i', file_path]
    proc_fb = await asyncio.create_subprocess_exec(
        *cmd_fallback,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    _, stderr_fb = await proc_fb.communicate()
    stderr_str = stderr_fb.decode('utf-8', errors='ignore')
    
    match = re.search(r'Duration:\s*(\d+):(\d+):(\d+\.\d+)', stderr_str)
    if match:
        hours = int(match.group(1))
        minutes = int(match.group(2))
        seconds = float(match.group(3))
        return hours * 3600 + minutes * 60 + seconds

    raise Exception(f"Could not determine audio duration for {file_path}")

async def extract_sample(input_path: str, start_time: float, output_path: str) -> None:
    cmd = [
        'ffmpeg', '-y',
        '-ss', str(start_time),
        '-t', '15',
        '-i', input_path,
        output_path
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise Exception(f"ffmpeg extraction failed: {stderr.decode('utf-8', errors='ignore')}")

def _duration_delta(val: Any, target_duration: float) -> float:
    if val is None:
        return float('inf')
    try:
        dur = float(val)
        if dur <= 0:
            return float('inf')
        return abs(dur - target_duration)
    except (ValueError, TypeError):
        return float('inf')

async def search_deezer(title: str, artist: str, target_duration: Optional[float] = None) -> Optional[int]:
    # URL encode parameters
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
    
    # Clean up title/artist to remove quotes that might mess up advanced search query
    clean_title = title.replace('"', '').strip()
    clean_artist = artist.replace('"', '').strip()
    
    queries = [
        # Advanced query
        f'track:"{clean_title}" artist:"{clean_artist}"',
        # Fallback keyword query
        f'{clean_artist} {clean_title}'
    ]
    
    async with aiohttp.ClientSession() as session:
        for q in queries:
            url = 'https://api.deezer.com/search'
            params = {'q': q}
            try:
                async with session.get(url, params=params, headers=headers) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        tracks = data.get('data', [])
                        if tracks:
                            valid_tracks = [t for t in tracks if t.get('id')]
                            if valid_tracks:
                                # Multi-release duration matching (§3.5 SPEC.md)
                                if target_duration is not None and target_duration > 0:
                                    best_track = min(
                                        valid_tracks,
                                        key=lambda t: _duration_delta(t.get('duration'), target_duration)
                                    )
                                else:
                                    best_track = valid_tracks[0]

                                deezer_id = best_track.get('id')
                                if deezer_id:
                                    track_dur = best_track.get('duration')
                                    dur_str = f" (duration {track_dur}s vs target {target_duration:.1f}s)" if (target_duration and track_dur) else ""
                                    log(f"Deezer match found: ID {deezer_id}{dur_str} for '{clean_artist} - {clean_title}' (query: {q})")
                                    return int(deezer_id)
            except Exception as e:
                log(f"Deezer search error: {e}")
                
    log(f"No Deezer match found for '{clean_artist} - {clean_title}'")
    return None

async def fingerprint_file(file_path: str) -> Dict[str, Any]:
    log(f"Fingerprinting file: {file_path}")
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"File not found: {file_path}")
        
    duration = await get_audio_duration(file_path)
    log(f"File duration: {duration:.2f} seconds")
    
    attempts = 3
    shazam = Shazam()
    last_error = None
    
    for attempt in range(1, attempts + 1):
        min_offset = 0.20 * duration
        max_offset = 0.75 * duration
        start_offset = random.uniform(min_offset, max_offset)
        
        log(f"[Attempt {attempt}/{attempts}] Extracting 15s sample starting at {start_offset:.2f}s")
        
        # Create temp sample path
        ext = os.path.splitext(file_path)[1]
        if not ext:
            ext = '.mp3'
            
        temp_dir = tempfile.gettempdir()
        temp_sample_path = os.path.join(temp_dir, f"crateup_temp_sample_{os.getpid()}_{attempt}{ext}")
        
        try:
            await extract_sample(file_path, start_offset, temp_sample_path)
            
            log(f"[Attempt {attempt}/{attempts}] Sending sample to Shazam API...")
            result = await shazam.recognize(temp_sample_path)
            
            # Parse Shazam response
            if not result or 'track' not in result:
                log(f"[Attempt {attempt}/{attempts}] Shazam: No match found.")
                raise ValueError("unidentified")
                
            track = result['track']
            title = track.get('title')
            artist = track.get('subtitle')
            
            if not title or not artist:
                log(f"[Attempt {attempt}/{attempts}] Shazam: Missing title or artist in response.")
                raise ValueError("unidentified")
                
            log(f"[Attempt {attempt}/{attempts}] Shazam match: '{artist} - {title}'")
            
            # Search Deezer with target duration matching (§3.5 SPEC.md)
            deezer_id = await search_deezer(title, artist, target_duration=duration)
            
            return {
                "deezer_id": deezer_id,
                "title": title,
                "artist": artist
            }
            
        except Exception as e:
            last_error = e
            log(f"[Attempt {attempt}/{attempts}] failed: {e}")
            # Continue to next attempt
        finally:
            if os.path.exists(temp_sample_path):
                try:
                    os.remove(temp_sample_path)
                except Exception as e:
                    log(f"Failed to remove temp file {temp_sample_path}: {e}")
                    
    log("All fingerprinting attempts failed.")
    if last_error:
        raise last_error
    else:
        raise ValueError("unidentified")
