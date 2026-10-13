const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');

require('./bin-setup');


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
      const res = child_process.spawnSync('ffmpeg', ['-i', filePath], { stdio: 'pipe' });
      const stderrStr = res.stderr ? res.stderr.toString() : (res.error?.stderr ? res.error.stderr.toString() : '');

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
    } catch {
      // Best-effort metadata extraction
    }
  }

  return result;
}

/**
 * Extract comments, genres, and rating from an existing audio file for merging (§5.1 SPEC.md)
 */
function getAudioTags(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    const stdout = child_process.execFileSync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const data = JSON.parse(stdout);
    const rawTags = (data && data.format && data.format.tags) || {};
    const norm = {};
    for (const [k, v] of Object.entries(rawTags)) {
      norm[k.toLowerCase()] = String(v);
    }
    return {
      comment: norm['comment'] || norm['description'] || norm['comments'] || null,
      genre: norm['genre'] || norm['genres'] || null,
      rating: norm['rating'] || norm['popm'] || norm['popularimeter'] || null
    };
  } catch (_) {
    return {};
  }
}

/**
 * Merge comments, genres, and rating from original track into the replacement track (§5.1 SPEC.md)
 */
function mergeOriginalTags(originalPath, targetPath) {
  if (!fs.existsSync(originalPath) || !fs.existsSync(targetPath)) return;
  const originalTags = getAudioTags(originalPath);
  const metadataArgs = [];

  if (originalTags.comment) {
    metadataArgs.push('-metadata', `comment=${originalTags.comment}`);
    metadataArgs.push('-metadata', `description=${originalTags.comment}`);
  }
  if (originalTags.genre) {
    metadataArgs.push('-metadata', `genre=${originalTags.genre}`);
  }
  if (originalTags.rating) {
    metadataArgs.push('-metadata', `rating=${originalTags.rating}`);
  }

  if (metadataArgs.length === 0) {
    return;
  }

  const tmpTagged = targetPath + '.tagmerge-' + process.pid + '-' + Date.now();
  try {
    const ext = path.extname(targetPath).toLowerCase();
    const args = ['-y', '-i', targetPath, '-c', 'copy'];
    if (ext === '.aiff' || ext === '.aif' || ext === '.wav') {
      args.push('-write_id3v2', '1');
    }
    args.push(...metadataArgs, tmpTagged);

    const res = child_process.spawnSync('ffmpeg', args, { stdio: 'pipe' });
    if (res.status === 0 && fs.existsSync(tmpTagged)) {
      fs.renameSync(tmpTagged, targetPath);
    } else {
      if (fs.existsSync(tmpTagged)) fs.unlinkSync(tmpTagged);
    }
  } catch (_) {
    if (fs.existsSync(tmpTagged)) {
      try { fs.unlinkSync(tmpTagged); } catch (_) {}
    }
  }
}

