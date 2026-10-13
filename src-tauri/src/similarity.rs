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

/// Sliding-window bitwise-alignment score in [0, 1].
///
/// `threshold` drives both the per-offset prune bound and the early exit:
/// the function returns the first offset scoring >= threshold, so results
/// at/above threshold are decision-exact. Below threshold the returned
/// value is a lower bound (losing offsets are abandoned, not finished) —
/// callers must only compare it against the same threshold.
pub fn calculate_similarity(fp1: &[u32], fp2: &[u32], threshold: f64) -> f64 {
    if fp1.is_empty() || fp2.is_empty() {
        return 0.0;
    }
    
    let len1 = fp1.len();
    let len2 = fp2.len();
    let max_len = std::cmp::max(len1, len2);
    let min_len = std::cmp::min(len1, len2);
    // If lengths differ by more than 20%, skip comparing (only for files of substantial length > 60 frames ~5s)
    if max_len > 60 && max_len - min_len > (max_len * 20) / 100 {
        return 0.0;
    }
    
    let (a, b) = if len1 <= len2 {
        (fp1, fp2)
    } else {
        (fp2, fp1)
    };
    
    // Trick 1: Global Bit-Weight (Hamming Weight) Density Filter with safe/loose 25% margin
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
    
    let start_offset = -n + min_overlap;
    let end_offset = m - min_overlap;

    let mut max_sim = 0.0;
    for d in start_offset..=end_offset {
        let start_a = std::cmp::max(0, -d);
        let end_a = std::cmp::min(n, m - d);
        let k = end_a - start_a;
        if k < min_overlap {
            continue;
        }
        
        let k_u = k as usize;
        let threshold_bits = ((k_u as f64) * threshold * 32.0) as usize;
        let mut matching_bits = 0;
        let mut possible_failed = false;
        
        for (count, i) in (start_a..end_a).enumerate() {
            let x = a[i as usize];
            let y = b[(i + d) as usize];
            matching_bits += 32 - (x ^ y).count_ones() as usize;
            
            if count % 16 == 0 {
                let remaining_max = (k_u - 1 - count) * 32;
                if matching_bits + remaining_max < threshold_bits {
                    possible_failed = true;
                    break;
                }
            }
        }
        
        if !possible_failed {
            let sim = (matching_bits as f64) / ((k * 32) as f64);
            if sim > max_sim {
                max_sim = sim;
                // Trick 4: Early Exit on Match
                if max_sim >= threshold {
                    return max_sim;
                }
            }
        }
    }
    
    max_sim
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
}
