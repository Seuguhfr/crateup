const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');

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


/**
 * Helper to format local date as YYYY-MM-DD
 */
function getLocalDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Helper to format timestamp as YYYY-MM-DD HH:MM:SS
 */
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

/**
 * Helper to format log lines with standard padding
 */
function formatLogLine(action, message) {
  const timestamp = getLogTimestamp();
  const actionTag = `[${action}]`.padEnd(17, ' ');
  return `[${timestamp}] ${actionTag}${message}\n`;
}

/**
 * Helper to extract title, artist, and duration from an audio file.
 * Falls back to parsing the filename if ffmpeg metadata extraction fails.
 */
function getFileMetadata(filePath) {
  const result = {
    name: '',
    artist: '',
    duration: 0
  };

  // Try parsing from filename first (fallback)
  const baseName = path.basename(filePath, path.extname(filePath));
  const parts = baseName.split(' - ');
  if (parts.length >= 2) {
    result.artist = parts[0].trim();
    result.name = parts.slice(1).join(' - ').trim();
  } else {
    result.name = baseName.trim();
  }

  // Now try running ffmpeg to extract metadata tags and duration
  if (fs.existsSync(filePath)) {
    try {
      // Run ffmpeg -i and capture stderr since information is printed to stderr
      child_process.execSync(`ffmpeg -i "${filePath}"`, { stdio: 'pipe' });
    } catch (err) {
      const stderrStr = err.stderr ? err.stderr.toString() : '';

      // Parse duration
      const durMatch = stderrStr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+|\d+)/);
      if (durMatch) {
        const hours = parseInt(durMatch[1], 10);
        const minutes = parseInt(durMatch[2], 10);
        const seconds = parseFloat(durMatch[3]);
        result.duration = hours * 3600 + minutes * 60 + seconds;
      }

      // Parse title
      const titleMatch = stderrStr.match(/title\s*:\s*(.+)/i);
      if (titleMatch) {
        result.name = titleMatch[1].trim();
      }

      // Parse artist
      const artistMatch = stderrStr.match(/artist\s*:\s*(.+)/i);
      if (artistMatch) {
        result.artist = artistMatch[1].trim();
      }
    }
  }

  return result;
}

function getStagedAbsPath(entry, rootPath) {
  if (!entry || !entry.staged_path) return null;
  if (path.isAbsolute(entry.staged_path)) {
    return entry.staged_path;
  }
  return path.join(rootPath, 'crateup-staging', path.basename(entry.staged_path));
}

/**
 * Search all ledger entries for a track that matches the same Deezer ID
 * and check if its staged file actually exists on disk.
 */
function findStagedFileOnDisk(deezerId, rootPath, files) {
  for (const relPath in files) {
    const entry = files[relPath];
    if (entry.deezer_id === deezerId && entry.staged_path) {
      const stagedAbsPath = getStagedAbsPath(entry, rootPath);
      if (stagedAbsPath && fs.existsSync(stagedAbsPath)) {
        return stagedAbsPath;
      }
    }
  }
  return null;
}

/**
 * Helper to ensure a file path is unique by appending suffix index if it exists
 */
function getUniquePath(targetPath) {
  let attempt = 0;
  let ext = path.extname(targetPath);
  let base = path.join(path.dirname(targetPath), path.basename(targetPath, ext));
  let finalPath = targetPath;
  while (fs.existsSync(finalPath)) {
    attempt++;
    finalPath = `${base} (${attempt})${ext}`;
  }
  return finalPath;
}

/**
 * Commit Phase Orchestration
 * @param {string} ledgerPath - Path to .crateup-progress.json
 * @param {Map<string, string>} decisions - Map of relativePath -> 'approved' | 'skipped'
 * @param {string} outputPath - Path to copy files into (optional if replace strategy chosen)
 * @param {string} outputStrategy - 'replace' | 'consolidate' | 'custom'
 * @param {boolean} keepLedger - Whether to keep the ledger/log files on success
 */
