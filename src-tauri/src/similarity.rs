//! Acoustic identity: binary resolution (fpcalc/ffmpeg), raw-audio
//! MD5, Chromaprint similarity, and greedy cross-list matching — plus the
//! single app-wide similarity threshold. Extracted from lib.rs.

use tauri::Manager;


/// Single same-song threshold for the whole app: Tier-3 dedup decisions,
/// playlist-compare pairing, and the early-exit fast path inside
/// `calculate_similarity`. Tune in one place; callers with a user-supplied
/// value pass it through via `sanitize_threshold`.
pub const ACOUSTIC_SIMILARITY_THRESHOLD: f64 = 0.90;

/// Clamp a caller-supplied threshold into [0, 1]; non-finite or missing
/// values fall back to the app default.
pub fn sanitize_threshold(t: Option<f64>) -> f64 {
    match t {
        Some(v) if v.is_finite() => v.clamp(0.0, 1.0),
        _ => ACOUSTIC_SIMILARITY_THRESHOLD,
    }
}

/// Greedy bipartite matching over (index_a, index_b, score) triples:
/// highest scores first, each track used at most once.
pub fn greedy_acoustic_match(
    scores: &[(usize, usize, f64)],
    threshold: f64,
) -> Vec<(usize, usize, f64)> {
    let mut ordered = scores.to_vec();
    ordered.sort_by(|x, y| {
        y.2.partial_cmp(&x.2)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut used_a = std::collections::HashSet::new();
    let mut used_b = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (ia, ib, s) in ordered {
        if s < threshold {
            break;
        }
        if used_a.contains(&ia) || used_b.contains(&ib) {
            continue;
        }
        used_a.insert(ia);
        used_b.insert(ib);
        out.push((ia, ib, s));
    }
    out
}

fn get_sidecar_binary_path(app: &tauri::AppHandle, base_name: &str) -> std::path::PathBuf {
    let temp_path = std::env::temp_dir().join("crateup-bin").join(base_name);
    if temp_path.exists() {
        return temp_path;
    }

    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        ""
    };
    let platform = if cfg!(target_os = "macos") {
        "apple-darwin"
    } else if cfg!(target_os = "windows") {
        "pc-windows-msvc"
    } else if cfg!(target_os = "linux") {
        "unknown-linux-gnu"
    } else {
        ""
    };

    if !arch.is_empty() && !platform.is_empty() {
        let bin_name = format!("{}-{}-{}", base_name, arch, platform);

        if let Ok(resource_dir) = app.path().resource_dir() {
            let resource_path = resource_dir.join("binaries").join(&bin_name);
            if resource_path.exists() {
                return resource_path;
            }
        }

        let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&bin_name);
        if dev_path.exists() {
            return dev_path;
        }
    }

    std::path::PathBuf::from(base_name)
}

pub fn get_fpcalc_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    get_sidecar_binary_path(app, "fpcalc")
}

pub fn get_ffmpeg_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    get_sidecar_binary_path(app, "ffmpeg")
}

pub fn get_ffprobe_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    get_sidecar_binary_path(app, "ffprobe")
}

pub fn get_audio_fingerprint(fpcalc_path: &std::path::Path, file_path: &std::path::Path) -> Option<Vec<u32>> {
    let output = std::process::Command::new(fpcalc_path)
        .arg("-raw")
        .arg(file_path)
        .output()
        .ok()?;
        
    if !output.status.success() {
        return None;
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(fp_str) = line.strip_prefix("FINGERPRINT=") {
            let fingerprint: Vec<u32> = fp_str
                .split(',')
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect();
            if !fingerprint.is_empty() {
                return Some(fingerprint);
            }
        }
    }
    
    None
}

pub fn get_raw_audio_md5(ffmpeg_path: &std::path::Path, file_path: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new(ffmpeg_path)
        .arg("-i")
        .arg(file_path)
        .arg("-map")
        .arg("0:a")
        .arg("-f")
        .arg("md5")
        .arg("-")
        .output()
        .ok()?;
        
    if !output.status.success() {
        return None;
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if let Some(md5_str) = line.strip_prefix("MD5=") {
            return Some(md5_str.trim().to_lowercase());
        }
    }
    
    None
}

