const fs = require('fs');
const path = require('path');
const os = require('os');

require('./bin-setup');

const PythonBridge = require('./rpc');
const { getBitrate } = require('./scanner');
const { loadLedger, saveLedger } = require('./ledger');
const { compareAudioFiles } = require('./similarity');

function sanitizeFilenamePart(part) {
  if (!part) return '';
  let clean = part.replace(/[\/\\:*?"<>|]/g, '');
  clean = clean.trim().replace(/^\.+|\.+$/g, '').trim();
  return clean;
}

const https = require('https');

function fetchDeezerMetadata(deezerId) {
  return new Promise((resolve) => {
    const url = `https://api.deezer.com/track/${deezerId}`;
    if (typeof fetch !== 'undefined') {
      fetch(url)
        .then(res => {
          if (res.ok) return res.json();
          throw new Error(`HTTP ${res.status}`);
        })
        .then(data => {
          if (data && !data.error) {
            resolve({
              artist: data.artist?.name || null,
              title: data.title || null
            });
          } else {
            resolve(null);
          }
        })
        .catch(err => {
          console.warn(`[NODE] fetch failed: ${err.message}`);
          resolve(null);
        });
    } else {
      https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed && !parsed.error) {
              resolve({
                artist: parsed.artist?.name || null,
                title: parsed.title || null
              });
            } else {
              resolve(null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      }).on('error', (err) => {
        console.warn(`[NODE] https.get failed: ${err.message}`);
        resolve(null);
      });
    }
  });
}

async function refetchTrack(rootPath, outputFormat, relPath, deezerId, artist, title) {
  const bridge = new PythonBridge();
  bridge.start();

  try {
    const ext = path.extname(relPath);
    const relativeBase = relPath.startsWith('/') ? relPath.substring(1) : relPath;
    const baseWithoutExt = ext ? relativeBase.slice(0, -ext.length) : relativeBase;
    const sanitizedBase = baseWithoutExt
      .split('/')
      .filter(segment => segment !== '..' && segment !== '.')
      .join('/');
    const safeBase = sanitizedBase || path.basename(relPath, ext);
    const relativeStaged = 'crateup-staging/' + safeBase + '.' + outputFormat;
    const stagedAbsPath = path.join(rootPath, relativeStaged);

    let matchedArtist = artist;
    let matchedTitle = title;

    if (!matchedArtist || matchedArtist === 'Unknown Artist' || !matchedTitle || matchedTitle === 'Unknown Title') {
      const meta = await fetchDeezerMetadata(deezerId);
      if (meta) {
        if (meta.artist) matchedArtist = meta.artist;
        if (meta.title) matchedTitle = meta.title;
      }
    }

    // Call Python download
    const downloadResult = await bridge.call('download', {
      deezer_id: parseInt(deezerId, 10),
      output_format: outputFormat,
      staged_path: stagedAbsPath
    });

    // Rename file
    let combined = '';
    const hasArtist = matchedArtist && matchedArtist !== 'Unknown Artist';
    const hasTitle = matchedTitle && matchedTitle !== 'Unknown Title';

    if (hasArtist || hasTitle) {
      const cleanArtist = sanitizeFilenamePart(matchedArtist || 'Unknown Artist');
      const cleanTitle = sanitizeFilenamePart(matchedTitle || 'Unknown Title');
      combined = `${cleanArtist} - ${cleanTitle}`;
    } else {
      combined = path.basename(relPath, path.extname(relPath));
    }

    if (combined.length > 150) {
      combined = combined.substring(0, 150);
    }
    combined = combined.trim().replace(/^\.+|\.+$/g, '').trim();
    if (!combined) {
      combined = path.basename(relPath, path.extname(relPath));
    }
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

    // Update ledger (read-through; missing ledger or track = no-op)
    const ledger = loadLedger(rootPath);
    const entry = ledger && ledger.files && ledger.files[relPath];

    // Calculate audio similarity between original and new staged file
    let audioSimilarity = 0.0;
    let audioBitIdentical = false;
    try {
      const absOriginalPath = (entry && entry.original_abs_path)
        ? entry.original_abs_path
        : path.join(rootPath, relPath.startsWith('/') ? relPath.substring(1) : relPath);
      const compareTarget = fs.existsSync(finalAbsPath) ? finalAbsPath : stagedAbsPath;
      if (fs.existsSync(absOriginalPath) && fs.existsSync(compareTarget)) {
        const compResult = compareAudioFiles(absOriginalPath, compareTarget);
        audioSimilarity = compResult.similarity;
        audioBitIdentical = compResult.bitIdentical;
      }
    } catch (simErr) {
      // Non-fatal — similarity defaults to 0
      console.error(`[NODE] Similarity check failed: ${simErr.message}`);
    }

    if (ledger && ledger.files && ledger.files[relPath]) {
      ledger.files[relPath].status = 'downloaded';
      ledger.files[relPath].deezer_id = parseInt(deezerId, 10);
      ledger.files[relPath].staged_path = finalAbsoluteStaged;
      ledger.files[relPath].proxy_path = absoluteProxy;
      ledger.files[relPath].staged_bitrate = stagedBitrate;
      ledger.files[relPath].artist = matchedArtist;
      ledger.files[relPath].title = matchedTitle;
      ledger.files[relPath].decision = 'pending';
      ledger.files[relPath].similarity_score = audioSimilarity;
      ledger.files[relPath].audio_bit_identical = audioBitIdentical;
      saveLedger(rootPath, ledger);
    }

    return {
      status: 'downloaded',
      deezer_id: parseInt(deezerId, 10),
      staged_path: finalAbsoluteStaged,
      proxy_path: absoluteProxy,
      staged_bitrate: stagedBitrate,
      artist: matchedArtist,
      title: matchedTitle,
      similarity_score: audioSimilarity,
      audio_bit_identical: audioBitIdentical
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
