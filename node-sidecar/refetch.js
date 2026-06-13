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
const { getBitrate } = require('./scanner');

function sanitizeFilenamePart(part) {
  if (!part) return '';
  let clean = part.replace(/[\/\\:*?"<>|]/g, '');
  clean = clean.trim().replace(/^\.+|\.+$/g, '').trim();
  return clean;
}

async function refetchTrack(rootPath, outputFormat, relPath, deezerId, artist, title) {
  const bridge = new PythonBridge();
  bridge.start();

  try {
    const ext = path.extname(relPath);
    const relativeBase = relPath.startsWith('/') ? relPath.substring(1) : relPath;
    const relativeStaged = 'crateup-staging/' + relativeBase.replace(ext, '.' + outputFormat);
    const stagedAbsPath = path.join(rootPath, relativeStaged);

    // Call Python download
    const downloadResult = await bridge.call('download', {
      deezer_id: parseInt(deezerId, 10),
      output_format: outputFormat,
      staged_path: stagedAbsPath
    });

    // Rename file
    const cleanArtist = sanitizeFilenamePart(artist || 'Unknown Artist');
    const cleanTitle = sanitizeFilenamePart(title || 'Unknown Title');
    let combined = `${cleanArtist} - ${cleanTitle}`;
    if (combined.length > 150) {
      combined = combined.substring(0, 150);
    }
    combined = combined.trim().replace(/^\.+|\.+$/g, '').trim();
    const finalFilename = `${combined}.${outputFormat}`;

    const stagedDir = path.dirname(stagedAbsPath);
    const finalAbsPath = path.join(stagedDir, finalFilename);

    try {
      fs.renameSync(stagedAbsPath, finalAbsPath);
    } catch (renameErr) {
      // Ignore rename error if file already renamed
    }

    const finalAbsoluteStaged = (fs.existsSync(finalAbsPath) ? finalAbsPath : stagedAbsPath).split(path.sep).join('/');

    let absoluteProxy = null;
    if (downloadResult.proxy_path) {
      absoluteProxy = downloadResult.proxy_path.split(path.sep).join('/');
    }

    const stagedBitrate = getBitrate(fs.existsSync(finalAbsPath) ? finalAbsPath : stagedAbsPath);

    // Update ledger
    const isProdDir = fs.existsSync(path.join(__dirname, '../../Resources/binaries')) || fs.existsSync(path.join(path.dirname(process.execPath), '../Resources/binaries'));
    const isTestMode = process.env.NODE_ENV === 'test';
    const ledgerFilename = (isProdDir || isTestMode) ? '.crateup-progress.json' : '.crateup-progress-dev.json';
    const ledgerPath = path.join(rootPath, ledgerFilename);
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      if (ledger.files && ledger.files[relPath]) {
        ledger.files[relPath].status = 'downloaded';
        ledger.files[relPath].deezer_id = parseInt(deezerId, 10);
        ledger.files[relPath].staged_path = finalAbsoluteStaged;
        ledger.files[relPath].proxy_path = absoluteProxy;
        ledger.files[relPath].staged_bitrate = stagedBitrate;
        ledger.files[relPath].artist = artist;
        ledger.files[relPath].title = title;
        ledger.files[relPath].decision = 'pending';
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8');
      }
    }

    return {
      status: 'downloaded',
      deezer_id: parseInt(deezerId, 10),
      staged_path: finalAbsoluteStaged,
      proxy_path: absoluteProxy,
      staged_bitrate: stagedBitrate,
      artist: artist,
      title: title
    };
  } finally {
    bridge.stop();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const [rootPath, outputFormat, relPath, deezerId, artist, title] = args;
  refetchTrack(rootPath, outputFormat, relPath, deezerId, artist, title)
    .then(result => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
