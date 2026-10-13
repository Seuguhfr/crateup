// Shared binary bootstrap for every sidecar entry point.
//
// Symlinks the bundled ffmpeg/ffprobe/fpcalc into os.tmpdir()/crateup-bin
// and prepends it to PATH so child processes (Python, ffprobe, fpcalc)
// resolve them both in dev (repo binaries) and in the Tauri bundle
// (Resources/binaries). Runs on require — same behavior as the block this
// replaces in each entry point.
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
      let isBroken = false;
      try {
        const lstat = fs.lstatSync(targetLinkPath);
        if (lstat.isSymbolicLink() && !fs.existsSync(targetLinkPath)) {
          isBroken = true;
        }
      } catch (_) {}

      if (isBroken) {
        try {
          fs.unlinkSync(targetLinkPath);
        } catch (_) {}
      }

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

module.exports = { setupBinaries, resourcesPath };
