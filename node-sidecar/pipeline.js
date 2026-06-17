const fs = require('fs');
const path = require('path');
const os = require('os');

const resourcesPath = path.join(path.dirname(process.execPath), '../Resources');
process.env.PATH = `${resourcesPath}:${process.env.PATH}`;

function setupBinaries() {
  try {
    const arch = process.arch === 'x64' ? 'x86_64' : (process.arch === 'arm64' ? 'aarch64' : process.arch);
    let platformStr = '';
    if (process.platform === 'darwin') platformStr = 'apple-darwin';
    else if (process.platform === 'win32') platformStr = 'pc-windows-msvc';
    else if (process.platform === 'linux') platformStr = 'unknown-linux-gnu';

    const suffix = `-${arch}-${platformStr}`;
    const binDir = path.join(os.tmpdir(), 'crateup-bin');
    
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    const prodBinDir = path.join(resourcesPath, 'binaries');
    const devBinDir = path.join(__dirname, '..', 'src-tauri', 'binaries');
    
    let activeBinDir = fs.existsSync(prodBinDir) ? prodBinDir : devBinDir;

    const binaries = ['ffmpeg', 'ffprobe', 'fpcalc'];
    for (const bin of binaries) {
      const targetLinkPath = path.join(binDir, bin);
      const sourceFilePath = path.join(activeBinDir, `${bin}${suffix}`);
      
      if (!fs.existsSync(targetLinkPath)) {
        if (fs.existsSync(sourceFilePath)) {
          try {
            fs.symlinkSync(sourceFilePath, targetLinkPath);
            fs.chmodSync(targetLinkPath, 0o755);
            console.log(`[NODE] Created symlink: ${targetLinkPath} -> ${sourceFilePath}`);
          } catch (e) {
            try {
              fs.copyFileSync(sourceFilePath, targetLinkPath);
              fs.chmodSync(targetLinkPath, 0o755);
              console.log(`[NODE] Copied fallback: ${targetLinkPath} -> ${sourceFilePath}`);
            } catch (copyErr) {
              console.error(`[NODE] Failed to copy fallback for ${bin}: ${copyErr.message}`);
            }
          }
        } else {
          console.error(`[NODE] Source binary not found: ${sourceFilePath}`);
        }
      } else if (activeBinDir === prodBinDir) {
        try {
          fs.chmodSync(targetLinkPath, 0o755);
        } catch (e) {}
      }
    }

    process.env.PATH = `${binDir}:${process.env.PATH}`;
  } catch (err) {
    console.error(`[NODE] Error setting up binaries: ${err.message}`);
  }
}
setupBinaries();

const { initLedger, getBitrate } = require('./scanner');
const PythonBridge = require('./rpc');
const { compareAudioFiles } = require('./similarity');

