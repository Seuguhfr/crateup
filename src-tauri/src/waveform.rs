use std::path::Path;

#[derive(Debug, Clone)]
pub struct AudioAnalysis {
    pub peaks: Vec<f32>,
    pub rms: f32,
    pub envelope_1ms: Vec<f32>,
}

pub fn analyze_audio_pcm(bytes: &[u8], num_peaks: usize) -> Option<AudioAnalysis> {
    let sample_count = bytes.len() / 4;
    if sample_count == 0 {
        return None;
    }

    let target_peaks = if num_peaks == 0 { 256 } else { num_peaks };
    let bucket_size = (sample_count as f64 / target_peaks as f64).max(1.0);

    let mut peaks = Vec::with_capacity(target_peaks);
    let mut global_max: f32 = 0.0;
    let mut sum_sq: f64 = 0.0;

    // 1 ms at 8000 Hz = 8 samples. Capture first 30 seconds (up to 30,000 ms = 240,000 samples)
    let max_ms = 30000.min(sample_count / 8);
    let mut envelope_1ms = Vec::with_capacity(max_ms);

    for m in 0..max_ms {
        let base = m * 8;
        let mut sum_abs = 0.0f32;
        for s in 0..8 {
            let offset = (base + s) * 4;
            let sample_bytes: [u8; 4] = [
                bytes[offset],
                bytes[offset + 1],
                bytes[offset + 2],
                bytes[offset + 3],
            ];
            let val = f32::from_le_bytes(sample_bytes).abs();
            sum_abs += val;
        }
        envelope_1ms.push(sum_abs / 8.0);
    }

    for i in 0..target_peaks {
        let start_sample = (i as f64 * bucket_size).floor() as usize;
        let end_sample = (((i + 1) as f64 * bucket_size).ceil() as usize).min(sample_count);

        let mut bucket_max: f32 = 0.0;
        for s in start_sample..end_sample {
            let offset = s * 4;
            if offset + 4 <= bytes.len() {
                let sample_bytes: [u8; 4] = [
                    bytes[offset],
                    bytes[offset + 1],
                    bytes[offset + 2],
                    bytes[offset + 3],
                ];
                let val = f32::from_le_bytes(sample_bytes);
                let abs_val = val.abs();
                if abs_val > bucket_max && abs_val.is_finite() {
                    bucket_max = abs_val;
                }
                if val.is_finite() {
                    sum_sq += (val as f64) * (val as f64);
                }
            }
        }

        if bucket_max > global_max {
            global_max = bucket_max;
        }
        peaks.push(bucket_max);
    }

    let rms = ((sum_sq / sample_count as f64).sqrt() as f32 * 10000.0).round() / 10000.0;

    // Normalize so highest peak is 1.0, quantized to 3 decimal places
    let scale = if global_max > 0.0001 {
        1.0 / global_max
    } else {
        1.0
    };

    let quantized: Vec<f32> = peaks
        .into_iter()
        .map(|p| ((p * scale * 1000.0).round() / 1000.0).clamp(0.0, 1.0))
        .collect();

    Some(AudioAnalysis {
        peaks: quantized,
        rms,
        envelope_1ms,
    })
}

pub fn compute_audio_analysis(ffmpeg_path: &Path, file_path: &Path, num_peaks: usize) -> Option<AudioAnalysis> {
    let output = std::process::Command::new(ffmpeg_path)
        .args([
            "-v",
            "quiet",
            "-i",
        ])
        .arg(file_path)
        .args([
            "-ac",
            "1",
            "-filter:a",
            "aresample=8000",
            "-f",
            "f32le",
            "-",
        ])
        .output()
        .ok()?;

    if !output.status.success() || output.stdout.len() < 4 {
        return None;
    }

    analyze_audio_pcm(&output.stdout, num_peaks)
}

#[allow(dead_code)]
pub fn compute_waveform_peaks(ffmpeg_path: &Path, file_path: &Path, num_peaks: usize) -> Option<Vec<f32>> {
    compute_audio_analysis(ffmpeg_path, file_path, num_peaks).map(|a| a.peaks)
}

#[allow(dead_code)]
pub fn quantize_pcm_bytes(bytes: &[u8], num_peaks: usize) -> Option<Vec<f32>> {
    analyze_audio_pcm(bytes, num_peaks).map(|a| a.peaks)
}

