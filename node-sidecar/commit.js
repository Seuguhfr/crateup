const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

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
 * Commit Phase Orchestration
 * @param {string} ledgerPath - Path to .crateup-progress.json
 * @param {Map<string, string>} decisions - Map of relativePath -> 'approved' | 'skipped'
 * @param {string} outputPath - Path to copy files into
 */
async function commit(ledgerPath, decisions, outputPath) {
  if (!fs.existsSync(ledgerPath)) {
    throw new Error(`Ledger file not found at ${ledgerPath}`);
  }
  if (!outputPath) {
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

  // Ensure output directory exists
  try {
    fs.mkdirSync(outputPath, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create output folder: ${err.message}`);
  }

  const relPaths = Object.keys(files);

  // Phase A: Process all approved upgrades
  for (const relPath of relPaths) {
    const entry = files[relPath];
    const decision = decisions.get(relPath);

    if (decision === 'approved' && entry.status === 'downloaded') {
      const originalAbsPath = path.join(rootPath, relPath);
      const relClean = relPath.replace(/^\/+/, '');
      const targetAbsPath = path.join(
        outputPath,
        path.dirname(relClean),
        path.basename(entry.staged_path)
      );
      const newRelPath = path.relative(outputPath, targetAbsPath).split(path.sep).join('/');

      // Extract metadata before file operations
      const meta = getFileMetadata(originalAbsPath);
      const artistTitle = `${meta.artist || 'Unknown Artist'} - ${meta.name || 'Unknown Title'}`;

      try {
        const deezerId = entry.deezer_id;

        if (deezerId && committedPaths.has(deezerId)) {
          // Duplicate / clone handling
          const sourceCommittedPath = committedPaths.get(deezerId);
          
          fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
          fs.copyFileSync(sourceCommittedPath, targetAbsPath);

          writeLog('DUPLICATE', `${artistTitle}  →  cloned from committed copy in output folder`);
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

          // Leave original file untouched, just copy staged file to output folder
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

          writeLog('COMMITTED', `${artistTitle}  →  ${newRelPath} (copied to output folder)`);
          entry.status = 'committed';
          entry.output_path = targetAbsPath;
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

    if (decision === 'skipped' || entry.status === 'unidentified' || entry.status === 'not_on_deezer') {
      const originalAbsPath = path.join(rootPath, relPath);
      const relClean = relPath.replace(/^\/+/, '');
      const targetAbsPath = path.join(outputPath, relClean);
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

        // Copy original file to output folder so output folder is a complete library
        if (fs.existsSync(originalAbsPath)) {
          fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
          fs.copyFileSync(originalAbsPath, targetAbsPath);
        }

        entry.status = 'skipped';
        entry.output_path = targetAbsPath;
        writeLog('SKIPPED', `${artistTitle}  →  original copied to output folder`);
      } catch (err) {
        failures.push({ relPath, error: err.message });
      }
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

  // If successful commit (i.e. no failures), clean up ledger and log files
  if (failures.length === 0) {
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
  getFileMetadata // exported for reuse in tests or other modules
};
