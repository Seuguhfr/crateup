const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { resolveLedgerPath, saveLedger, LEDGER_VERSION } = require('./ledger');

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

function getFileDetails(filePath) {
  let bitrate = null;
  let deezerOrigin = false;
  try {
    const child_process = require('child_process');
    const stdout = child_process.execFileSync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const data = JSON.parse(stdout);
    const streams = data.streams || [];
    const format = data.format || {};
    
    const raw = 
      streams.find(s => s.codec_type === 'audio')?.bit_rate
      ?? format.bit_rate
      ?? null;
    if (raw) {
      bitrate = Math.round(parseInt(raw, 10) / 1000);
    }
    
    // Check tags
    const tags = format.tags || {};
    const normTags = {};
    for (const k of Object.keys(tags)) {
      normTags[k.toLowerCase()] = String(tags[k]).toLowerCase();
    }

    const hasBarcode = normTags['barcode'] !== undefined && normTags['barcode'] !== '';
    const hasIsrc = (normTags['tsrc'] !== undefined && normTags['tsrc'] !== '') || (normTags['isrc'] !== undefined && normTags['isrc'] !== '');
    deezerOrigin = hasBarcode && hasIsrc;
  } catch (err) {
    // Ignore error silently
  }
  return { bitrate, deezerOrigin };
}

function getBitrate(filePath) {
  return getFileDetails(filePath).bitrate;
}

function initLedger(rootPath, outputFormat = 'flac', fileList = null) {
  if (!fs.existsSync(rootPath)) {
    fs.mkdirSync(rootPath, { recursive: true });
  }
  const ledgerPath = resolveLedgerPath(rootPath);
  const KNOWN_TOP_LEVEL = new Set(['session_id', 'root_path', 'output_format', 'ledger_version', 'files']);
  let ledger = {
    session_id: crypto.randomUUID(),
    root_path: rootPath,
    output_format: outputFormat,
    ledger_version: LEDGER_VERSION,
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
      // Pre-version ledgers have no stamp; the current shape IS v1.
      ledger.ledger_version = existingLedger.ledger_version || LEDGER_VERSION;
      ledger.files = existingLedger.files || {};
      // Forward-compatible: keep unknown top-level fields (e.g. from newer
      // writers) instead of dropping them on the next save.
      for (const key of Object.keys(existingLedger)) {
        if (!KNOWN_TOP_LEVEL.has(key)) {
          ledger[key] = existingLedger[key];
        }
      }
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
    const details = getFileDetails(absPath);
    if (!ledger.files[relPath]) {
      ledger.files[relPath] = {
        status: "pending",
        deezer_id: null,
        staged_path: null,
        proxy_path: null,
        original_bitrate: details.bitrate,
        deezer_origin: details.deezerOrigin
      };
    } else {
      if (ledger.files[relPath].original_bitrate === undefined) {
        ledger.files[relPath].original_bitrate = details.bitrate;
      }
      if (ledger.files[relPath].deezer_origin === undefined) {
        ledger.files[relPath].deezer_origin = details.deezerOrigin;
      }
    }

    if (absPathsMap.has(relPath)) {
      ledger.files[relPath].original_abs_path = absPathsMap.get(relPath);
    }
  }

  // Save the ledger (write-through; also primes the read-through cache)
  saveLedger(rootPath, ledger);
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
  getFileDetails,
  scanFileList
};
