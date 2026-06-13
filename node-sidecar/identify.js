const path = require('path');
const os = require('os');
const fs = require('fs');

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

    const binaries = ['ffmpeg', 'ffprobe'];
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

const PythonBridge = require('./rpc');

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
      const isProdDir = fs.existsSync(path.join(__dirname, '../../Resources/binaries')) || fs.existsSync(path.join(path.dirname(process.execPath), '../Resources/binaries'));
      const isTestMode = process.env.NODE_ENV === 'test';
      const ledgerFilename = (isProdDir || isTestMode) ? '.crateup-progress.json' : '.crateup-progress-dev.json';
      const ledgerPath = path.join(rootPath, ledgerFilename);
      if (fs.existsSync(ledgerPath)) {
        try {
          const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
          if (ledger.files && ledger.files[relPath]) {
            ledger.files[relPath].artist = result.artist || null;
            ledger.files[relPath].title = result.title || null;
            if (result.deezer_id) {
              ledger.files[relPath].deezer_id = result.deezer_id;
            } else {
              ledger.files[relPath].status = 'not_on_deezer';
            }
            fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
          }
        } catch (ledgerErr) {
          console.error(`[NODE] Failed to update ledger in identify.js: ${ledgerErr.message}`);
        }
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