function getStagedAbsPath(entry, rootPath) {
  if (!entry || !entry.staged_path) return null;
  if (path.isAbsolute(entry.staged_path)) {
    if (fs.existsSync(entry.staged_path)) {
      return entry.staged_path;
    }
    const normalized = entry.staged_path.replace(/\\/g, '/');
    const idx = normalized.indexOf('crateup-staging/');
    if (idx !== -1) {
      const candidate = path.join(rootPath, normalized.slice(idx));
      if (fs.existsSync(candidate)) return candidate;
    }
    return entry.staged_path;
  }
  const normalized = entry.staged_path.replace(/\\/g, '/');
  if (normalized.startsWith('crateup-staging/') || normalized.startsWith('.crateup-staging/')) {
    return path.join(rootPath, entry.staged_path);
  }
  return path.join(rootPath, 'crateup-staging', entry.staged_path);
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

function safeTrashFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const home = os.homedir();
  const trashDir = path.join(home, '.Trash');

  // 1. Try atomic rename into ~/.Trash (succeeds on same filesystem)
  if (fs.existsSync(trashDir)) {
    try {
      const base = path.basename(filePath);
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      let trashTarget = path.join(trashDir, base);
      let counter = 1;
      while (fs.existsSync(trashTarget)) {
        trashTarget = path.join(trashDir, `${stem} (${counter})${ext}`);
        counter++;
      }
      fs.renameSync(filePath, trashTarget);
      return;
    } catch (e) {
      // Cross-device (EXDEV on external SSD/USB) or permission error - proceed to fallbacks below
    }
  }

  // 2. On macOS, ask Finder to move to Trash (handles volume-local .Trashes on external drives)
  if (process.platform === 'darwin') {
    try {
      const escaped = filePath.replace(/["\\]/g, '\\$&');
      child_process.execFileSync(
        '/usr/bin/osascript',
        ['-e', `tell application "Finder" to delete POSIX file "${escaped}"`],
        { stdio: 'ignore', timeout: 5000 }
      );
      if (!fs.existsSync(filePath)) return;
    } catch (_) {}
  }

  // 3. Cross-device fallback: copy into ~/.Trash, verify it exists, then unlink source
  if (fs.existsSync(trashDir)) {
    try {
      const base = path.basename(filePath);
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      let trashTarget = path.join(trashDir, base);
      let counter = 1;
      while (fs.existsSync(trashTarget)) {
        trashTarget = path.join(trashDir, `${stem} (${counter})${ext}`);
        counter++;
      }
      fs.copyFileSync(filePath, trashTarget);
      if (fs.existsSync(trashTarget) && fs.statSync(trashTarget).size === fs.statSync(filePath).size) {
        fs.unlinkSync(filePath);
        return;
      }
    } catch (_) {}
  }

  // 4. Last-resort fallback
  try {
    fs.unlinkSync(filePath);
  } catch (e) {}
}

function cleanProxyFile(entry, stagedAbsPath, rootPath) {
  const candidates = [];
  if (entry && entry.proxy_path) {
    candidates.push(path.isAbsolute(entry.proxy_path) ? entry.proxy_path : path.join(rootPath, entry.proxy_path));
  }
  if (stagedAbsPath) {
    const ext = path.extname(stagedAbsPath);
    candidates.push(stagedAbsPath.slice(0, -ext.length) + '.proxy.mp3');
    candidates.push(stagedAbsPath + '.proxy.mp3');
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (e) {}
    }
  }
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
      const originalAbsPath = (entry && entry.original_abs_path)
        ? entry.original_abs_path
        : path.join(rootPath, relPath.startsWith('/') ? relPath.substring(1) : relPath);
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

            // Clone to a temp file first, then swap into place.
            const tmpClonePath = path.join(
              path.dirname(targetAbsPath),
              `.crateup-tmp-${process.pid}-${Date.now()}`,
            );
            fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
            try {
              fs.copyFileSync(sourceCommittedPath, tmpClonePath);
              mergeOriginalTags(originalAbsPath, tmpClonePath);
            } catch (err) {
              if (fs.existsSync(tmpClonePath)) fs.unlinkSync(tmpClonePath);
              throw err;
            }
            // Atomically replace targetAbsPath
            fs.renameSync(tmpClonePath, targetAbsPath);
            if (strategy === 'replace' && originalAbsPath !== targetAbsPath && fs.existsSync(originalAbsPath)) {
              safeTrashFile(originalAbsPath);
            }

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

            // Copy to a temp file first, then swap into place.
            const tmpPath = path.join(
              path.dirname(targetAbsPath),
              `.crateup-tmp-${process.pid}-${Date.now()}`,
            );
            fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
            try {
              fs.copyFileSync(stagedAbsPath, tmpPath);
              mergeOriginalTags(originalAbsPath, tmpPath);
            } catch (err) {
              if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
              throw err;
            }
            // Atomically replace targetAbsPath
            fs.renameSync(tmpPath, targetAbsPath);
            if (strategy === 'replace' && originalAbsPath !== targetAbsPath && fs.existsSync(originalAbsPath)) {
              safeTrashFile(originalAbsPath);
            }

            // Delete the staged file from crateup-staging/ after copying
            if (fs.existsSync(stagedAbsPath)) {
              fs.unlinkSync(stagedAbsPath);
            }

            cleanProxyFile(entry, stagedAbsPath, rootPath);

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

    const originalAbsPath = (entry && entry.original_abs_path)
      ? entry.original_abs_path
      : path.join(rootPath, relPath.startsWith('/') ? relPath.substring(1) : relPath);
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
        cleanProxyFile(entry, stagedAbsPath, rootPath);
      }

      if (strategy !== 'replace') {
        const targetAbsPath = getUniquePath(
          strategy === 'consolidate' 
            ? path.join(outputPath, path.basename(relPath)) 
            : path.join(outputPath, relClean)
        );
        // Copy original file to output folder so output folder is a complete library
        if (!fs.existsSync(originalAbsPath)) {
          throw new Error(`Original file missing on disk: ${relPath}`);
        }
        fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
        fs.copyFileSync(originalAbsPath, targetAbsPath);
        entry.output_path = targetAbsPath;
        writeLog('SKIPPED', `${artistTitle}  →  original copied to output folder`);
      } else {
        if (!fs.existsSync(originalAbsPath)) {
          throw new Error(`Original file missing on disk: ${relPath}`);
        }
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

  // Phase C: Clean up staging folder in its entirety (only on successful commit)
  if (failures.length === 0) {
    const stagingAbsDir = path.join(rootPath, 'crateup-staging');
    if (fs.existsSync(stagingAbsDir)) {
      try {
        fs.rmSync(stagingAbsDir, { recursive: true, force: true });
      } catch (err) {
        failures.push({ relPath: 'crateup-staging', error: `Staging clean up failed: ${err.message}` });
      }
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
  getFileMetadata,
  getAudioTags,
  mergeOriginalTags
};
