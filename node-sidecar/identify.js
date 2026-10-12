const path = require('path');
const os = require('os');
const fs = require('fs');

require('./bin-setup');

const PythonBridge = require('./rpc');
const { loadLedger, saveLedger } = require('./ledger');

/**
 * Identifies a single audio file via the Python bridge fingerprinting method.
 * @param {string} rootPath - The root directory of the library/session.
 * @param {string} relPath - The relative path of the track from rootPath.
 */
async function identifyTrack(rootPath, relPath) {
  const bridge = new PythonBridge();
  bridge.start();

  try {
    const absPath = path.join(rootPath, relPath);
    const result = await bridge.call('fingerprint', { path: absPath });

    // Update ledger on disk if identified
    if (result && (result.artist || result.title)) {
      try {
        const ledger = loadLedger(rootPath);
        if (ledger && ledger.files && ledger.files[relPath]) {
          ledger.files[relPath].artist = result.artist || null;
          ledger.files[relPath].title = result.title || null;
          if (result.deezer_id) {
            ledger.files[relPath].deezer_id = result.deezer_id;
          } else {
            ledger.files[relPath].status = 'not_on_deezer';
          }
          saveLedger(rootPath, ledger);
        }
      } catch (ledgerErr) {
        console.error(`[NODE] Failed to update ledger in identify.js: ${ledgerErr.message}`);
      }
    }

    return result;
  } finally {
    bridge.stop();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const [rootPath, relPath] = args;
  identifyTrack(rootPath, relPath)
    .then(result => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch(err => {
      console.error(err.message || err);
      process.exit(1);
    });
}

module.exports = {
  identifyTrack
};
