require('./bin-setup');
const child_process = require('child_process');
const fs = require('fs');

function popcount(n) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

function getRawAudioMD5(filePath) {
  try {
    const stdout = child_process.execFileSync(
      'ffmpeg',
      ['-i', filePath, '-map', '0:a', '-f', 'md5', '-'],
      { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const match = stdout.match(/MD5=([a-f0-9]{32})/i);
    return match ? match[1].toLowerCase() : null;
  } catch (err) {
    console.error(`[SIMILARITY] ffmpeg MD5 hash failed for ${filePath}: ${err.message}`);
    return null;
  }
}

function getChromaprintFingerprint(filePath) {
  try {
    const stdout = child_process.execFileSync(
      'fpcalc',
      ['-raw', filePath],
      { env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    
    let fingerprint = null;
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith('FINGERPRINT=')) {
        const fpStr = line.substring('FINGERPRINT='.length).trim();
        if (fpStr) {
          fingerprint = fpStr.split(',').map(s => parseInt(s, 10));
        }
      }
    }
    return fingerprint;
  } catch (err) {
    console.error(`[SIMILARITY] fpcalc fingerprint failed for ${filePath}: ${err.message}`);
    return null;
  }
}

function calculateSimilarity(fp1, fp2) {
  if (!fp1 || !fp2 || fp1.length === 0 || fp2.length === 0) return 0;
  
  const len1 = fp1.length;
  const len2 = fp2.length;
  const maxLen = Math.max(len1, len2);
  const minLen = Math.min(len1, len2);
  // If lengths differ by more than 20% (for files of substantial length > 60 frames ~5s),
  // they cannot be the same complete recording (prevents truncated 30s clips matching full tracks).
  if (maxLen > 60 && (maxLen - minLen) > (maxLen * 0.20)) {
    return 0;
  }

  const [A, B] = len1 <= len2 ? [fp1, fp2] : [fp2, fp1];
  const N = A.length;
  const M = B.length;

  // Bit-Weight (Hamming Weight) Density Filter with safe/loose 25% margin (for tracks > 10 frames)
  if (minLen > 10) {
    let onesA = 0;
    for (let i = 0; i < N; i++) onesA += popcount(A[i]);
    let onesB = 0;
    for (let i = 0; i < M; i++) onesB += popcount(B[i]);
    const dA = onesA / (N * 32);
    const dB = onesB / (M * 32);
    if (Math.abs(dA - dB) > 0.25) {
      return 0;
    }
  }
  
  const minOverlap = Math.min(60, N);
  let maxSim = 0;
  
  const startOffset = -N + minOverlap;
  const endOffset = M - minOverlap;
  
  for (let d = startOffset; d <= endOffset; d++) {
    const startA = Math.max(0, -d);
    const endA = Math.min(N, M - d);
    const K = endA - startA;
    
    if (K < minOverlap) continue;
    
    let matchingBits = 0;
    for (let i = startA; i < endA; i++) {
      const x = A[i];
      const y = B[i + d];
      matchingBits += (32 - popcount(x ^ y));
    }
    
    const sim = matchingBits / (K * 32);
    if (sim > maxSim) {
      maxSim = sim;
    }
  }
  
  return maxSim;
}

function compareAudioFiles(file1, file2) {
  if (!fs.existsSync(file1) || !fs.existsSync(file2)) {
    return { bitIdentical: false, similarity: 0 };
  }

  // 1. Check bit identity of raw audio streams first
  const md5_1 = getRawAudioMD5(file1);
  const md5_2 = getRawAudioMD5(file2);
  
  if (md5_1 && md5_2 && md5_1 === md5_2) {
    return { bitIdentical: true, similarity: 1.0 };
  }
  
  // 2. Fall back to acoustic fingerprinting if not bit-identical
  const fp1 = getChromaprintFingerprint(file1);
  const fp2 = getChromaprintFingerprint(file2);
  
  const similarity = calculateSimilarity(fp1, fp2);
  return { bitIdentical: false, similarity };
}

module.exports = {
  compareAudioFiles,
  getRawAudioMD5,
  getChromaprintFingerprint,
  calculateSimilarity
};