/// Computes millisecond lead-in offset between original and staged audio:
/// offset_ms = t_staged_ms - t_orig_ms
/// Positive (+45 ms) means beat drops 45 ms later in Staged than Original.
/// Capped at |offset_ms| <= 2000.
pub fn compute_lead_in_offset(
    orig_env: &[f32],
    staged_env: &[f32],
    similarity_score: Option<f64>,
    bit_identical: Option<bool>,
) -> Option<i32> {
    if bit_identical == Some(true) {
        return Some(0);
    }
    // Safety guardrail: only compute when similarity is valid
    if similarity_score.unwrap_or(0.0) < 0.85 {
        return None;
    }

    let n = orig_env.len().min(staged_env.len()).min(30000);
    if n < 2000 {
        return None;
    }

    let max_lag = 2000;
    let mut best_lag = 0i32;
    let mut max_corr = -1.0f64;

    // Search lags tau in [-2000, 2000]
    for tau in -max_lag..=max_lag {
        let (orig_start, staged_start) = if tau < 0 {
            ((-tau) as usize, 0usize)
        } else {
            (0usize, tau as usize)
        };

        let len = (n - orig_start).min(n - staged_start);
        if len < 1000 {
            continue;
        }

        let mut dot = 0.0f64;
        let mut norm_orig = 0.0f64;
        let mut norm_staged = 0.0f64;

        for i in 0..len {
            let o = orig_env[orig_start + i] as f64;
            let s = staged_env[staged_start + i] as f64;
            dot += o * s;
            norm_orig += o * o;
            norm_staged += s * s;
        }

        let denom = (norm_orig * norm_staged).sqrt();
        if denom > 1e-6 {
            let corr = dot / denom;
            if corr > max_corr {
                max_corr = corr;
                best_lag = tau;
            }
        }
    }

    // Correlation threshold to ensure real alignment, not silence noise
    if max_corr >= 0.35 && best_lag.abs() <= 2000 {
        Some(best_lag)
    } else {
        None
    }
}

/// Spek Guard: Checks if a high-bitrate / lossless file is a fake upscaled transcode.
/// Compares energy above 16.5 kHz to mid-band energy (2.5 kHz - 10 kHz).
/// Returns Some(true) if a brickwall lowpass cutoff is detected.
pub fn check_is_transcode(ffmpeg_path: &Path, file_path: &Path) -> Option<bool> {
    let output = std::process::Command::new(ffmpeg_path)
        .args([
            "-v",
            "quiet",
            "-ss",
            "20",
            "-t",
            "10",
            "-i",
        ])
        .arg(file_path)
        .args([
            "-ac",
            "1",
            "-ar",
            "44100",
            "-f",
            "f32le",
            "-",
        ])
        .output()
        .ok()?;

    if !output.status.success() || output.stdout.len() < 44100 * 4 {
        // Retry without -ss if file is shorter than 20s
        let retry_output = std::process::Command::new(ffmpeg_path)
            .args([
                "-v",
                "quiet",
                "-t",
                "10",
                "-i",
            ])
            .arg(file_path)
            .args([
                "-ac",
                "1",
                "-ar",
                "44100",
                "-f",
                "f32le",
                "-",
            ])
            .output()
            .ok()?;

        if !retry_output.status.success() || retry_output.stdout.len() < 44100 * 4 {
            return None;
        }
        return evaluate_spectral_cutoff(&retry_output.stdout);
    }

    evaluate_spectral_cutoff(&output.stdout)
}