function sanitizeFilenamePart(part) {
  if (!part) return '';
  // Strip characters illegal on macOS/Windows: / \ : * ? " < > |
  let clean = part.replace(/[\/\\:*?"<>|]/g, '');
  // Trim leading/trailing whitespace and dots
  clean = clean.trim().replace(/^\.+|\.+$/g, '').trim();
  return clean;
}

function log(msg) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${now}] [PIPELINE] ${msg}`);
}

function getLocalDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLogTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function writeSessionLog(rootPath, action, message) {
  try {
    const dateStr = getLocalDateString();
    const logPath = path.join(rootPath, `.crateup-log-${dateStr}.txt`);
    const timestamp = getLogTimestamp();
    const actionTag = `[${action}]`.padEnd(17, ' ');
    const line = `[${timestamp}] ${actionTag}${message}\n`;
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (err) {
    console.error(`Failed to write to session log: ${err.message}`);
  }
}

class ThrottleQueue {
  constructor() {
    this.lastCallTime = 0;
  }

  async throttle() {
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    // 3-7 seconds uniform random delay (3000ms - 7000ms)
    const delay = process.env.NODE_ENV === 'test' ? 0 : Math.floor(Math.random() * 4001) + 3000;
    if (elapsed < delay) {
      const wait = delay - elapsed;
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    this.lastCallTime = Date.now();
  }
}

function saveLedger(rootPath, ledger) {
  const isProdDir = fs.existsSync(path.join(__dirname, '../../Resources/binaries')) || fs.existsSync(path.join(path.dirname(process.execPath), '../Resources/binaries'));
  const isTestMode = process.env.NODE_ENV === 'test';
  const ledgerFilename = (isProdDir || isTestMode) ? '.crateup-progress.json' : '.crateup-progress-dev.json';
  const ledgerPath = path.join(rootPath, ledgerFilename);
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
}

async function runPipeline(rootPath, outputFormat, fileList = null) {
  log(`Starting pipeline for root: ${rootPath}, format: ${outputFormat}`);
  
  // 1. Scan directory and initialize/load ledger
  const ledger = initLedger(rootPath, outputFormat, fileList);
  
  // 2. Start Python bridge
  const bridge = new PythonBridge();
  bridge.start();
  
  const shazamThrottle = new ThrottleQueue();
  const deezerThrottle = new ThrottleQueue();
  
  try {
    const files = Object.keys(ledger.files);
    const pendingFiles = files.filter(f => ledger.files[f].status === 'pending');
    
    log(`Found ${pendingFiles.length} pending files out of ${files.length} total files.`);
    
    // Calculate similarity for any previously downloaded files that are missing similarity info
    const downloadedFiles = files.filter(f => ledger.files[f].status === 'downloaded' && ledger.files[f].similarity_score === undefined);
    if (downloadedFiles.length > 0) {
      log(`Found ${downloadedFiles.length} downloaded tracks missing similarity data. Calculating...`);
      for (const relPath of downloadedFiles) {
        const absPath = path.join(rootPath, relPath);
        const finalAbsoluteStaged = ledger.files[relPath].staged_path;
        const stagedAbsPath = path.resolve(rootPath, finalAbsoluteStaged);
        try {
          const compResult = compareAudioFiles(absPath, stagedAbsPath);
          ledger.files[relPath].audio_bit_identical = compResult.bitIdentical;
          ledger.files[relPath].similarity_score = compResult.similarity;
          log(`Previously downloaded similarity: ${(compResult.similarity * 100).toFixed(1)}% (Bit-Identical: ${compResult.bitIdentical})`);
        } catch (simErr) {
          log(`Failed previously downloaded similarity check: ${simErr.message}`);
          ledger.files[relPath].audio_bit_identical = false;
          ledger.files[relPath].similarity_score = 0.0;
        }
      }
      saveLedger(rootPath, ledger);
    }
    
    for (const relPath of pendingFiles) {
      const absPath = path.join(rootPath, relPath);
      log(`Processing: ${relPath}`);
      
      // Step A: Fingerprint (Shazam)
      let fingerprintResult;
      try {
        await shazamThrottle.throttle();
        fingerprintResult = await bridge.call('fingerprint', { path: absPath });
      } catch (err) {
        log(`Fingerprinting failed for ${relPath}: ${err.message}`);
        writeSessionLog(rootPath, 'UNIDENTIFIED', relPath);
        ledger.files[relPath].status = 'unidentified';
        saveLedger(rootPath, ledger);
        continue;
      }
      
      const { deezer_id: deezerId, title, artist } = fingerprintResult;
      
      const matchedArtist = ledger.files[relPath].artist || artist;
      const matchedTitle = ledger.files[relPath].title || title;
      ledger.files[relPath].artist = matchedArtist || null;
      ledger.files[relPath].title = matchedTitle || null;
      
      // Step B: Check Deezer ID
      if (!deezerId) {
        log(`Track identified but not found on Deezer: "${matchedArtist} - ${matchedTitle}"`);
        writeSessionLog(rootPath, 'NOT ON DEEZER', `${matchedArtist} - ${matchedTitle}`);
        ledger.files[relPath].status = 'not_on_deezer';
        saveLedger(rootPath, ledger);
        continue;
      }
      
      log(`Track identified on Deezer: "${matchedArtist} - ${matchedTitle}" (ID: ${deezerId})`);
      
      // Step C: Download (Deezer)
      // Derive staged path relative and absolute
      const ext = path.extname(relPath);
      const relativeBase = relPath.startsWith('/') ? relPath.substring(1) : relPath;
      const relativeStaged = 'crateup-staging/' + relativeBase.replace(ext, '.' + outputFormat);
      const stagedAbsPath = path.join(rootPath, relativeStaged);
      
      let downloadResult;
      try {
        await deezerThrottle.throttle();
        downloadResult = await bridge.call('download', {
          deezer_id: deezerId,
          output_format: outputFormat,
          staged_path: stagedAbsPath
        });
      } catch (err) {
        log(`Download failed for ${relPath}: ${err.message}. Retrying in 10 seconds...`);
        await new Promise(resolve => setTimeout(resolve, process.env.NODE_ENV === 'test' ? 0 : 10000));
        
        try {
          await deezerThrottle.throttle();
          downloadResult = await bridge.call('download', {
            deezer_id: deezerId,
            output_format: outputFormat,
            staged_path: stagedAbsPath
          });
        } catch (retryErr) {
          log(`Retry download failed for ${relPath}: ${retryErr.message}. Marking as download_failed.`);
          ledger.files[relPath].status = 'download_failed';
          saveLedger(rootPath, ledger);
          continue;
        }
      }
      
      // Step D: Successful download update
      let combined = '';
      const hasArtist = matchedArtist && matchedArtist !== 'Unknown Artist';
      const hasTitle = matchedTitle && matchedTitle !== 'Unknown Title';

      if (hasArtist || hasTitle) {
        const cleanArtist = sanitizeFilenamePart(matchedArtist || 'Unknown Artist');
        const cleanTitle = sanitizeFilenamePart(matchedTitle || 'Unknown Title');
        combined = `${cleanArtist} - ${cleanTitle}`;
      } else {
        combined = path.basename(relPath, path.extname(relPath));
      }

      if (combined.length > 150) {
        combined = combined.substring(0, 150);
      }
      combined = combined.trim().replace(/^\.+|\.+$/g, '').trim();
      if (!combined) {
        combined = path.basename(relPath, path.extname(relPath));
      }
      const finalFilename = `${combined}.${outputFormat}`;
      
      const stagedDir = path.dirname(stagedAbsPath);
      const finalAbsPath = path.join(stagedDir, finalFilename);
      
      try {
        fs.renameSync(stagedAbsPath, finalAbsPath);
      } catch (renameErr) {
        log(`Failed to rename staged file: ${renameErr.message}`);
      }
      
      const finalAbsoluteStaged = (fs.existsSync(finalAbsPath) ? finalAbsPath : stagedAbsPath).split(path.sep).join('/');

      ledger.files[relPath].status = 'downloaded';
      ledger.files[relPath].deezer_id = deezerId;
      ledger.files[relPath].staged_path = finalAbsoluteStaged;
      ledger.files[relPath].staged_bitrate = getBitrate(fs.existsSync(finalAbsPath) ? finalAbsPath : stagedAbsPath);
      
      if (downloadResult.proxy_path) {
        const absoluteProxy = downloadResult.proxy_path.split(path.sep).join('/');
        ledger.files[relPath].proxy_path = absoluteProxy;
      } else {
        ledger.files[relPath].proxy_path = null;
      }
      
      // Calculate audio similarity
      try {
        const compareTarget = fs.existsSync(finalAbsPath) ? finalAbsPath : stagedAbsPath;
        log(`Calculating similarity between original and replacement for ${relPath}...`);
        const compResult = compareAudioFiles(absPath, compareTarget);
        ledger.files[relPath].audio_bit_identical = compResult.bitIdentical;
        ledger.files[relPath].similarity_score = compResult.similarity;
        log(`Similarity: ${(compResult.similarity * 100).toFixed(1)}% (Bit-Identical: ${compResult.bitIdentical})`);
      } catch (simErr) {
        log(`Similarity check failed: ${simErr.message}`);
        ledger.files[relPath].audio_bit_identical = false;
        ledger.files[relPath].similarity_score = 0.0;
      }
      
      saveLedger(rootPath, ledger);
      writeSessionLog(rootPath, 'IDENTIFIED', `${matchedArtist} - ${matchedTitle}  →  Deezer ID ${deezerId}`);
      log(`Successfully staged replacement for ${relPath} -> ${finalAbsoluteStaged}`);
    }
    
    log("Pipeline run complete.");
  } finally {
    // 3. Stop Python bridge
    bridge.stop();
  }
  
  return ledger;
}

// Allow running from CLI directly
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    const readline = require('readline');
    const { parsePlaylists, getPlaylistTracks, getFolderTracks } = require('./rekordbox-parser');
    
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false
    });
    
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const request = JSON.parse(line);
        const { id, method, params } = request;
        
        if (method === 'parse_playlists') {
          const result = parsePlaylists(params.xml_path);
          console.log(JSON.stringify({ id, result }));
        } else if (method === 'get_playlist_tracks') {
          const result = getPlaylistTracks(params.xml_path, params.playlist_name);
          console.log(JSON.stringify({ id, result }));
        } else if (method === 'get_folder_tracks') {
          const result = getFolderTracks(params.xml_path, params.folder_name);
          console.log(JSON.stringify({ id, result }));
        } else {
          console.log(JSON.stringify({ id, error: `Unknown method: ${method}` }));
        }
      } catch (err) {
        console.log(JSON.stringify({ error: err.message }));
      }
    });
  } else if (args.length >= 2) {
    let fileList = null;
    if (args[2]) {
      try {
        fileList = JSON.parse(args[2]);
      } catch (err) {
        console.error("Failed to parse fileList argument:", err);
      }
    }
    runPipeline(args[0], args[1], fileList)
      .then(() => process.exit(0))
      .catch(err => {
        console.error("Pipeline run failed:", err);
        process.exit(1);
      });
  } else {
    console.error("Usage: node pipeline.js <rootPath> <outputFormat> [fileListJson]");
    process.exit(1);
  }
}

module.exports = {
  runPipeline
};
