const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

const BINARY_DIR = path.join(__dirname, '../src-tauri/binaries');

function getBinaryPath(baseName) {
  if (fs.existsSync(BINARY_DIR)) {
    try {
      const files = fs.readdirSync(BINARY_DIR);
      const matched = files.find(f => f.startsWith(baseName + '-'));
      if (matched) {
        return path.join(BINARY_DIR, matched);
      }
    } catch (_) {}
  }
  return baseName;
}

function getChromaprintFingerprint(filePath) {
  try {
    const fpcalcPath = getBinaryPath('fpcalc');
    const stdout = child_process.execFileSync(
      fpcalcPath,
      ['-raw', filePath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    
    let fingerprint = null;
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith('FINGERPRINT=')) {
        const fpStr = line.substring('FINGERPRINT='.length).trim();
        if (fpStr) {
          fingerprint = fpStr.split(',').map(s => {
            const val = parseInt(s, 10);
            // Convert to 32-bit unsigned integer equivalent
            return val >>> 0;
          });
        }
      }
    }
    return fingerprint;
  } catch (err) {
    return null;
  }
}

function runDiagnosis(path1, path2) {
  console.log("\n=== CrateUp Similarity Diagnostician ===\n");
  
  const fp1 = getChromaprintFingerprint(path1);
  const fp2 = getChromaprintFingerprint(path2);

  if (!fp1 || !fp2) {
    console.error("Error: Failed to extract audio fingerprints.");
    return;
  }

  const len1 = fp1.length;
  const len2 = fp2.length;
  console.log(`Track 1 Length: ${len1}`);
  console.log(`Track 2 Length: ${len2}`);
  
  const max_len = Math.max(len1, len2);
  const min_len = Math.min(len1, len2);
  if (max_len > 10 && max_len - min_len > (max_len * 20) / 100) {
    console.log("✗ Skipped: Length difference is > 20%.");
    return;
  }

  const [a, b] = len1 <= len2 ? [fp1, fp2] : [fp2, fp1];
  const n = a.length;
  const m = b.length;

  // 1. Density filter check
  let ones_a = 0;
  for (let i = 0; i < a.length; i++) {
    ones_a += popcount(a[i]);
  }
  let ones_b = 0;
  for (let i = 0; i < b.length; i++) {
    ones_b += popcount(b[i]);
  }
  const da = ones_a / (a.length * 32);
  const db = ones_b / (b.length * 32);
  const density_diff = Math.abs(da - db);
  console.log(`Density Check: da=${da.toFixed(4)}, db=${db.toFixed(4)}, diff=${density_diff.toFixed(4)}`);
  if (density_diff > 0.25) {
    console.log("✗ Failed: Density check difference is > 25%.");
    return;
  }

  // 2. Middle anchor check
  const anchor_len = Math.min(40, a.length);
  if (anchor_len > 10) {
    const start_idx = Math.floor((a.length - anchor_len) / 2);
    const anchor = a.slice(start_idx, start_idx + anchor_len);
    let anchor_matched = false;
    let best_anchor_sim = 0;
    
    for (let d = 0; d <= b.length - anchor_len; d += 2) {
      let match_bits = 0;
      for (let i = 0; i < anchor_len; i++) {
        const x = anchor[i];
        const y = b[d + i];
        match_bits += 32 - popcount(x ^ y);
      }
      const sim = match_bits / (anchor_len * 32);
      if (sim > best_anchor_sim) best_anchor_sim = sim;
      if (sim > 0.60) {
        anchor_matched = true;
      }
    }
    console.log(`Anchor Check: best_anchor_sim=${best_anchor_sim.toFixed(4)}`);
    if (!anchor_matched) {
      console.log("✗ Failed: Anchor check failed (no offset got > 60% match).");
      return;
    }
  }

  const min_overlap = Math.min(60, n);
  const start_offset = -n + min_overlap;
  const end_offset = m - min_overlap;
  const total_offsets = end_offset - start_offset;

  const candidates = [];
  const use_coarse = total_offsets > 16;

  // 3. Coarse screening
  if (use_coarse) {
    const coarse_step = 8;
    for (let d = start_offset; d <= end_offset; d += coarse_step) {
      const start_a = Math.max(0, -d);
      const end_a = Math.min(n, m - d);
      const k = end_a - start_a;
      if (k < min_overlap) continue;
      
      let match_bits = 0;
      let sample_count = 0;
      for (let i = start_a; i < end_a; i += 4) {
        const x = a[i];
        const y = b[i + d];
        match_bits += 32 - popcount(x ^ y);
        sample_count++;
      }
      if (sample_count > 0) {
        const est = match_bits / (sample_count * 32);
        if (est > 0.65) {
          candidates.push(d);
        }
      }
    }
    console.log(`Coarse check found ${candidates.length} candidates.`);
    if (candidates.length === 0) {
      console.log("✗ Failed: Coarse check found no candidates.");
      return;
    }
  }

  // Build offset list
  const offsets_to_check = [];
  if (use_coarse) {
    for (const coarse_d of candidates) {
      const start_range = Math.max(start_offset, coarse_d - 4);
      const end_range = Math.min(end_offset, coarse_d + 4);
      for (let d = start_range; d <= end_range; d++) {
        if (!offsets_to_check.includes(d)) {
          offsets_to_check.push(d);
        }
      }
    }
    offsets_to_check.sort((x, y) => x - y);
  } else {
    for (let d = start_offset; d <= end_offset; d++) {
      offsets_to_check.push(d);
    }
  }

  // 4. Fine checks with mathematical early exit
  let max_sim = 0;
  let best_d = 0;
  for (const d of offsets_to_check) {
    const start_a = Math.max(0, -d);
    const end_a = Math.min(n, m - d);
    const k = end_a - start_a;
    if (k < min_overlap) continue;

    const threshold_bits = Math.floor((k * 288) / 10);
    let matching_bits = 0;
    let possible_failed = false;
    
    for (let i = start_a; i < end_a; i++) {
      const x = a[i];
      const y = b[i + d];
      matching_bits += 32 - popcount(x ^ y);
      
      const count = i - start_a;
      if (count % 16 === 0) {
        const remaining_max = (k - 1 - count) * 32;
        if (matching_bits + remaining_max < threshold_bits) {
          possible_failed = true;
          break;
        }
      }
    }

    if (!possible_failed) {
      const sim = matching_bits / (k * 32);
      if (sim > max_sim) {
        max_sim = sim;
        best_d = d;
        if (max_sim >= 0.90) {
          break;
        }
      }
    }
  }

  console.log(`\n=== EXHAUSTIVE UNFILTERED RESULTS ===`);
  console.log(`  Best Similarity Match Score: ${(max_sim * 100).toFixed(2)}%`);
  console.log(`  Best Offset: ${best_d}`);
  if (max_sim >= 0.90) {
    console.log(`  ✓ This pair SHOULD match (similarity is >= 90%).`);
  } else {
    console.log(`  ✗ This pair DOES NOT match.`);
  }
}

function popcount(n) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

if (process.argv.length < 4) {
  console.log("Usage: node diagnose.js <path1> <path2>");
  process.exit(1);
}

runDiagnosis(process.argv[2], process.argv[3]);