pub fn evaluate_spectral_cutoff(bytes: &[u8]) -> Option<bool> {
    let sample_count = bytes.len() / 4;
    if sample_count < 44100 {
        return None;
    }

    // 1. High-Pass Filter at 16.5 kHz (Butterworth 2nd-order, fs=44100)
    let fs = 44100.0f64;
    let f_hp = 16500.0f64;
    let omega_hp = 2.0 * std::f64::consts::PI * f_hp / fs;
    let q_hp = 1.0 / 2.0f64.sqrt();
    let alpha_hp = omega_hp.sin() / (2.0 * q_hp);
    let cos_hp = omega_hp.cos();

    let a0_hp = 1.0 + alpha_hp;
    let b0_hp = (1.0 + cos_hp) / 2.0 / a0_hp;
    let b1_hp = -(1.0 + cos_hp) / a0_hp;
    let b2_hp = (1.0 + cos_hp) / 2.0 / a0_hp;
    let a1_hp = -2.0 * cos_hp / a0_hp;
    let a2_hp = (1.0 - alpha_hp) / a0_hp;

    // 2. Band-Pass Filter at 5.0 kHz, Q=1.0 (covering ~2.5 - 10 kHz, fs=44100)
    let f_bp = 5000.0f64;
    let omega_bp = 2.0 * std::f64::consts::PI * f_bp / fs;
    let q_bp = 1.0f64;
    let alpha_bp = omega_bp.sin() / (2.0 * q_bp);
    let cos_bp = omega_bp.cos();

    let a0_bp = 1.0 + alpha_bp;
    let b0_bp = alpha_bp / a0_bp;
    let b1_bp = 0.0f64;
    let b2_bp = -alpha_bp / a0_bp;
    let a1_bp = -2.0 * cos_bp / a0_bp;
    let a2_bp = (1.0 - alpha_bp) / a0_bp;

    let mut x1_hp = 0.0f64;
    let mut x2_hp = 0.0f64;
    let mut y1_hp = 0.0f64;
    let mut y2_hp = 0.0f64;
    let mut energy_hp = 0.0f64;

    let mut x1_bp = 0.0f64;
    let mut x2_bp = 0.0f64;
    let mut y1_bp = 0.0f64;
    let mut y2_bp = 0.0f64;
    let mut energy_bp = 0.0f64;

    for i in 0..sample_count {
        let offset = i * 4;
        let b = [bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]];
        let x = f32::from_le_bytes(b) as f64;
        if !x.is_finite() { continue; }

        // Filter HP
        let y_hp = b0_hp * x + b1_hp * x1_hp + b2_hp * x2_hp - a1_hp * y1_hp - a2_hp * y2_hp;
        x2_hp = x1_hp;
        x1_hp = x;
        y2_hp = y1_hp;
        y1_hp = y_hp;
        energy_hp += y_hp * y_hp;

        // Filter BP
        let y_bp = b0_bp * x + b1_bp * x1_bp + b2_bp * x2_bp - a1_bp * y1_bp - a2_bp * y2_bp;
        x2_bp = x1_bp;
        x1_bp = x;
        y2_bp = y1_bp;
        y1_bp = y_bp;
        energy_bp += y_bp * y_bp;
    }

    if energy_bp < 1e-4 {
        // Track too quiet or silent in mid-range to reliably assess cutoff
        return Some(false);
    }

    let ratio = energy_hp / energy_bp;
    // Brickwall lowpass at ~16 kHz drops energy above 16.5 kHz by > 40 dB (ratio < 0.00005)
    Some(ratio < 0.00005)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_peak_quantization_and_normalization() {
        let raw_samples: Vec<f32> = vec![0.0, 0.25, 0.5, 0.75, 1.0, 0.5, 0.25, 0.0];
        let mut bytes = Vec::new();
        for s in raw_samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }

        let quantized = quantize_pcm_bytes(&bytes, 4).expect("should compute peaks");
        assert_eq!(quantized.len(), 4);
        assert!((quantized.iter().cloned().fold(0.0f32, f32::max) - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_lead_in_offset_cross_correlation() {
        // Create an envelope with a distinctive beat spike at t = 1000ms
        let mut orig = vec![0.05f32; 5000];
        orig[1000] = 1.0;
        orig[1001] = 0.8;
        orig[1002] = 0.6;

        // Staged has the same spike at t = 1045ms (dropped 45ms later)
        let mut staged = vec![0.05f32; 5000];
        staged[1045] = 1.0;
        staged[1046] = 0.8;
        staged[1047] = 0.6;

        let offset = compute_lead_in_offset(&orig, &staged, Some(0.95), Some(false));
        assert_eq!(offset, Some(45));

        // Test identical audio returns 0
        let zero_offset = compute_lead_in_offset(&orig, &staged, None, Some(true));
        assert_eq!(zero_offset, Some(0));

        // Test low similarity returns None
        let mismatch = compute_lead_in_offset(&orig, &staged, Some(0.60), Some(false));
        assert_eq!(mismatch, None);
    }

    #[test]
    fn test_spek_guard_spectral_cutoff() {
        let fs = 44100.0f64;
        let n_samples = 44100; // 1 second

        // 1. Genuine wideband signal: 1 kHz + 18 kHz sine
        let mut wideband_bytes = Vec::new();
        for i in 0..n_samples {
            let t = i as f64 / fs;
            let val = (2.0 * std::f64::consts::PI * 1000.0 * t).sin() * 0.5
                + (2.0 * std::f64::consts::PI * 18000.0 * t).sin() * 0.2;
            wideband_bytes.extend_from_slice(&(val as f32).to_le_bytes());
        }
        assert_eq!(evaluate_spectral_cutoff(&wideband_bytes), Some(false));

        // 2. Brickwalled transcode: only 1 kHz sine (zero content above 16.5 kHz)
        let mut transcode_bytes = Vec::new();
        for i in 0..n_samples {
            let t = i as f64 / fs;
            let val = (2.0 * std::f64::consts::PI * 1000.0 * t).sin() * 0.5;
            transcode_bytes.extend_from_slice(&(val as f32).to_le_bytes());
        }
        assert_eq!(evaluate_spectral_cutoff(&transcode_bytes), Some(true));
    }
}
