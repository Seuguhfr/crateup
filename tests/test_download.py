import os
import pytest
import shutil
import pytest_asyncio
from unittest.mock import AsyncMock, patch
from download import download_track

@pytest_asyncio.fixture(scope="module")
async def temp_staging_dir():
    dir_path = os.path.join(os.path.dirname(__file__), "temp_staging")
    os.makedirs(dir_path, exist_ok=True)
    yield dir_path
    if os.path.exists(dir_path):
        shutil.rmtree(dir_path)

@pytest.mark.asyncio
@patch('download.get_arl')
@patch('asyncio.create_subprocess_exec')
async def test_download_track_flac_success(mock_create_proc, mock_get_arl, temp_staging_dir):
    mock_get_arl.return_value = "dummy_arl_token_long_enough_to_pass_validation_check_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890"
    
    staged_path = os.path.join(temp_staging_dir, "track1.flac")
    if os.path.exists(staged_path):
        os.remove(staged_path)
        
    mock_proc = AsyncMock()
    mock_proc.returncode = 0
    mock_proc.communicate.return_value = (b"", b"")
    mock_create_proc.return_value = mock_proc
    
    def side_effect(*args, **kwargs):
        cmd = args
        if "-p" in cmd:
            p_index = cmd.index("-p")
            temp_dest = cmd[p_index + 1]
            os.makedirs(temp_dest, exist_ok=True)
            dummy_file = os.path.join(temp_dest, "Artist - Track.flac")
            with open(dummy_file, "w") as f:
                f.write("dummy flac data")
        return mock_proc

    mock_create_proc.side_effect = side_effect
    
    result = await download_track(12345, "flac", staged_path)
    
    assert result == {"staged_path": staged_path}
    assert os.path.exists(staged_path)
    with open(staged_path, "r") as f:
        assert f.read() == "dummy flac data"

@pytest.mark.asyncio
@patch('download.get_arl')
@patch('asyncio.create_subprocess_exec')
async def test_download_track_aiff_success(mock_create_proc, mock_get_arl, temp_staging_dir):
    mock_get_arl.return_value = "dummy_arl_token_long_enough_to_pass_validation_check_1234567890_1234567890_1234567890_1234567890_1234567890_1234567890"
    
    staged_path = os.path.join(temp_staging_dir, "track2.aiff")
    proxy_path = os.path.join(temp_staging_dir, "track2.proxy.mp3")
    
    for path in [staged_path, proxy_path]:
        if os.path.exists(path):
            os.remove(path)
            
    mock_proc = AsyncMock()
    mock_proc.returncode = 0
    mock_proc.communicate.return_value = (b"", b"")
    mock_create_proc.return_value = mock_proc
    
    def side_effect(*args, **kwargs):
        cmd = args
        if "-p" in cmd:
            p_index = cmd.index("-p")
            temp_dest = cmd[p_index + 1]
            os.makedirs(temp_dest, exist_ok=True)
            dummy_file = os.path.join(temp_dest, "Artist - Track.flac")
            with open(dummy_file, "w") as f:
                f.write("dummy flac data")
        elif any("transcoded" in part for part in cmd):
            output_file = cmd[-1]
            with open(output_file, "w") as f:
                f.write("dummy transcoded data")
        elif any(part.endswith(".proxy.mp3") for part in cmd):
            output_file = cmd[-1]
            with open(output_file, "w") as f:
                f.write("dummy proxy data")
        return mock_proc

    mock_create_proc.side_effect = side_effect
    
    result = await download_track(12345, "aiff", staged_path)
    
    assert result == {
        "staged_path": staged_path,
        "proxy_path": proxy_path
    }
    assert os.path.exists(staged_path)
    assert os.path.exists(proxy_path)
    
    with open(staged_path, "r") as f:
        assert f.read() == "dummy transcoded data"
    with open(proxy_path, "r") as f:
        assert f.read() == "dummy proxy data"

@pytest.mark.asyncio
@patch('download.get_arl')
async def test_download_track_missing_arl(mock_get_arl):
    mock_get_arl.return_value = None
    with pytest.raises(ValueError, match="missing_arl"):
        await download_track(12345, "flac", "some_path.flac")