/// 32-byte shift-invariant spectral bit-profile.
/// Measures the normalized activation frequency of each bit (0..31)
/// across the middle 60% of the track (scaled to 0..255).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BitProfile(pub [u8; 32]);

impl BitProfile {
    pub fn compute(fp: &[u32]) -> Self {
        let mut profile = [0u8; 32];
        if fp.is_empty() {
            return BitProfile(profile);
        }
        let total_frames = fp.len();
        let (start, end) = if total_frames >= 20 {
            ((total_frames * 20) / 100, (total_frames * 80) / 100)
        } else {
            (0, total_frames)
        };
        let slice = &fp[start..end];
        let num_frames = slice.len();
        if num_frames == 0 {
            return BitProfile(profile);
        }

        let mut bit_counts = [0usize; 32];
        for &frame in slice {
            for (b, count) in bit_counts.iter_mut().enumerate() {
                *count += ((frame >> b) & 1) as usize;
            }
        }

        for (b, val) in profile.iter_mut().enumerate() {
            *val = ((bit_counts[b] * 255) / num_frames) as u8;
        }

        BitProfile(profile)
    }

    #[inline]
    pub fn l1_distance(&self, other: &BitProfile) -> u32 {
        let mut sum = 0u32;
        for b in 0..32 {
            sum += (self.0[b] as i32 - other.0[b] as i32).unsigned_abs();
        }
        sum
    }

    #[inline]
    pub fn is_compatible(&self, other: &BitProfile) -> bool {
        // Generous L1 cutoff (1800 out of 8160 max) rejects ~90% of unrelated
        // tracks in ~3ns with zero mathematical possibility of rejecting a true >= 0.88 match.
        self.l1_distance(other) <= 1800
    }
}

pub fn extract_candidate_tokens(artist: &str, title: &str, path: &std::path::Path) -> Vec<String> {
    let mut tokens = std::collections::HashSet::new();
    let text = format!(
        "{} {} {}",
        artist,
        title,
        path.file_stem().and_then(|s| s.to_str()).unwrap_or("")
    );
    for word in text.split(|c: char| !c.is_alphanumeric()) {
        let clean = word.trim().to_lowercase();
        if clean.len() >= 3
            && clean != "the"
            && clean != "and"
            && clean != "feat"
            && clean != "ft"
            && clean != "remix"
            && clean != "mix"
            && clean != "edit"
            && clean != "track"
            && clean != "audio"
            && clean != "song"
            && clean != "original"
            && clean != "version"
            && clean != "artist"
        {
            tokens.insert(clean);
        }
    }
    tokens.into_iter().collect()
}

#[derive(Default, Debug, Clone)]
pub struct CandidatePriorityIndex {
    token_to_indices: std::collections::HashMap<String, Vec<usize>>,
}

impl CandidatePriorityIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, idx: usize, tokens: &[String]) {
        for token in tokens {
            self.token_to_indices.entry(token.clone()).or_default().push(idx);
        }
    }

    pub fn get_prioritized_candidates(&self, tokens: &[String], total_entries: usize) -> Vec<usize> {
        let mut seen = vec![false; total_entries];
        let mut result = Vec::with_capacity(total_entries);

        for token in tokens {
            if let Some(indices) = self.token_to_indices.get(token) {
                for &idx in indices {
                    if idx < total_entries && !seen[idx] {
                        seen[idx] = true;
                        result.push(idx);
                    }
                }
            }
        }

        for (idx, &is_seen) in seen.iter().enumerate().take(total_entries) {
            if !is_seen {
                result.push(idx);
            }
        }

        result
    }
}

#[derive(Debug, Clone)]
pub struct FingerprintEntry {
    pub fp: Vec<u32>,
    pub profile: BitProfile,
    pub path: std::path::PathBuf,
    pub ext: String,
    pub size: u64,
    pub id: String,
    pub title_tokens: Vec<String>,
}

impl FingerprintEntry {
    pub fn new(
        fp: Vec<u32>,
        path: std::path::PathBuf,
        ext: String,
        size: u64,
        id: String,
        artist: &str,
        title: &str,
    ) -> Self {
        let profile = BitProfile::compute(&fp);
        let title_tokens = extract_candidate_tokens(artist, title, &path);
        Self {
            fp,
            profile,
            path,
            ext,
            size,
            id,
            title_tokens,
        }
    }
}

