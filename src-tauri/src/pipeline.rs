use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use tauri::Emitter;
use tokio::sync::mpsc;

use crate::ledger::{load_ledger, save_ledger, FileEntry, Ledger};
use crate::python_rpc::PythonBridge;
use crate::scanner::{get_bitrate, init_ledger};
use crate::similarity::{compare_audio_files, get_ffmpeg_path, get_fpcalc_path, get_ffprobe_path};

pub fn sanitize_filename_part(part: &str) -> String {
    let forbidden = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let clean: String = part.chars().filter(|c| !forbidden.contains(c)).collect();
    let trimmed = clean.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "Unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn get_local_date_string() -> String {
    let output = std::process::Command::new("date")
        .arg("+%Y-%m-%d")
        .output();
    if let Ok(out) = output {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    "2026-10-15".to_string()
}

fn get_log_timestamp() -> String {
    let output = std::process::Command::new("date")
        .arg("+%Y-%m-%d %H:%M:%S")
        .output();
    if let Ok(out) = output {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    "2026-10-15 12:00:00".to_string()
}

fn write_session_log(root_path: &Path, action: &str, message: &str) {
    let date_str = get_local_date_string();
    let log_path = root_path.join(format!(".crateup-log-{}.txt", date_str));
    let timestamp = get_log_timestamp();
    let action_tag = format!("[{}]", action);
    let line = format!("[{}] {:<17}{}\n", timestamp, action_tag, message);
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
}

async fn throttle_random() {
    let delay_ms = rand::thread_rng().gen_range(3000..=7000);
    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
}

pub fn should_skip_deezer_max(rel_path: &str, output_format: &str, entry: &FileEntry) -> bool {
    if entry.deezer_origin != Some(true) {
        return false;
    }

    let ext = Path::new(rel_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let is_lossless = matches!(ext.as_str(), "flac" | "wav" | "aiff" | "aif");
    let is_target_lossless = matches!(output_format.to_lowercase().as_str(), "flac" | "aiff" | "wav");

    if is_target_lossless {
        is_lossless
    } else if is_lossless {
        true
    } else {
        entry.original_bitrate.map(|b| b >= 320).unwrap_or(false)
    }
}

struct ReusedDownload {
    staged_abs: PathBuf,
    proxy_abs: Option<PathBuf>,
    #[allow(dead_code)]
    artist: Option<String>,
    #[allow(dead_code)]
    title: Option<String>,
}

fn find_existing_staged_download(
    ledger: &Ledger,
    deezer_id: u64,
    root_path: &Path,
) -> Option<ReusedDownload> {
    for entry in ledger.files.values() {
        if entry.deezer_id == Some(deezer_id) && entry.status == "downloaded" {
            if let Some(ref sp) = entry.staged_path {
                let candidate = PathBuf::from(sp);
                let abs = if candidate.is_absolute() {
                    candidate
                } else {
                    root_path.join(sp)
                };
                if abs.exists() {
                    let proxy = entry.proxy_path.as_ref().map(|pp| {
                        let p = PathBuf::from(pp);
                        if p.is_absolute() { p } else { root_path.join(pp) }
                    }).filter(|p| p.exists());
                    return Some(ReusedDownload {
                        staged_abs: abs,
                        proxy_abs: proxy,
                        artist: entry.artist.clone(),
                        title: entry.title.clone(),
                    });
                }
            }
        }
    }
    None
}

// Lane items
struct Lane2Item {
    rel_path: String,
    abs_path: PathBuf,
    deezer_id: u64,
    artist: String,
    title: String,
}

struct Lane3Item {
    rel_path: String,
    original_abs: PathBuf,
    staged_abs: PathBuf,
    proxy_path: Option<String>,
    deezer_id: u64,
    staged_bitrate: Option<u32>,
    artist: String,
    title: String,
}

pub async fn run_pipeline(
    app: tauri::AppHandle,
    root_path_str: String,
    output_format: String,
    file_list: Option<Vec<String>>,
    skip_high_quality: bool,
    skip_deezer_max: bool,
    cancelled: Arc<AtomicBool>,
) {
    let root_path = PathBuf::from(&root_path_str);
    let log_emit = {
        let app = app.clone();
        move |msg: &str| {
            let now = get_log_timestamp();
            let line = format!("[{}] [PIPELINE] {}\n", now, msg);
            eprint!("{}", line);
            let _ = app.emit("pipeline-log", serde_json::json!({ "line": line }));
        }
    };

    log_emit(&format!(
        "Starting pipeline for root: {}, format: {}",
        root_path.display(),
        output_format
    ));

    // 1. Initialize ledger
    let ledger = match init_ledger(&app, &root_path, &output_format, file_list) {
        Ok(l) => l,
        Err(e) => {
            log_emit(&format!("Scanner error: {}", e));
            let _ = app.emit("pipeline-done", -1);
            return;
        }
    };

    // 2. Spawn Python bridge
    let bridge = match PythonBridge::spawn(&app).await {
        Ok(b) => b,
        Err(e) => {
            log_emit(&format!("Failed to start Python bridge: {}", e));
            let _ = app.emit("pipeline-done", -1);
            return;
        }
    };

    let fpcalc_path = get_fpcalc_path(&app);
    let ffmpeg_path = get_ffmpeg_path(&app);
    let ffprobe_path = get_ffprobe_path(&app);

    // 3. Channels for Lane 1 -> Lane 2 -> Lane 3
    let (tx_lane2, mut rx_lane2) = mpsc::channel::<Lane2Item>(16);
    let (tx_lane3, mut rx_lane3) = mpsc::channel::<Lane3Item>(16);

    let pending_files: Vec<String> = ledger
        .files
        .iter()
        .filter(|(_, e)| e.status == "pending")
        .map(|(k, _)| k.clone())
        .collect();

    log_emit(&format!(
        "Found {} pending files out of {} total files.",
        pending_files.len(),
        ledger.files.len()
    ));

    // Lane 3 Worker Task: Computes similarity, MD5, and waveform peaks
    let lane3_handle = {
        let root_path = root_path.clone();
        let log_emit = log_emit.clone();
        let cancelled = cancelled.clone();
        let ffmpeg_path = ffmpeg_path.clone();
        let fpcalc_path = fpcalc_path.clone();

        tokio::spawn(async move {
            while let Some(item) = rx_lane3.recv().await {
                if cancelled.load(Ordering::Relaxed) {
                    break;
                }

                log_emit(&format!(
                    "Calculating similarity between original and replacement for {}...",
                    item.rel_path
                ));

                // 1. Acoustic similarity
                let comp = compare_audio_files(
                    &fpcalc_path,
                    &ffmpeg_path,
                    &item.original_abs,
                    &item.staged_abs,
                    None,
                );
                let similarity_score = comp.similarity;
                let bit_identical = Some(comp.bit_identical);
                let similarity_error = comp.error.clone();

                if let Some(score) = similarity_score {
                    let pct = format!("{:.1}%", score * 100.0);
                    log_emit(&format!("Similarity: {} (Bit-Identical: {})", pct, comp.bit_identical));
                } else if let Some(ref e) = comp.error {
                    log_emit(&format!("Similarity check notice: {}", e));
                }

                // 2. Waveform peaks & Audio Analysis (peaks, RMS loudness, 1ms envelope for lead-in offset)
                let orig_analysis = crate::waveform::compute_audio_analysis(&ffmpeg_path, &item.original_abs, 256);
                let staged_analysis = crate::waveform::compute_audio_analysis(&ffmpeg_path, &item.staged_abs, 256);

                let orig_peaks = orig_analysis.as_ref().map(|a| a.peaks.clone());
                let staged_peaks = staged_analysis.as_ref().map(|a| a.peaks.clone());
                let orig_rms = orig_analysis.as_ref().map(|a| a.rms);
                let staged_rms = staged_analysis.as_ref().map(|a| a.rms);

                let offset_ms = match (&orig_analysis, &staged_analysis) {
                    (Some(o), Some(s)) => crate::waveform::compute_lead_in_offset(
                        &o.envelope_1ms,
                        &s.envelope_1ms,
                        similarity_score,
                        bit_identical,
                    ),
                    _ => None,
                };

                let is_transcode = crate::waveform::check_is_transcode(&ffmpeg_path, &item.original_abs);

                // 3. Write into ledger
                if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                    if let Some(entry) = cur_ledger.files.get_mut(&item.rel_path) {
                        entry.status = "downloaded".to_string();
                        entry.deezer_id = Some(item.deezer_id);
                        entry.staged_path = Some(item.staged_abs.to_string_lossy().to_string());
                        entry.staged_bitrate = item.staged_bitrate;
                        entry.proxy_path = item.proxy_path;
                        entry.similarity_score = similarity_score;
                        entry.similarity_error = similarity_error;
                        entry.audio_bit_identical = bit_identical;
                        entry.artist = Some(item.artist.clone());
                        entry.title = Some(item.title.clone());
                        entry.peaks = orig_peaks;
                        entry.staged_peaks = staged_peaks;
                        entry.orig_rms = orig_rms;
                        entry.staged_rms = staged_rms;
                        entry.offset_ms = offset_ms;
                        if is_transcode == Some(true) {
                            entry.is_transcode = Some(true);
                        }
                    }
                    let _ = save_ledger(&root_path, &cur_ledger);
                }

                write_session_log(
                    &root_path,
                    "IDENTIFIED",
                    &format!("{} - {}  →  Deezer ID {}", item.artist, item.title, item.deezer_id),
                );
                log_emit(&format!(
                    "Successfully staged replacement for {} -> {}",
                    item.rel_path,
                    item.staged_abs.display()
                ));
            }
        })
    };

    // Lane 2 Worker Task: Downloads replacement audio from Deezer (or reuses duplicate)
    let tx_lane3_for_lane2 = tx_lane3.clone();
    let lane2_handle = {
        let bridge = bridge.clone();
        let root_path = root_path.clone();
        let output_format = output_format.clone();
        let log_emit = log_emit.clone();
        let cancelled = cancelled.clone();
        let tx_lane3 = tx_lane3_for_lane2;

        tokio::spawn(async move {
            while let Some(item) = rx_lane2.recv().await {
                if cancelled.load(Ordering::Relaxed) {
                    break;
                }

                let cur_ledger = load_ledger(&root_path).unwrap_or(None).unwrap_or_else(|| Ledger {
                    session_id: "tmp".to_string(),
                    root_path: root_path.to_string_lossy().to_string(),
                    output_format: output_format.clone(),
                    ledger_version: 1,
                    files: std::collections::BTreeMap::new(),
                    extra: serde_json::Map::new(),
                });

                let ext = Path::new(&item.rel_path)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                let rel_base = item.rel_path.trim_start_matches('/');
                let base_without_ext = if !ext.is_empty() && rel_base.ends_with(ext) {
                    &rel_base[..rel_base.len() - ext.len() - 1]
                } else {
                    rel_base
                };

                let safe_base = base_without_ext
                    .split('/')
                    .filter(|s| *s != ".." && *s != ".")
                    .collect::<Vec<_>>()
                    .join("/");
                let relative_staged = format!("crateup-staging/{}.{}", safe_base, output_format);
                let staged_abs = root_path.join(&relative_staged);

                if let Some(parent) = staged_abs.parent() {
                    let _ = fs::create_dir_all(parent);
                }

                // Check §3.4 Duplicate Reuse
                let existing = find_existing_staged_download(&cur_ledger, item.deezer_id, &root_path);
                let (final_staged_abs, final_proxy_path) = if let Some(reused) = existing {
                    log_emit(&format!(
                        "Track already downloaded in session (Deezer ID: {}). Reusing staged file.",
                        item.deezer_id
                    ));
                    write_session_log(
                        &root_path,
                        "DUPLICATE",
                        &format!(
                            "{} - {}  →  reused staged download from Deezer ID {}",
                            item.artist, item.title, item.deezer_id
                        ),
                    );
                    if reused.staged_abs != staged_abs {
                        let _ = fs::copy(&reused.staged_abs, &staged_abs);
                    }
                    let reused_proxy = if let Some(p) = reused.proxy_abs {
                        let target_proxy = staged_abs.with_extension("proxy.mp3");
                        if p != target_proxy {
                            let _ = fs::copy(&p, &target_proxy);
                        }
                        Some(target_proxy.to_string_lossy().to_string())
                    } else {
                        None
                    };
                    (staged_abs, reused_proxy)
                } else {
                    throttle_random().await;
                    match bridge
                        .download(
                            item.deezer_id,
                            &output_format,
                            &staged_abs.to_string_lossy(),
                        )
                        .await
                    {
                        Ok(dl) => {
                            let downloaded_path = PathBuf::from(dl.staged_path);
                            // Rename to Artist - Title
                            let clean_artist = sanitize_filename_part(&item.artist);
                            let clean_title = sanitize_filename_part(&item.title);
                            let combined = format!("{} - {}", clean_artist, clean_title);
                            let final_name = format!("{}.{}", combined, output_format);
                            let final_target = staged_abs
                                .parent()
                                .unwrap_or(&root_path)
                                .join(final_name);

                            let actual_staged = if downloaded_path != final_target {
                                match fs::rename(&downloaded_path, &final_target) {
                                    Ok(_) => final_target,
                                    Err(_) => downloaded_path,
                                }
                            } else {
                                downloaded_path
                            };

                            let mut proxy_str = None;
                            if let Some(pp) = dl.proxy_path {
                                let orig_proxy = PathBuf::from(pp);
                                let candidate_proxy = staged_abs
                                    .parent()
                                    .unwrap_or(&root_path)
                                    .join(format!("{}.proxy.mp3", combined));
                                if orig_proxy.exists() && orig_proxy != candidate_proxy {
                                    let _ = fs::rename(&orig_proxy, &candidate_proxy);
                                    proxy_str = Some(candidate_proxy.to_string_lossy().to_string());
                                } else {
                                    proxy_str = Some(orig_proxy.to_string_lossy().to_string());
                                }
                            }

                            (actual_staged, proxy_str)
                        }
                        Err(e) => {
                            log_emit(&format!("Download failed for {}: {}", item.rel_path, e));
                            if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                                if let Some(entry) = cur_ledger.files.get_mut(&item.rel_path) {
                                    entry.status = "download_failed".to_string();
                                }
                                let _ = save_ledger(&root_path, &cur_ledger);
                            }
                            continue;
                        }
                    }
                };

                let staged_bitrate = get_bitrate(&ffprobe_path, &final_staged_abs);

                let _ = tx_lane3
                    .send(Lane3Item {
                        rel_path: item.rel_path,
                        original_abs: item.abs_path,
                        staged_abs: final_staged_abs,
                        proxy_path: final_proxy_path,
                        deezer_id: item.deezer_id,
                        staged_bitrate,
                        artist: item.artist,
                        title: item.title,
                    })
                    .await;
            }
        })
    };

    // Lane 1 Producer Loop: Shazam Fingerprinting
    let mut consecutive_network_errors = 0u32;

    for rel_path in pending_files {
        if cancelled.load(Ordering::Relaxed) {
            log_emit("Pipeline cancelled by user.");
            break;
        }

        let entry = match ledger.files.get(&rel_path) {
            Some(e) => e.clone(),
            None => continue,
        };

        let abs_path = entry
            .original_abs_path
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let sub = rel_path.trim_start_matches('/');
                root_path.join(sub)
            });

        if skip_high_quality {
            let ext = Path::new(&rel_path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let is_lossless = matches!(ext.as_str(), "flac" | "wav" | "aiff" | "aif");
            let is_high_bitrate = entry.original_bitrate.map(|b| b >= 320).unwrap_or(false);

            if is_lossless || is_high_bitrate {
                let is_fake = crate::waveform::check_is_transcode(&ffmpeg_path, &abs_path).unwrap_or(false);
                if is_fake {
                    log_emit(&format!("Fake lossless/transcode detected for {}: proceeding with upgrade", rel_path));
                    if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                        if let Some(e) = cur_ledger.files.get_mut(&rel_path) {
                            e.is_transcode = Some(true);
                        }
                        let _ = save_ledger(&root_path, &cur_ledger);
                    }
                } else {
                    let reason = if is_lossless {
                        "lossless".to_string()
                    } else {
                        format!("{} kbps", entry.original_bitrate.unwrap_or(0))
                    };
                    log_emit(&format!("Skipping high quality track: {} ({})", rel_path, reason));
                    if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                        if let Some(e) = cur_ledger.files.get_mut(&rel_path) {
                            e.status = "skipped".to_string();
                        }
                        let _ = save_ledger(&root_path, &cur_ledger);
                    }
                    continue;
                }
            }
        }

        if skip_deezer_max && should_skip_deezer_max(&rel_path, &output_format, &entry) {
            let is_fake = crate::waveform::check_is_transcode(&ffmpeg_path, &abs_path).unwrap_or(false);
            if is_fake {
                log_emit(&format!("Fake lossless/transcode detected for {}: proceeding with upgrade", rel_path));
                if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                    if let Some(e) = cur_ledger.files.get_mut(&rel_path) {
                        e.is_transcode = Some(true);
                    }
                    let _ = save_ledger(&root_path, &cur_ledger);
                }
            } else {
                log_emit(&format!(
                    "Skipping track already at max Deezer quality: {}",
                    rel_path
                ));
                if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                    if let Some(e) = cur_ledger.files.get_mut(&rel_path) {
                        e.status = "skipped".to_string();
                    }
                    let _ = save_ledger(&root_path, &cur_ledger);
                }
                continue;
            }
        }

        log_emit(&format!("Processing: {}", rel_path));
        throttle_random().await;

        let fp_res = bridge.fingerprint(&abs_path.to_string_lossy()).await;
        match fp_res {
            Ok(fp) => {
                consecutive_network_errors = 0;
                let artist = fp.artist.unwrap_or_else(|| "Unknown Artist".to_string());
                let title = fp.title.unwrap_or_else(|| "Unknown Title".to_string());

                if let Some(id) = fp.deezer_id {
                    log_emit(&format!(
                        "Track identified on Deezer: \"{} - {}\" (ID: {})",
                        artist, title, id
                    ));

                    if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                        if let Some(e) = cur_ledger.files.get_mut(&rel_path) {
                            e.artist = Some(artist.clone());
                            e.title = Some(title.clone());
                            e.deezer_id = Some(id);
                        }
                        let _ = save_ledger(&root_path, &cur_ledger);
                    }

                    let _ = tx_lane2
                        .send(Lane2Item {
                            rel_path: rel_path.clone(),
                            abs_path: abs_path.clone(),
                            deezer_id: id,
                            artist,
                            title,
                        })
                        .await;
                } else {
                    log_emit(&format!(
                        "Track identified but not found on Deezer: \"{} - {}\"",
                        artist, title
                    ));
                    write_session_log(
                        &root_path,
                        "NOT ON DEEZER",
                        &format!("{} - {}", artist, title),
                    );
                    if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                        if let Some(e) = cur_ledger.files.get_mut(&rel_path) {
                            e.artist = Some(artist);
                            e.title = Some(title);
                            e.status = "not_on_deezer".to_string();
                        }
                        let _ = save_ledger(&root_path, &cur_ledger);
                    }
                }
            }
            Err(e) => {
                let is_network = e.contains("network_error")
                    || e.contains("ENOTFOUND")
                    || e.contains("ECONNRESET")
                    || e.contains("ETIMEDOUT")
                    || e.contains("socket hang up");

                if is_network {
                    consecutive_network_errors += 1;
                    log_emit(&format!(
                        "Network connection error while fingerprinting {}: {}",
                        rel_path, e
                    ));
                    // Keep status pending to avoid false unidentified
                    if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                        if let Some(entry) = cur_ledger.files.get_mut(&rel_path) {
                            entry.status = "pending".to_string();
                        }
                        let _ = save_ledger(&root_path, &cur_ledger);
                    }
                    if consecutive_network_errors >= 3 {
                        log_emit(&format!(
                            "Consecutive network errors reached threshold ({}). Stopping pipeline to preserve track status.",
                            consecutive_network_errors
                        ));
                        break;
                    }
                    continue;
                }

                consecutive_network_errors = 0;
                log_emit(&format!("Fingerprinting failed for {}: {}", rel_path, e));
                write_session_log(&root_path, "UNIDENTIFIED", &rel_path);
                if let Ok(Some(mut cur_ledger)) = load_ledger(&root_path) {
                    if let Some(entry) = cur_ledger.files.get_mut(&rel_path) {
                        entry.status = "unidentified".to_string();
                    }
                    let _ = save_ledger(&root_path, &cur_ledger);
                }
            }
        }
    }

    // Drop Lane 2 sender so Lane 2 worker finishes when drained
    drop(tx_lane2);
    let _ = lane2_handle.await;

    // Drop Lane 3 sender so Lane 3 worker finishes when drained
    drop(tx_lane3);
    let _ = lane3_handle.await;

    bridge.stop().await;
    log_emit("Pipeline run complete.");
    let _ = app.emit("pipeline-done", 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_filename_part() {
        assert_eq!(sanitize_filename_part("AC/DC"), "ACDC");
        assert_eq!(sanitize_filename_part("What?"), "What");
        assert_eq!(sanitize_filename_part("...Song..."), "Song");
        assert_eq!(sanitize_filename_part(""), "Unknown");
    }

    #[test]
    fn test_should_skip_deezer_max() {
        let entry_deezer_flac = FileEntry {
            deezer_origin: Some(true),
            original_bitrate: Some(900),
            ..Default::default()
        };
        assert!(should_skip_deezer_max("/track.flac", "flac", &entry_deezer_flac));
        assert!(should_skip_deezer_max("/track.flac", "mp3", &entry_deezer_flac));

        let entry_deezer_128 = FileEntry {
            deezer_origin: Some(true),
            original_bitrate: Some(128),
            ..Default::default()
        };
        assert!(!should_skip_deezer_max("/track.mp3", "mp3", &entry_deezer_128));

        let entry_local = FileEntry {
            deezer_origin: Some(false),
            original_bitrate: Some(320),
            ..Default::default()
        };
        assert!(!should_skip_deezer_max("/track.mp3", "mp3", &entry_local));
    }
}
