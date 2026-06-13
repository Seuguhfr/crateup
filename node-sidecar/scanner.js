const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function log(msg) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${now}] [SCANNER] ${msg}`);
}

function scanDir(dir, rootPath, filesList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith('.') || name === 'crateup-staging') {
      continue; // Skip hidden files/directories and the staging directory
    }
    const fullPath = path.join(dir, name);
    if (entry.isDirectory()) {
      scanDir(fullPath, rootPath, filesList);
    } else if (entry.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (['.mp3', '.flac', '.aiff', '.wav', '.m4a'].includes(ext)) {
        let relPath = path.relative(rootPath, fullPath);
        // Normalize slashes to forward slashes for cross-platform consistency
        relPath = relPath.split(path.sep).join('/');
        if (!relPath.startsWith('/')) {
          relPath = '/' + relPath;
        }
        filesList.push(relPath);
      }
    }
  }
  return filesList;
}

function getBitrate(filePath) {
  try {
    const child_process = require('child_process');
    const stdout = child_process.execSync(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`,
      { encoding: 'utf8' }
    );
    const data = JSON.parse(stdout);
    const streams = data.streams || [];
    const format = data.format || {};
    const raw = 
      streams.find(s => s.codec_type === 'audio')?.bit_rate
      ?? format.bit_rate
      ?? null;
    if (raw) {
      return Math.round(parseInt(raw, 10) / 1000);
    }
  } catch (err) {
    // Ignore error silently
  }
  return null;
}

function initLedger(rootPath, outputFormat = 'flac', fileList = null) {
  if (!fs.existsSync(rootPath)) {
    fs.mkdirSync(rootPath, { recursive: true });
  }
  const isProdDir = fs.existsSync(path.join(__dirname, '../../Resources/binaries')) || fs.existsSync(path.join(path.dirname(process.execPath), '../Resources/binaries'));
  const isTestMode = process.env.NODE_ENV === 'test';
  const ledgerFilename = (isProdDir || isTestMode) ? '.crateup-progress.json' : '.crateup-progress-dev.json';
  const ledgerPath = path.join(rootPath, ledgerFilename);
  let ledger = {
    session_id: crypto.randomUUID(),
    root_path: rootPath,
    output_format: outputFormat,
    files: {}
  };

  if (fs.existsSync(ledgerPath)) {
    log(`Found existing ledger at ${ledgerPath}`);
    try {
      const content = fs.readFileSync(ledgerPath, 'utf8');
      const existingLedger = JSON.parse(content);
      ledger.session_id = existingLedger.session_id || ledger.session_id;
      ledger.root_path = existingLedger.root_path || ledger.root_path;
      ledger.output_format = existingLedger.output_format || ledger.output_format;
      ledger.files = existingLedger.files || {};
      for (const relPath in ledger.files) {
        const fileEntry = ledger.files[relPath];
        if (fileEntry.status === 'fingerprinting' || fileEntry.status === 'downloading') {
          fileEntry.status = 'pending';
        }
      }
    } catch (e) {
      log(`Error parsing existing ledger: ${e.message}. Reinitializing.`);
    }
  } else {
    log(`No existing ledger found. Initializing new ledger at ${ledgerPath}`);
  }

  // Scan files on disk or use explicit fileList
  let filesToProcess = [];
  const absPathsMap = new Map();
  if (fileList && Array.isArray(fileList)) {
    log(`Using explicit file list of ${fileList.length} files.`);
    for (const absPath of fileList) {
      // Convert to relative path
      let relPath = path.relative(rootPath, absPath);
      // Normalize slashes to forward slashes for cross-platform consistency
      relPath = relPath.split(path.sep).join('/');
      if (!relPath.startsWith('/')) {
        relPath = '/' + relPath;
      }
      filesToProcess.push(relPath);
      absPathsMap.set(relPath, absPath);
    }
  } else {
    filesToProcess = scanDir(rootPath, rootPath);
  }
  
  // Merge scanned files
  for (const relPath of filesToProcess) {
    const absPath = absPathsMap.get(relPath) || path.join(rootPath, relPath);
    if (!ledger.files[relPath]) {
      ledger.files[relPath] = {
        status: "pending",
        deezer_id: null,
        staged_path: null,
        proxy_path: null,
        original_bitrate: getBitrate(absPath)
      };
    } else if (ledger.files[relPath].original_bitrate === undefined) {
      ledger.files[relPath].original_bitrate = getBitrate(absPath);
    }

    if (absPathsMap.has(relPath)) {
      ledger.files[relPath].original_abs_path = absPathsMap.get(relPath);
    }
  }

  // Save the ledger
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
  log(`Ledger written to ${ledgerPath} with ${Object.keys(ledger.files).length} files.`);
  return ledger;
}

function scanFileList(filePaths, rootPath) {
  return initLedger(rootPath, 'flac', filePaths);
}

module.exports = {
  scanDir,
  initLedger,
  getBitrate,
  scanFileList
};