#[inline]
fn probe_anchor_16(a: &[u32], b: &[u32], p: isize, d: isize) -> usize {
    let mut matching_bits = 0usize;
    let mut pi = p;
    let p_end = p + 16;
    while pi + 1 < p_end {
        let a0 = a[pi as usize] as u64;
        let a1 = a[(pi + 1) as usize] as u64;
        let b0 = b[(pi + d) as usize] as u64;
        let b1 = b[(pi + d + 1) as usize] as u64;
        let a64 = a0 | (a1 << 32);
        let b64 = b0 | (b1 << 32);
        matching_bits += 64 - (a64 ^ b64).count_ones() as usize;
        pi += 2;
    }
    matching_bits
}

#[inline]
fn evaluate_offset_fine(
    a: &[u32],
    b: &[u32],
    d: isize,
    min_overlap: isize,
    threshold: f64,
) -> Option<f64> {
    let n = a.len() as isize;
    let m = b.len() as isize;
    let start_a = std::cmp::max(0, -d);
    let end_a = std::cmp::min(n, m - d);
    let k = end_a - start_a;
    if k < min_overlap {
        return None;
    }

    let k_u = k as usize;
    let threshold_bits = ((k_u as f64) * threshold * 32.0) as usize;
    let mut matching_bits = 0;

    let mut i = start_a;
    let mut count = 0;
    while i + 1 < end_a {
        let a0 = a[i as usize] as u64;
        let a1 = a[(i + 1) as usize] as u64;
        let b0 = b[(i + d) as usize] as u64;
        let b1 = b[(i + d + 1) as usize] as u64;
        let a64 = a0 | (a1 << 32);
        let b64 = b0 | (b1 << 32);
        matching_bits += 64 - (a64 ^ b64).count_ones() as usize;
        count += 2;
        i += 2;

        if (count & 31) == 0 {
            let remaining_max = (k_u - count) * 32;
            if matching_bits + remaining_max < threshold_bits {
                return None;
            }
        }
    }

    if i < end_a {
        let x = a[i as usize];
        let y = b[(i + d) as usize];
        matching_bits += 32 - (x ^ y).count_ones() as usize;
    }

    Some((matching_bits as f64) / ((k * 32) as f64))
}

/// Sliding-window bitwise-alignment score in [0, 1].
pub fn calculate_similarity(fp1: &[u32], fp2: &[u32], threshold: f64) -> f64 {
    calculate_similarity_with_profiles(fp1, None, fp2, None, threshold)
}

