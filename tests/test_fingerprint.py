import os
import pytest
import asyncio
from unittest.mock import AsyncMock, patch
from fingerprint import get_audio_duration, extract_sample, fingerprint_file, search_deezer

import pytest_asyncio

@pytest_asyncio.fixture(scope="module")
async def dummy_audio_file():
    path = os.path.join(os.path.dirname(__file__), "dummy_sine.wav")
    cmd = [
        'ffmpeg', '-y',
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=20',
        '-acodec', 'pcm_s16le',
        path
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    await proc.communicate()
    yield path
    if os.path.exists(path):
        os.remove(path)

@pytest.mark.asyncio
async def test_get_audio_duration(dummy_audio_file):
    duration = await get_audio_duration(dummy_audio_file)
    assert abs(duration - 20.0) < 0.5

@pytest.mark.asyncio
async def test_extract_sample(dummy_audio_file):
    sample_path = os.path.join(os.path.dirname(__file__), "temp_sample.wav")
    if os.path.exists(sample_path):
        os.remove(sample_path)
        
    try:
        await extract_sample(dummy_audio_file, 5.0, sample_path)
        assert os.path.exists(sample_path)
        duration = await get_audio_duration(sample_path)
        assert abs(duration - 15.0) < 0.5
    finally:
        if os.path.exists(sample_path):
            os.remove(sample_path)

@pytest.mark.asyncio
@patch('fingerprint.Shazam')
@patch('fingerprint.search_deezer')
async def test_fingerprint_file_success(mock_search_deezer, mock_shazam_class, dummy_audio_file):
    mock_shazam_instance = AsyncMock()
    mock_shazam_instance.recognize.return_value = {
        'track': {
            'title': 'Mock Title',
            'subtitle': 'Mock Artist'
        }
    }
    mock_shazam_class.return_value = mock_shazam_instance
    mock_search_deezer.return_value = 123456789
    
    result = await fingerprint_file(dummy_audio_file)
    assert result == {
        'deezer_id': 123456789,
        'title': 'Mock Title',
        'artist': 'Mock Artist'
    }
    mock_shazam_instance.recognize.assert_called_once()
    mock_search_deezer.assert_called_with('Mock Title', 'Mock Artist')

@pytest.mark.asyncio
@patch('fingerprint.Shazam')
async def test_fingerprint_file_unidentified(mock_shazam_class, dummy_audio_file):
    mock_shazam_instance = AsyncMock()
    mock_shazam_instance.recognize.return_value = {}
    mock_shazam_class.return_value = mock_shazam_instance
    
    with pytest.raises(ValueError, match="unidentified"):
        await fingerprint_file(dummy_audio_file)
    assert mock_shazam_instance.recognize.call_count == 3

@pytest.mark.asyncio
@patch('fingerprint.Shazam')
@patch('fingerprint.search_deezer')
async def test_fingerprint_file_retry_success(mock_search_deezer, mock_shazam_class, dummy_audio_file):
    mock_shazam_instance = AsyncMock()
    mock_shazam_instance.recognize.side_effect = [
        {}, # 1st attempt fails
        {   # 2nd attempt succeeds
            'track': {
                'title': 'Mock Title 2',
                'subtitle': 'Mock Artist 2'
            }
        }
    ]
    mock_shazam_class.return_value = mock_shazam_instance
    mock_search_deezer.return_value = 987654321
    
    result = await fingerprint_file(dummy_audio_file)
    assert result == {
        'deezer_id': 987654321,
        'title': 'Mock Title 2',
        'artist': 'Mock Artist 2'
    }
    assert mock_shazam_instance.recognize.call_count == 2
