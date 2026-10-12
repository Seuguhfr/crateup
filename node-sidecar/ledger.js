const fs = require('fs');
const path = require('path');

const PROD_LEDGER_FILENAME = '.crateup-progress.json';
const DEV_LEDGER_FILENAME = '.crateup-progress-dev.json';

/** Current progress-ledger schema version. Bump when the shape changes. */
const LEDGER_VERSION = 1;

/**
 * Whether the sidecar runs inside the packaged app (bundled Resources).
 * Dev (`npm run tauri dev`) uses a separate ledger filename so manual
 * testing never clobbers a production session, and vice versa.
 */
function isProdBuild() {
  return (
    fs.existsSync(path.join(__dirname, '../../Resources/binaries')) ||
    fs.existsSync(path.join(path.dirname(process.execPath), '../Resources/binaries'))
  );
}

/** Single source of truth for the progress-ledger filename. */
function resolveLedgerFilename() {
  if (process.env.NODE_ENV === 'test') return PROD_LEDGER_FILENAME;
  return isProdBuild() ? PROD_LEDGER_FILENAME : DEV_LEDGER_FILENAME;
}

/** Absolute ledger path for a library/session root. */
function resolveLedgerPath(rootPath) {
  return path.join(rootPath, resolveLedgerFilename());
}

// Read-through cache: absolute ledger path -> { mtimeMs, size, ledger }.
// The ledger is the crash-recovery record, so every mutation still goes
// straight to disk (write-through); the cache only saves re-reads and
// stays valid via mtime+size checks against outside writers
// (Rust `read_ledger_file` migration, manual edits).
const cache = new Map();

function statOf(ledgerPath) {
  try {
    const st = fs.statSync(ledgerPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    return null;
  }
}

/**
 * Load the ledger for a root, or null when no ledger file exists.
 * Returns the cached object when the file is unchanged on disk.
 * Throws on corrupt JSON (callers decide whether to recover).
 */
function loadLedger(rootPath) {
  const ledgerPath = resolveLedgerPath(rootPath);
  const st = statOf(ledgerPath);
  if (!st) {
    cache.delete(ledgerPath);
    return null;
  }
  const hit = cache.get(ledgerPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit.ledger;
  }
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  cache.set(ledgerPath, { mtimeMs: st.mtimeMs, size: st.size, ledger });
  return ledger;
}

/** Persist the ledger (write-through) and refresh the cache. */
function saveLedger(rootPath, ledger) {
  const ledgerPath = resolveLedgerPath(rootPath);
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
  const st = statOf(ledgerPath) || { mtimeMs: 0, size: 0 };
  cache.set(ledgerPath, { mtimeMs: st.mtimeMs, size: st.size, ledger });
  return ledgerPath;
}

/** Drop all cached entries (tests, session reset). */
function clearLedgerCache() {
  cache.clear();
}

module.exports = {
  PROD_LEDGER_FILENAME,
  DEV_LEDGER_FILENAME,
  LEDGER_VERSION,
  isProdBuild,
  resolveLedgerFilename,
  resolveLedgerPath,
  loadLedger,
  saveLedger,
  clearLedgerCache,
};