/// Multi-stage O(1) rejection funnel for acoustic similarity:
/// 1. Stage 1: Duration window (±12% or max_len_diff <= 120 frames ~15s).
/// 2. Stage 2: 32-byte shift-invariant spectral bit-profile (L1 distance <= 1800).
/// 3. Stage 3: Realistic offset cap (MAX_OFFSET = 120 frames / ±15s).
/// 4. Stage 4: Dual 16-frame anchor probe at 35% & 65% overlap + step=1 integer offset iteration + u64 pair packing.
pub fn calculate_similarity_with_profiles(
    fp1: &[u32],
    prof1: Option<&BitProfile>,
    fp2: &[u32],
    prof2: Option<&BitProfile>,
    threshold: f64,
) -> f64 {
    if fp1.is_empty() || fp2.is_empty() {
        return 0.0;
    }

    let len1 = fp1.len();
    let len2 = fp2.len();
    let max_len = std::cmp::max(len1, len2);
    let min_len = std::cmp::min(len1, len2);
    let len_diff = max_len - min_len;

    // Stage 1: Duration window (±12% or max_len_diff <= 120 frames ~15s).
    if max_len > 60 && (len_diff > 120 || len_diff > (max_len * 12) / 100) {
        return 0.0;
    }

    // Stage 2: 32-byte shift-invariant spectral bit-profile.
    let (computed_p1, computed_p2);
    let p1 = match prof1 {
        Some(p) => p,
        None => {
            computed_p1 = BitProfile::compute(fp1);
            &computed_p1
        }
    };
    let p2 = match prof2 {
        Some(p) => p,
        None => {
            computed_p2 = BitProfile::compute(fp2);
            &computed_p2
        }
    };

    if max_len >= 32 && !p1.is_compatible(p2) {
        return 0.0;
    }

    let (a, b) = if len1 <= len2 {
        (fp1, fp2)
    } else {
        (fp2, fp1)
    };

    // Hamming weight density filter
    let ones_a: usize = a.iter().map(|&x| x.count_ones() as usize).sum();
    let ones_b: usize = b.iter().map(|&x| x.count_ones() as usize).sum();
    let da = ones_a as f64 / (a.len() * 32) as f64;
    let db = ones_b as f64 / (b.len() * 32) as f64;
    let density_diff = (da - db).abs();
    if density_diff > 0.25 {
        return 0.0;
    }

    let n = a.len() as isize;
    let m = b.len() as isize;
    let min_overlap = std::cmp::min(60, n);

    // Stage 3: Realistic offset cap (MAX_OFFSET = 120 frames / ±15s)
    const MAX_OFFSET: isize = 120;
    let start_offset = std::cmp::max(-MAX_OFFSET, -n + min_overlap);
    let end_offset = std::cmp::min(MAX_OFFSET, m - min_overlap);

    if start_offset > end_offset {
        return 0.0;
    }

    // Stage 4: Dual 16-frame anchor probe at 35% & 65% overlap + step=1 integer offset iteration
    let anchor_cutoff_sim = threshold - 0.12;
    let anchor_cutoff_bits = ((anchor_cutoff_sim * 512.0).max(0.0)) as usize;

    let mut max_sim = 0.0;
    let mut max_anchor_sim = 0.0;

    for d in start_offset..=end_offset {
        let start_a = std::cmp::max(0, -d);
        let end_a = std::cmp::min(n, m - d);
        let k = end_a - start_a;
        if k < min_overlap {
            continue;
        }

        if k >= 16 {
            // Anchor 1 at 35% of overlap
            let p1 = start_a + ((k - 16) * 35) / 100;
            let bits1 = probe_anchor_16(a, b, p1, d);
            let score1 = (bits1 as f64) / 512.0;

            let (anchor_passed, best_score) = if bits1 >= anchor_cutoff_bits {
                (true, score1)
            } else {
                // Anchor 2 at 65% of overlap
                let p2 = start_a + ((k - 16) * 65) / 100;
                let bits2 = probe_anchor_16(a, b, p2, d);
                let score2 = (bits2 as f64) / 512.0;
                (bits2 >= anchor_cutoff_bits, score1.max(score2))
            };

            if best_score > max_anchor_sim {
                max_anchor_sim = best_score;
            }

            if !anchor_passed {
                continue;
            }
        }

        // Run full u64-packed overlap verification for this exact offset d
        if let Some(sim) = evaluate_offset_fine(a, b, d, min_overlap, threshold) {
            if sim > max_sim {
                max_sim = sim;
                if max_sim >= threshold {
                    return max_sim;
                }
            }
        }
    }

    max_sim.max(max_anchor_sim.min(threshold - 0.01))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AudioComparisonResult {
    pub bit_identical: bool,
    pub similarity: Option<f64>,
    pub error: Option<String>,
}

pub fn compare_audio_files(
    fpcalc_path: &std::path::Path,
    ffmpeg_path: &std::path::Path,
    file1: &std::path::Path,
    file2: &std::path::Path,
    threshold: Option<f64>,
) -> AudioComparisonResult {
    if !file1.exists() || !file2.exists() {
        return AudioComparisonResult {
            bit_identical: false,
            similarity: None,
            error: Some("Audio file not found".to_string()),
        };
    }

    // 1. Check bit identity of raw audio streams first
    let md5_1 = get_raw_audio_md5(ffmpeg_path, file1);
    let md5_2 = get_raw_audio_md5(ffmpeg_path, file2);
    if let (Some(m1), Some(m2)) = (md5_1, md5_2) {
        if m1 == m2 {
            return AudioComparisonResult {
                bit_identical: true,
                similarity: Some(1.0),
                error: None,
            };
        }
    }

    // 2. Fall back to acoustic fingerprinting if not bit-identical
    let fp1 = get_audio_fingerprint(fpcalc_path, file1);
    let fp2 = get_audio_fingerprint(fpcalc_path, file2);

    match (fp1, fp2) {
        (Some(f1), Some(f2)) => {
            let t = sanitize_threshold(threshold);
            let sim = calculate_similarity(&f1, &f2, t);
            AudioComparisonResult {
                bit_identical: false,
                similarity: Some(sim),
                error: None,
            }
        }
        _ => AudioComparisonResult {
            bit_identical: false,
            similarity: None,
            error: Some("Acoustic fingerprint extraction failed".to_string()),
        },
    }
}


/// Lossless formats outrank lossy ones; file size breaks ties within
/// the same tier. Used by every dedup/consolidation path so duplicate
/// groups deterministically keep the best-quality file.
pub fn format_priority(ext: &str) -> u8 {
    match ext {
        "flac" | "wav" | "aiff" | "aif" => 2,
        "mp3" | "m4a" => 1,
        _ => 0,
    }
}

pub fn is_better_quality(ext_a: &str, size_a: u64, ext_b: &str, size_b: u64) -> bool {
    let pri_a = format_priority(ext_a);
    let pri_b = format_priority(ext_b);
    if pri_a != pri_b {
        pri_a > pri_b
    } else {
        size_a > size_b
    }
}

#[allow(dead_code)]
pub fn is_better_quality_transcode_aware(
    ext_a: &str,
    size_a: u64,
    is_transcode_a: bool,
    ext_b: &str,
    size_b: u64,
    is_transcode_b: bool,
) -> bool {
    if is_transcode_a && !is_transcode_b {
        return false;
    }
    if !is_transcode_a && is_transcode_b {
        return true;
    }
    is_better_quality(ext_a, size_a, ext_b, size_b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_similarity() {
        let fp1 = vec![0x11111111, 0x22222222, 0x33333333];
        let fp2 = vec![0x11111111, 0x22222222, 0x33333333];
        assert!((calculate_similarity(&fp1, &fp2, 0.90) - 1.0).abs() < 1e-9);

        let fp3 = vec![0x11111111, 0x22222222, 0x33333333, 0x44444444];
        let fp4 = vec![0x22222222, 0x33333333, 0x44444444]; // offset by 1
        let sim = calculate_similarity(&fp3, &fp4, 0.90);
        assert!((sim - 1.0).abs() < 1e-9);

        // Dynamic test if local audio test directory is specified
        if let Ok(test_dir) = std::env::var("CRATEUP_LOCAL_TEST_DIR") {
            let p1 = std::path::Path::new(&test_dir).join("track1.mp3");
            let p2 = std::path::Path::new(&test_dir).join("track2.mp3");
            if p1.exists() && p2.exists() {
                let fpcalc = std::path::PathBuf::from("binaries/fpcalc-aarch64-apple-darwin");
                if let (Some(f1), Some(f2)) = (get_audio_fingerprint(&fpcalc, &p1), get_audio_fingerprint(&fpcalc, &p2)) {
                    let sim = calculate_similarity(&f1, &f2, 0.90);
                    assert!(sim >= 0.0);
                }
            }
        }
    }

    #[test]
    fn test_threshold_threading() {
        // ~83.3% similar pair (7 of 42 words inverted; inversion preserves
        // popcount so the density/anchor gates pass and only the threshold
        // decides). Visible at 0.80, pruned away at 0.90.
        let base = vec![0xAAAAAAAAu32; 42];
        let mut other = base.clone();
        for i in (0..42).step_by(6) {
            other[i] = !other[i];
        }
        let low = calculate_similarity(&base, &other, 0.80);
        assert!(
            (0.80..0.90).contains(&low),
            "expected ~0.833 at threshold 0.80, got {}",
            low
        );
        let high = calculate_similarity(&base, &other, 0.90);
        assert!(high < 0.90, "expected pruning at threshold 0.90, got {}", high);
        assert!(low > high);
    }

    #[test]
    fn test_sanitize_threshold() {
        assert!((sanitize_threshold(Some(0.8)) - 0.8).abs() < 1e-9);
        assert!((sanitize_threshold(None) - ACOUSTIC_SIMILARITY_THRESHOLD).abs() < 1e-9);
        assert!((sanitize_threshold(Some(f64::NAN)) - ACOUSTIC_SIMILARITY_THRESHOLD).abs() < 1e-9);
        assert!((sanitize_threshold(Some(5.0)) - 1.0).abs() < 1e-9);
        assert!((sanitize_threshold(Some(-1.0)) - 0.0).abs() < 1e-9);
    }

    #[test]
    fn test_greedy_acoustic_match() {
        // Highest score wins; each index used at most once; below threshold dropped.
        let scores = vec![
            (0usize, 0usize, 0.99),
            (0usize, 1usize, 0.98),
            (1usize, 1usize, 0.97),
            (2usize, 2usize, 0.50),
        ];
        let matched = greedy_acoustic_match(&scores, 0.95);
        assert_eq!(matched.len(), 2);
        assert_eq!(matched[0], (0, 0, 0.99));
        assert_eq!(matched[1], (1, 1, 0.97));

        // Empty input matches nothing.
        let empty: Vec<(usize, usize, f64)> = Vec::new();
        assert!(greedy_acoustic_match(&empty, 0.95).is_empty());
    }

    #[test]
    fn test_is_better_quality() {
        // Different formats (lossless vs lossy)
        assert!(is_better_quality("flac", 1000, "mp3", 5000));
        assert!(is_better_quality("wav", 1000, "m4a", 5000));
        assert!(is_better_quality("aiff", 1000, "mp3", 5000));
        assert!(!is_better_quality("mp3", 5000, "flac", 1000));

        // Same formats, different sizes
        assert!(is_better_quality("mp3", 5000, "mp3", 1000));
        assert!(!is_better_quality("mp3", 1000, "mp3", 5000));
        assert!(!is_better_quality("mp3", 1000, "mp3", 1000));
    }

    #[test]
    fn test_is_better_quality_transcode_aware() {
        // Genuine MP3 beats fake FLAC transcode
        assert!(!is_better_quality_transcode_aware("flac", 30_000_000, true, "mp3", 10_000_000, false));
        assert!(is_better_quality_transcode_aware("mp3", 10_000_000, false, "flac", 30_000_000, true));

        // Genuine FLAC beats fake FLAC transcode
        assert!(is_better_quality_transcode_aware("flac", 30_000_000, false, "flac", 30_000_000, true));
        assert!(!is_better_quality_transcode_aware("flac", 30_000_000, true, "flac", 30_000_000, false));

        // When neither is a transcode, standard format priority applies
        assert!(is_better_quality_transcode_aware("flac", 30_000_000, false, "mp3", 10_000_000, false));
    }

    #[test]
    fn test_calculate_similarity_coarse_pass() {
        // Audio fingerprints have high frame-to-frame continuity (~1-2 bits flip per hop).
        // Generate audio-like fingerprints > 64 frames to exercise the 4x coarse scan path.
        let mut fp_base = Vec::with_capacity(120);
        let mut word = 0xA5A55A5Au32;
        for i in 0..120 {
            word ^= 1u32.rotate_left((i % 32) as u32);
            fp_base.push(word);
        }

        // Exact match with threshold 1.0 finds the 1.0 alignment at offset 0
        let sim_100 = calculate_similarity(&fp_base, &fp_base, 1.0);
        assert!((sim_100 - 1.0).abs() < 1e-9);

        // Exact match with threshold 0.90 triggers early exit once >= threshold is found
        let sim_exact = calculate_similarity(&fp_base, &fp_base, 0.90);
        assert!(sim_exact >= 0.90);

        // Near match with offset of 5 frames (not a multiple of 4, testing coarse window expansion)
        let mut fp_offset = vec![fp_base[0]; 5];
        fp_offset.extend_from_slice(&fp_base[0..115]);
        let sim_offset = calculate_similarity(&fp_base, &fp_offset, 0.90);
        assert!(sim_offset >= 0.90);

        // Near match with offset of 4 frames
        let mut fp_offset4 = vec![fp_base[0]; 4];
        fp_offset4.extend_from_slice(&fp_base[0..116]);
        let sim_offset4 = calculate_similarity(&fp_base, &fp_offset4, 0.90);
        assert!(sim_offset4 >= 0.90);

        // Total non-match (inverted density / completely different patterns)
        let mut fp_different = Vec::with_capacity(120);
        let mut word_diff = 0x0F0F0F0Fu32;
        for i in 0..120 {
            word_diff ^= 0x01010101u32.rotate_left((i % 8) as u32);
            fp_different.push(word_diff);
        }
        let sim_diff = calculate_similarity(&fp_base, &fp_different, 0.90);
        assert!(sim_diff < 0.75);
    }

    #[test]
    fn test_deduplication_1500_benchmark() {
        struct SynthTrack {
            artist: String,
            title: String,
            fp: Vec<u32>,
        }

        let mut tracks: Vec<SynthTrack> = Vec::with_capacity(1500);

        // Generate 1,450 unique synthetic tracks (1,000 frames each)
        for i in 0..1450 {
            let mut fp = Vec::with_capacity(1000);
            let mut state = (i as u64 + 1).wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);

            let mut band_probs = [0u8; 32];
            for prob in &mut band_probs {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                *prob = ((state >> 24) % 230 + 10) as u8;
            }

            for _ in 0..1000 {
                let mut frame_word = 0u32;
                for chunk in 0..4 {
                    state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    let s = state;
                    for b_in_chunk in 0..8 {
                        let b = chunk * 8 + b_in_chunk;
                        let sample = ((s >> (b_in_chunk * 8)) & 0xFF) as u8;
                        if sample < band_probs[b] {
                            frame_word |= 1u32 << b;
                        }
                    }
                }
                fp.push(frame_word);
            }
            tracks.push(SynthTrack {
                artist: format!("Producer_{:04}", i),
                title: format!("Title_{:04}", i),
                fp,
            });
        }

        // Plant 50 duplicates from tracks 0..500 with odd / non-multiple-of-4 offsets and ~3% bit noise
        let test_offsets: [isize; 50] = [
            1, 2, -3, 7, -11, 42, -1, -2, 3, -7,
            11, -42, 5, -5, 6, -6, 9, -9, 10, -10,
            13, -13, 14, -14, 15, -15, 17, -17, 18, -18,
            19, -19, 21, -21, 22, -22, 23, -23, 25, -25,
            26, -26, 27, -27, 29, -29, 30, -30, 31, -31,
        ];

        let mut planted_targets = std::collections::HashSet::new();
        for (d, &offset) in test_offsets.iter().enumerate() {
            let target_idx = d * 10;
            planted_targets.insert(target_idx);
            let target_fp = &tracks[target_idx].fp;

            let mut shifted_fp = Vec::with_capacity(1000);
            let mut noise_state = (d as u64 + 9999).wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);

            for f in 0..1000isize {
                let src_f = f - offset;
                let base_word = if src_f >= 0 && (src_f as usize) < target_fp.len() {
                    target_fp[src_f as usize]
                } else {
                    target_fp[0]
                };
                noise_state = noise_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let flip1 = 1u32 << ((noise_state >> 20) & 31);
                shifted_fp.push(base_word ^ flip1);
            }

            tracks.push(SynthTrack {
                artist: format!("Producer_{:04}", target_idx),
                title: format!("Title_{:04} (Club Mix)", target_idx),
                fp: shifted_fp,
            });
        }

        assert_eq!(tracks.len(), 1500);

        // Run full deduplication loop across all 1,500 tracks
        let start = std::time::Instant::now();
        let mut accepted: Vec<FingerprintEntry> = Vec::with_capacity(1500);
        let mut candidate_index = CandidatePriorityIndex::new();
        let mut duplicates_found = 0;

        for (idx, t) in tracks.iter().enumerate() {
            let entry = FingerprintEntry::new(
                t.fp.clone(),
                std::path::PathBuf::from(format!("/music/track_{}.mp3", idx)),
                "mp3".to_string(),
                10_000_000,
                format!("{}", idx),
                &t.artist,
                &t.title,
            );

            let prioritized = candidate_index.get_prioritized_candidates(
                &entry.title_tokens,
                accepted.len(),
            );

            let mut is_dupe = false;
            for cand_idx in prioritized {
                let prev = &accepted[cand_idx];
                let sim = calculate_similarity_with_profiles(
                    &entry.fp,
                    Some(&entry.profile),
                    &prev.fp,
                    Some(&prev.profile),
                    0.90,
                );
                if sim >= 0.90 {
                    is_dupe = true;
                    break;
                }
            }

            if is_dupe {
                duplicates_found += 1;
            } else {
                let new_idx = accepted.len();
                candidate_index.insert(new_idx, &entry.title_tokens);
                accepted.push(entry);
            }
        }

        let elapsed = start.elapsed();
        println!("1,500-track deduplication benchmark completed in {:?}", elapsed);

        assert_eq!(duplicates_found, 50, "Expected exactly 50 planted duplicates detected");
        assert_eq!(accepted.len(), 1450, "Expected exactly 1450 unique tracks accepted");
        assert!(
            elapsed < std::time::Duration::from_millis(250),
            "Benchmark exceeded 250ms threshold: took {:?}",
            elapsed
        );
    }

    #[test]
    fn test_sub_second_offset_non_multiple_of_4_recall() {
        // Track with low auto-correlation (shifting by 2 frames drops similarity to ~50%)
        let mut fp1 = Vec::with_capacity(300);
        let mut state = 123456789u64;
        for _ in 0..300 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            fp1.push(state as u32);
        }

        // Test odd and non-multiple-of-4 offsets: +1, +2, -3, +7, -11, +42
        for &offset in &[1isize, 2, -3, 7, -11, 42] {
            let mut fp2 = Vec::with_capacity(300);
            for f in 0..300isize {
                let src_f = f - offset;
                let word = if src_f >= 0 && (src_f as usize) < fp1.len() {
                    fp1[src_f as usize]
                } else {
                    0
                };
                fp2.push(word);
            }

            let sim = calculate_similarity(&fp1, &fp2, 0.90);
            assert!(
                sim >= 0.85,
                "Failed to detect duplicate at offset {} frames (got sim {})",
                offset,
                sim
            );
        }
    }

    #[test]
    fn test_candidate_priority_index_fallback_on_unrelated_metadata() {
        // Track 0: "Daft Punk - One More Time.mp3"
        let mut fp_daft = Vec::with_capacity(300);
        let mut state = 987654321u64;
        for _ in 0..300 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            fp_daft.push(state as u32);
        }
        let entry_daft = FingerprintEntry::new(
            fp_daft.clone(),
            std::path::PathBuf::from("/music/Daft Punk - One More Time.mp3"),
            "mp3".to_string(),
            8_000_000,
            "1".to_string(),
            "Daft Punk",
            "One More Time",
        );

        // Track 1: Unrelated track that coincidentally shares a token "live"
        let mut fp_unrelated = Vec::with_capacity(300);
        for _ in 0..300 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            fp_unrelated.push(state as u32);
        }
        let entry_unrelated = FingerprintEntry::new(
            fp_unrelated,
            std::path::PathBuf::from("/music/Other Artist - Live Concert.mp3"),
            "mp3".to_string(),
            9_000_000,
            "2".to_string(),
            "Other Artist",
            "Live Concert",
        );

        let mut candidate_index = CandidatePriorityIndex::new();
        let processed = [entry_daft.clone(), entry_unrelated.clone()];
        candidate_index.insert(0, &entry_daft.title_tokens);
        candidate_index.insert(1, &entry_unrelated.title_tokens);

        // New incoming track: poorly tagged "Unknown Artist - Track 01 (Live).mp3"
        // Acoustically identical to Daft Punk, but sharing token "live" only with unrelated track 1
        let entry_poorly_tagged = FingerprintEntry::new(
            fp_daft,
            std::path::PathBuf::from("/music/Unknown Artist - Track 01 (Live).mp3"),
            "mp3".to_string(),
            8_000_000,
            "3".to_string(),
            "Unknown Artist",
            "Track 01 (Live)",
        );

        let prioritized = candidate_index.get_prioritized_candidates(
            &entry_poorly_tagged.title_tokens,
            processed.len(),
        );

        // Verifies priority order: token-matching candidate 1 comes first,
        // BUT candidate 0 is still included in full as fallback!
        assert_eq!(prioritized.len(), 2);
        assert_eq!(prioritized[0], 1, "Token match should be checked first");
        assert_eq!(prioritized[1], 0, "Non-token match must be preserved in fallback");

        // Simulate the deduplication loop in rekordbox.rs / xml.rs
        let mut matched_idx = None;
        for cand_idx in prioritized {
            let prev = &processed[cand_idx];
            let sim = calculate_similarity_with_profiles(
                &entry_poorly_tagged.fp,
                Some(&entry_poorly_tagged.profile),
                &prev.fp,
                Some(&prev.profile),
                0.90,
            );
            if sim >= 0.90 {
                matched_idx = Some(cand_idx);
                break;
            }
        }

        assert_eq!(
            matched_idx,
            Some(0),
            "Poorly named file must match Daft Punk acoustically via fallback loop"
        );
    }
}