async function commit(ledgerPath, decisions, outputPath, outputStrategy, keepLedger) {
  if (!fs.existsSync(ledgerPath)) {
    throw new Error(`Ledger file not found at ${ledgerPath}`);
  }
  
  const strategy = outputStrategy || 'custom';
  if (strategy !== 'replace' && !outputPath) {
    throw new Error(`Output folder path must be specified`);
  }

  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  const rootPath = ledger.root_path;
  const outputFormat = ledger.output_format;
  const files = ledger.files;

  const committedPaths = new Map(); // deezer_id -> targetAbsPath in output folder
  const failures = [];

  const dateStr = getLocalDateString();
  const logPath = path.join(rootPath, `.crateup-log-${dateStr}.txt`);

  function writeLog(action, message) {
    try {
      const line = formatLogLine(action, message);
      fs.appendFileSync(logPath, line);
    } catch (err) {
      console.error(`Failed to write to session log: ${err.message}`);
    }
  }

  // Ensure output directory exists if not replacing in-place
  if (strategy !== 'replace') {
    try {
      fs.mkdirSync(outputPath, { recursive: true });
    } catch (err) {
      throw new Error(`Failed to create output folder: ${err.message}`);
    }
  }

  const relPaths = Object.keys(files);

  // Phase A: Process all approved upgrades
  for (const relPath of relPaths) {
    const entry = files[relPath];
    const decision = decisions.get(relPath);

    if (decision === 'approved') {
      const originalAbsPath = path.join(rootPath, relPath);
      const relClean = relPath.replace(/^\/+/, '');
      
      let targetBasename = path.basename(relPath);
      if (entry.status === 'downloaded' && entry.staged_path) {
        targetBasename = path.basename(entry.staged_path);
      } else {
        const hasArtist = entry.artist && entry.artist !== 'Unknown Artist';
        const hasTitle = entry.title && entry.title !== 'Unknown Title';
        if (hasArtist || hasTitle) {
          const cleanArtist = entry.artist.replace(/[\/\\:*?"<>|]/g, '').trim();
          const cleanTitle = entry.title.replace(/[\/\\:*?"<>|]/g, '').trim();
          targetBasename = `${cleanArtist} - ${cleanTitle}${path.extname(relPath)}`;
        }
      }

      let targetAbsPath;
      if (strategy === 'replace') {
        const ext = path.extname(relPath);
        const newExt = (entry.status === 'downloaded' && entry.staged_path) 
          ? path.extname(entry.staged_path) 
          : ext;
        const parentDir = path.dirname(originalAbsPath);
        targetAbsPath = path.join(parentDir, path.basename(relPath, ext) + newExt);
      } else if (strategy === 'consolidate') {
        targetAbsPath = getUniquePath(path.join(outputPath, targetBasename));
      } else {
        // custom
        targetAbsPath = getUniquePath(path.join(outputPath, path.dirname(relClean), targetBasename));
      }

      const newRelPath = (strategy !== 'replace') 
        ? path.relative(outputPath, targetAbsPath).split(path.sep).join('/') 
        : path.basename(targetAbsPath);

      // Extract metadata before file operations
      const meta = getFileMetadata(originalAbsPath);
      const artistTitle = `${meta.artist || 'Unknown Artist'} - ${meta.name || 'Unknown Title'}`;

      try {
        if (entry.status === 'downloaded') {
          const deezerId = entry.deezer_id;

          if (deezerId && committedPaths.has(deezerId)) {
            // Duplicate / clone handling
            const sourceCommittedPath = committedPaths.get(deezerId);
            
            if (strategy === 'replace') {
              if (fs.existsSync(originalAbsPath)) {
                fs.unlinkSync(originalAbsPath);
              }
            }
            fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
            fs.copyFileSync(sourceCommittedPath, targetAbsPath);

            writeLog('DUPLICATE', `${artistTitle}  →  cloned from committed copy`);
            entry.status = 'committed';
            entry.output_path = targetAbsPath;
          } else {
            // Standard copy handling
            let stagedAbsPath = getStagedAbsPath(entry, rootPath);

            if (!stagedAbsPath || !fs.existsSync(stagedAbsPath)) {
              stagedAbsPath = findStagedFileOnDisk(deezerId, rootPath, files);
            }

            if (!stagedAbsPath || !fs.existsSync(stagedAbsPath)) {
              throw new Error(`Staged file not found for Deezer ID ${deezerId}`);
            }

            if (strategy === 'replace') {
              if (fs.existsSync(originalAbsPath)) {
                fs.unlinkSync(originalAbsPath);
              }
            }
            fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
            fs.copyFileSync(stagedAbsPath, targetAbsPath);

            // Delete the staged file from crateup-staging/ after copying
            if (fs.existsSync(stagedAbsPath)) {
              fs.unlinkSync(stagedAbsPath);
            }

            if (outputFormat.toLowerCase() === 'aiff') {
              const proxyStagedPath = stagedAbsPath + '.proxy.mp3';
              if (fs.existsSync(proxyStagedPath)) {
                fs.unlinkSync(proxyStagedPath);
              }
            }

            if (deezerId) {
              committedPaths.set(deezerId, targetAbsPath);
            }

            writeLog('COMMITTED', `${artistTitle}  →  ${newRelPath}`);
            entry.status = 'committed';
            entry.output_path = targetAbsPath;
          }
        } else {
          // Unresolved/failed track but approved to copy original and write metadata tags
          const hasShazamMeta = entry.artist && entry.title;
          if (strategy === 'replace') {
            if (hasShazamMeta) {
              const tempTarget = originalAbsPath + '.temp-tagged';
              const spawnResult = child_process.spawnSync('ffmpeg', [
                '-y',
                '-i', originalAbsPath,
                '-metadata', `artist=${entry.artist}`,
                '-metadata', `title=${entry.title}`,
                '-codec', 'copy',
                tempTarget
              ]);

              if (spawnResult.status === 0) {
                fs.unlinkSync(originalAbsPath);
                fs.renameSync(tempTarget, originalAbsPath);
                writeLog('COMMITTED_TAGGED', `${artistTitle}  →  (tagged in-place)`);
              } else {
                if (fs.existsSync(tempTarget)) fs.unlinkSync(tempTarget);
                writeLog('COMMITTED_WARN', `${artistTitle}  →  (kept original due to tag error)`);
              }
            } else {
              writeLog('COMMITTED', `${artistTitle}  →  (kept original unchanged)`);
            }
            entry.status = 'committed';
            entry.output_path = originalAbsPath;
          } else {
            // Output to separate folder
            fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });

            if (hasShazamMeta) {
              // Copy original file and write metadata tags using ffmpeg
              const spawnResult = child_process.spawnSync('ffmpeg', [
                '-y',
                '-i', originalAbsPath,
                '-metadata', `artist=${entry.artist}`,
                '-metadata', `title=${entry.title}`,
                '-codec', 'copy',
                targetAbsPath
              ]);

              if (spawnResult.status !== 0) {
                fs.copyFileSync(originalAbsPath, targetAbsPath);
                writeLog('COMMITTED_WARN', `${artistTitle}  →  ${newRelPath} (copied without tags due to ffmpeg error)`);
              } else {
                writeLog('COMMITTED_TAGGED', `${artistTitle}  →  ${newRelPath} (original copied & metadata tagged)`);
              }
            } else {
              fs.copyFileSync(originalAbsPath, targetAbsPath);
              writeLog('COMMITTED', `${artistTitle}  →  ${newRelPath} (copied original without changes)`);
            }

            entry.status = 'committed';
            entry.output_path = targetAbsPath;
          }
        }
      } catch (err) {
        failures.push({ relPath, error: err.message });
      }
    }
  }

  // Phase B: Process skipped/unresolved upgrades
  for (const relPath of relPaths) {
    const entry = files[relPath];
    const decision = decisions.get(relPath);

    if (decision === 'approved') continue;

    const originalAbsPath = path.join(rootPath, relPath);
    const relClean = relPath.replace(/^\/+/, '');
    const meta = getFileMetadata(originalAbsPath);
    const artistTitle = `${meta.artist || 'Unknown Artist'} - ${meta.name || 'Unknown Title'}`;

    try {
      // Delete staging file if it was downloaded but skipped
      if (entry.status === 'downloaded' && entry.staged_path) {
        const stagedAbsPath = getStagedAbsPath(entry, rootPath);
        if (stagedAbsPath && fs.existsSync(stagedAbsPath)) {
          fs.unlinkSync(stagedAbsPath);
        }
        if (outputFormat.toLowerCase() === 'aiff' && stagedAbsPath) {
          const proxyStagedPath = stagedAbsPath + '.proxy.mp3';
          if (fs.existsSync(proxyStagedPath)) {
            fs.unlinkSync(proxyStagedPath);
          }
        }
      }

      if (strategy !== 'replace') {
        const targetAbsPath = getUniquePath(
          strategy === 'consolidate' 
            ? path.join(outputPath, path.basename(relPath)) 
            : path.join(outputPath, relClean)
        );
        // Copy original file to output folder so output folder is a complete library
        if (fs.existsSync(originalAbsPath)) {
          fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
          fs.copyFileSync(originalAbsPath, targetAbsPath);
        }
        entry.output_path = targetAbsPath;
        writeLog('SKIPPED', `${artistTitle}  →  original copied to output folder`);
      } else {
        entry.output_path = originalAbsPath;
        writeLog('SKIPPED', `${artistTitle}  →  retained original in-place`);
      }

      entry.status = 'skipped';
    } catch (err) {
      failures.push({ relPath, error: err.message });
    }
  }

  // Save the modified ledger back to disk
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

  // Phase C: Clean up staging folder in its entirety
  const stagingAbsDir = path.join(rootPath, 'crateup-staging');
  if (fs.existsSync(stagingAbsDir)) {
    try {
      fs.rmSync(stagingAbsDir, { recursive: true, force: true });
    } catch (err) {
      failures.push({ relPath: 'crateup-staging', error: `Staging clean up failed: ${err.message}` });
    }
  }

  // If successful commit (i.e. no failures), clean up ledger and log files (unless keepLedger is requested)
  // Note: ledger file deletion is deferred to the frontend's reset_session call on finish/close if keepLedger is true.
  if (failures.length === 0 && !keepLedger) {
    if (fs.existsSync(ledgerPath)) {
      try {
        fs.unlinkSync(ledgerPath);
      } catch (e) {
        // ignore
      }
    }

    try {
      if (fs.existsSync(rootPath)) {
        const filesInRoot = fs.readdirSync(rootPath);
        for (const file of filesInRoot) {
          if (file.startsWith('.crateup-log')) {
            const filePath = path.join(rootPath, file);
            try {
              if (fs.statSync(filePath).isFile()) {
                fs.unlinkSync(filePath);
              }
            } catch (e) {
              // ignore
            }
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return {
    success: failures.length === 0,
    failures
  };
}

module.exports = {
  commit,
  getFileMetadata
};
