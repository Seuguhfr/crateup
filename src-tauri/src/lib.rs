use tauri::Manager;
use tauri::Emitter;

pub(crate) struct PipelineManager(pub(crate) std::sync::Arc<std::sync::atomic::AtomicBool>);

mod fingerprint_cache;
mod rekordbox;
mod similarity;
mod xml;
mod audit;
pub(crate) mod ledger;
pub(crate) mod deezer;
pub(crate) mod python_rpc;
pub(crate) mod scanner;
pub(crate) mod waveform;
pub(crate) mod commit;
pub(crate) mod pipeline;

use commit::CommitResult;
use similarity::{
    calculate_similarity, get_audio_fingerprint, get_fpcalc_path, greedy_acoustic_match,
    sanitize_threshold,
};

pub(crate) fn safe_delete_file(path: &std::path::Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    match trash::delete(path) {
        Ok(_) => Ok(()),
        Err(e) => {
            std::fs::remove_file(path).map_err(|rem_err| {
                format!("Failed to move to trash ({}) and delete failed ({})", e, rem_err)
            })
        }
    }
}

pub(crate) fn safe_move_file(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    if let Err(err) = std::fs::rename(src, dst) {
        let is_cross_dev = err.kind() == std::io::ErrorKind::CrossesDevices
            || err.raw_os_error() == Some(18);
        if is_cross_dev {
            std::fs::copy(src, dst)?;
            let _ = std::fs::remove_file(src);
            return Ok(());
        }
        return Err(err);
    }
    Ok(())
}

pub(crate) fn atomic_write_file(target_path: &std::path::Path, content: &str) -> Result<(), String> {
    let parent = target_path.parent().unwrap_or(std::path::Path::new("."));
    if !parent.exists() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file_stem = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_path = parent.join(format!("{}.tmp.{}.{}", file_stem, std::process::id(), nanos));
    std::fs::write(&tmp_path, content).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp_path, target_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to atomically rename file: {}", e));
    }
    Ok(())
}

#[tauri::command]
fn select_directory(default_dir: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(ref dir) = default_dir {
        if !dir.is_empty() {
            dialog = dialog.set_directory(std::path::Path::new(dir));
        }
    }
    dialog
        .pick_folder()
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn select_output_directory(default_dir: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(ref dir) = default_dir {
        dialog = dialog.set_directory(std::path::Path::new(dir));
    }
    dialog.pick_folder().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn select_xml_file() -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("Rekordbox XML", &["xml"])
        .pick_file()
        .map(|p| p.to_string_lossy().into_owned())
}


#[tauri::command]
fn check_ledger_exists(root_path: String) -> bool {
    let p = std::path::Path::new(&root_path).join(".crateup-progress.json");
    p.exists()
}

#[tauri::command]
fn read_ledger_file(ledger_path: String) -> Result<String, String> {
    let mut resolved = std::path::PathBuf::from(&ledger_path);
    if !resolved.exists() {
        if let Some(parent) = resolved.parent() {
            let filename = resolved.file_name().and_then(|f| f.to_str()).unwrap_or("");
            if filename == ".crateup-progress-dev.json" {
                let fallback = parent.join(".crateup-progress.json");
                if fallback.exists() {
                    resolved = fallback;
                }
            } else if filename == ".crateup-progress.json" {
                let fallback = parent.join(".crateup-progress-dev.json");
                if fallback.exists() {
                    resolved = fallback;
                }
            }
        }
    }
    let content = std::fs::read_to_string(&resolved).map_err(|e| e.to_string())?;
    let mut val: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    
    if let Some(rp) = val.get("root_path").and_then(|r| r.as_str()) {
        let old_staging = std::path::Path::new(rp).join(".crateup-staging");
        let new_staging = std::path::Path::new(rp).join("crateup-staging");
        if old_staging.exists() && !new_staging.exists() {
            let _ = std::fs::rename(&old_staging, &new_staging);
        }
    }
    
    let mut modified = false;
    // Stamp the schema version on pre-version ledgers (current shape is v1).
    if let Some(obj) = val.as_object_mut() {
        if obj.get("ledger_version").and_then(|v| v.as_u64()).is_none() {
            obj.insert("ledger_version".to_string(), serde_json::Value::from(1u64));
            modified = true;
        }
    }
    if let Some(files) = val.get_mut("files").and_then(|f| f.as_object_mut()) {
        for (_rel_path, file_entry) in files.iter_mut() {
            if let Some(entry_obj) = file_entry.as_object_mut() {
                if let Some(staged_path) = entry_obj.get_mut("staged_path") {
                    if let Some(s) = staged_path.as_str() {
                        if s.starts_with(".crateup-staging/") {
                            let new_s = s.replace(".crateup-staging/", "crateup-staging/");
                            *staged_path = serde_json::Value::String(new_s);
                            modified = true;
                        }
                    }
                }
                if let Some(proxy_path) = entry_obj.get_mut("proxy_path") {
                    if let Some(s) = proxy_path.as_str() {
                        if s.starts_with(".crateup-staging/") {
                            let new_s = s.replace(".crateup-staging/", "crateup-staging/");
                            *proxy_path = serde_json::Value::String(new_s);
                            modified = true;
                        }
                    }
                }
            }
        }
    }
    
    if modified {
        let updated = serde_json::to_string_pretty(&val).map_err(|e| e.to_string())?;
        atomic_write_file(std::path::Path::new(&ledger_path), &updated)?;
        Ok(updated)
    } else {
        Ok(content)
    }
}

#[tauri::command]
fn write_ledger_file(ledger_path: String, content: String) -> Result<(), String> {
    atomic_write_file(std::path::Path::new(&ledger_path), &content)
}

#[tauri::command]
fn get_node_path() -> Result<String, String> {
    Ok("native".to_string())
}

#[tauri::command]
fn start_pipeline(
    app: tauri::AppHandle,
    state: tauri::State<'_, PipelineManager>,
    root_path: String,
    output_format: String,
    file_list: Option<Vec<String>>,
    skip_high_quality: Option<bool>,
    skip_deezer_max: Option<bool>,
) {
    let cancelled = state.0.clone();
    cancelled.store(false, std::sync::atomic::Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        pipeline::run_pipeline(
            app,
            root_path,
            output_format,
            file_list,
            skip_high_quality.unwrap_or(false),
            skip_deezer_max.unwrap_or(false),
            cancelled,
        ).await;
    });
}

#[tauri::command]
async fn cancel_pipeline(state: tauri::State<'_, PipelineManager>) -> Result<bool, String> {
    state.0.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
fn save_ledger_decision(
    ledger_path: String,
    relative_path: String,
    decision: String,
) -> Result<(), String> {
    let content = std::fs::read_to_string(&ledger_path).map_err(|e| e.to_string())?;
    let mut ledger_json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    
    if let Some(files) = ledger_json.get_mut("files").and_then(|f| f.as_object_mut()) {
        if let Some(file_entry) = files.get_mut(&relative_path).and_then(|e| e.as_object_mut()) {
            file_entry.insert("decision".to_string(), serde_json::Value::String(decision));
        } else {
            return Err(format!("File relative path '{}' not found in ledger files", relative_path));
        }
    } else {
        return Err("Ledger is missing 'files' object".to_string());
    }
    
    let updated = serde_json::to_string_pretty(&ledger_json).map_err(|e| e.to_string())?;
    atomic_write_file(std::path::Path::new(&ledger_path), &updated)?;
    
    Ok(())
}

#[tauri::command]
async fn commit_changes(
    app: tauri::AppHandle,
    ledger_path: String,
    decisions: std::collections::HashMap<String, String>,
    output_path: String,
    output_strategy: String,
) -> Result<CommitResult, String> {
    commit::commit_changes(&app, &ledger_path, decisions, &output_path, &output_strategy)
}

#[tauri::command]
fn get_file_size(path: String) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

#[tauri::command]
fn check_file_exists(path: String) -> bool {
    let p = std::path::Path::new(&path);
    if p.exists() {
        return true;
    }
    if let Some(parent) = p.parent() {
        let filename = p.file_name().and_then(|f| f.to_str()).unwrap_or("");
        if filename == ".crateup-progress-dev.json" {
            return parent.join(".crateup-progress.json").exists();
        } else if filename == ".crateup-progress.json" {
            return parent.join(".crateup-progress-dev.json").exists();
        }
    }
    false
}

#[tauri::command]
fn show_confirm_dialog(title: String, message: String) -> bool {
    rfd::MessageDialog::new()
        .set_title(&title)
        .set_description(&message)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show() == rfd::MessageDialogResult::Yes
}

#[tauri::command]
fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_track_by_id(
    app: tauri::AppHandle,
    root_path: String,
    output_format: String,
    relative_path: String,
    deezer_id: u64,
    artist: String,
    title: String,
) -> Result<String, String> {
    let bridge = python_rpc::PythonBridge::spawn(&app).await?;
    let root = std::path::PathBuf::from(&root_path);

    let ext = std::path::Path::new(&relative_path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let rel_base = relative_path.trim_start_matches('/');
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
    let staged_abs = root.join(&relative_staged);

    if let Some(parent) = staged_abs.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut matched_artist = artist;
    let mut matched_title = title;

    if matched_artist.is_empty() || matched_artist == "Unknown Artist" || matched_title.is_empty() || matched_title == "Unknown Title" {
        if let Ok((a_opt, t_opt, _)) = deezer::fetch_deezer_metadata(deezer_id as i64).await {
            if let Some(a) = a_opt { matched_artist = a; }
            if let Some(t) = t_opt { matched_title = t; }
        }
    }

    let dl_result = bridge.download(deezer_id, &output_format, &staged_abs.to_string_lossy()).await;
    bridge.stop().await;

    let dl = dl_result?;

    let downloaded_path = std::path::PathBuf::from(dl.staged_path);
    let clean_artist = pipeline::sanitize_filename_part(&matched_artist);
    let clean_title = pipeline::sanitize_filename_part(&matched_title);
    let combined = format!("{} - {}", clean_artist, clean_title);
    let final_name = format!("{}.{}", combined, output_format);
    let final_target = staged_abs.parent().unwrap_or(&root).join(&final_name);

    let actual_staged = if downloaded_path != final_target {
        match std::fs::rename(&downloaded_path, &final_target) {
            Ok(_) => final_target,
            Err(_) => downloaded_path,
        }
    } else {
        downloaded_path
    };

    let mut proxy_str = None;
    if let Some(pp) = dl.proxy_path {
        let orig_proxy = std::path::PathBuf::from(pp);
        let candidate_proxy = staged_abs.parent().unwrap_or(&root).join(format!("{}.proxy.mp3", combined));
        if orig_proxy.exists() && orig_proxy != candidate_proxy {
            let _ = std::fs::rename(&orig_proxy, &candidate_proxy);
            proxy_str = Some(candidate_proxy.to_string_lossy().to_string());
        } else {
            proxy_str = Some(orig_proxy.to_string_lossy().to_string());
        }
    }

    let fpcalc_path = similarity::get_fpcalc_path(&app);
    let ffmpeg_path = similarity::get_ffmpeg_path(&app);
    let ffprobe_path = similarity::get_ffprobe_path(&app);

    let original_abs = root.join(relative_path.trim_start_matches('/'));

    let comp = similarity::compare_audio_files(
        &fpcalc_path,
        &ffmpeg_path,
        &original_abs,
        &actual_staged,
        None,
    );
    let similarity_score = comp.similarity;
    let bit_identical = Some(comp.bit_identical);
    let similarity_error = comp.error;

    let orig_analysis = waveform::compute_audio_analysis(&ffmpeg_path, &original_abs, 256);
    let staged_analysis = waveform::compute_audio_analysis(&ffmpeg_path, &actual_staged, 256);

    let orig_peaks = orig_analysis.as_ref().map(|a| a.peaks.clone());
    let staged_peaks = staged_analysis.as_ref().map(|a| a.peaks.clone());
    let orig_rms = orig_analysis.as_ref().map(|a| a.rms);
    let staged_rms = staged_analysis.as_ref().map(|a| a.rms);

    let offset_ms = match (&orig_analysis, &staged_analysis) {
        (Some(o), Some(s)) => waveform::compute_lead_in_offset(
            &o.envelope_1ms,
            &s.envelope_1ms,
            similarity_score,
            bit_identical,
        ),
        _ => None,
    };

    let is_transcode = waveform::check_is_transcode(&ffmpeg_path, &original_abs);
    let staged_bitrate = scanner::get_bitrate(&ffprobe_path, &actual_staged);

    if let Ok(Some(mut cur_ledger)) = ledger::load_ledger(&root) {
        if let Some(entry) = cur_ledger.files.get_mut(&relative_path) {
            entry.status = "downloaded".to_string();
            entry.deezer_id = Some(deezer_id);
            entry.staged_path = Some(actual_staged.to_string_lossy().to_string());
            entry.proxy_path = proxy_str.clone();
            entry.similarity_score = similarity_score;
            entry.similarity_error = similarity_error;
            entry.audio_bit_identical = bit_identical;
            entry.staged_bitrate = staged_bitrate;
            entry.artist = Some(matched_artist);
            entry.title = Some(matched_title);
            entry.peaks = orig_peaks;
            entry.staged_peaks = staged_peaks;
            entry.orig_rms = orig_rms;
            entry.staged_rms = staged_rms;
            entry.offset_ms = offset_ms;
            if is_transcode == Some(true) {
                entry.is_transcode = Some(true);
            }
        }
        let _ = ledger::save_ledger(&root, &cur_ledger);
    }

    let res = serde_json::json!({
        "status": "downloaded",
        "deezer_id": deezer_id,
        "staged_path": actual_staged.to_string_lossy().to_string(),
        "proxy_path": proxy_str,
        "similarity_score": similarity_score,
        "audio_bit_identical": bit_identical,
    });

    Ok(res.to_string())
}

#[tauri::command]
async fn identify_track(
    app: tauri::AppHandle,
    root_path: String,
    relative_path: String,
) -> Result<String, String> {
    let bridge = python_rpc::PythonBridge::spawn(&app).await?;
    let root = std::path::PathBuf::from(&root_path);
    let mut abs_path = root.join(relative_path.trim_start_matches('/'));

    if let Ok(Some(ledger)) = ledger::load_ledger(&root) {
        if let Some(entry) = ledger.files.get(&relative_path) {
            if let Some(ref orig) = entry.original_abs_path {
                abs_path = std::path::PathBuf::from(orig);
            }
        }
    }

    let result = bridge.fingerprint(&abs_path.to_string_lossy()).await?;
    bridge.stop().await;

    // Update ledger on disk if identified
    if result.artist.is_some() || result.title.is_some() {
        if let Ok(Some(mut cur_ledger)) = ledger::load_ledger(&root) {
            if let Some(entry) = cur_ledger.files.get_mut(&relative_path) {
                entry.artist = result.artist.clone();
                entry.title = result.title.clone();
                if let Some(id) = result.deezer_id {
                    entry.deezer_id = Some(id);
                } else {
                    entry.status = "not_on_deezer".to_string();
                }
            }
            let _ = ledger::save_ledger(&root, &cur_ledger);
        }
    }

    let json = serde_json::to_string(&result).map_err(|e| e.to_string())?;
    Ok(json)
}

#[tauri::command]
async fn reset_session(
    state: tauri::State<'_, PipelineManager>,
    root_path: String,
    is_session_dir: bool,
) -> Result<(), String> {
    state.0.store(true, std::sync::atomic::Ordering::Relaxed);
    ledger::clear_ledger_cache();
    let root = std::path::Path::new(&root_path);
    if !root.exists() {
        return Ok(());
    }
    
    if is_session_dir {
        std::fs::remove_dir_all(root).map_err(|e| e.to_string())?;
    } else {
        // 1. Delete root_path/crateup-staging/ recursively if it exists
        let staging_dir = root.join("crateup-staging");
        if staging_dir.exists() {
            std::fs::remove_dir_all(&staging_dir).map_err(|e| e.to_string())?;
        }
        
        // 2. Delete root_path/.crateup-progress.json and .crateup-progress-dev.json if they exist
        let progress_file = root.join(".crateup-progress.json");
        if progress_file.exists() {
            std::fs::remove_file(&progress_file).map_err(|e| e.to_string())?;
        }
        
        let progress_dev_file = root.join(".crateup-progress-dev.json");
        if progress_dev_file.exists() {
            std::fs::remove_file(&progress_dev_file).map_err(|e| e.to_string())?;
        }
        
        // 3. Delete root_path/.crateup-log.json (or equivalent) if exists
        let log_file = root.join(".crateup-log.json");
        if log_file.exists() {
            std::fs::remove_file(&log_file).map_err(|e| e.to_string())?;
        }
        
        // Also scan the folder for other logs like `.crateup-log-*.txt` and delete them
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    if let Some(filename) = path.file_name().and_then(|f| f.to_str()) {
                        if filename.starts_with(".crateup-log") {
                            let _ = std::fs::remove_file(&path);
                        }
                    }
                }
            }
        }
    }
    
    Ok(())
}

fn get_project_arl_path() -> Option<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(parent) = manifest_dir.parent() {
            let p = parent.join(".arl");
            if p.parent().map(|d| d.exists()).unwrap_or(false) {
                return Some(p);
            }
        }
    }
    None
}

#[tauri::command]
fn get_arl(app: tauri::AppHandle) -> String {
    // 1. Try reading project .arl file (dev/debug only)
    if let Some(project_arl_path) = get_project_arl_path() {
        if project_arl_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&project_arl_path) {
                let stripped = content.trim().to_string();
                if !stripped.is_empty() {
                    return stripped;
                }
            }
        }
    }

    // 2. Try reading ~/.config/deemix/.arl
    if let Ok(home) = app.path().home_dir() {
        let global_config = home.join(".config/deemix/.arl");
        if global_config.exists() {
            if let Ok(content) = std::fs::read_to_string(&global_config) {
                let stripped = content.trim().to_string();
                if !stripped.is_empty() {
                    return stripped;
                }
            }
        }

        let app_support_config = home.join("Library/Application Support/deemix/.arl");
        if app_support_config.exists() {
            if let Ok(content) = std::fs::read_to_string(&app_support_config) {
                let stripped = content.trim().to_string();
                if !stripped.is_empty() {
                    return stripped;
                }
            }
        }
    }

    "".to_string()
}

#[tauri::command]
fn save_arl(app: tauri::AppHandle, arl: String) -> Result<(), String> {
    let trimmed = arl.trim();

    // 1. Best-effort write to project .arl file in debug mode
    if let Some(project_arl_path) = get_project_arl_path() {
        let _ = std::fs::write(&project_arl_path, trimmed);
    }

    // 2. Write to ~/.config/deemix/.arl
    if let Ok(home) = app.path().home_dir() {
        let deemix_config = home.join(".config/deemix");
        if let Err(e) = std::fs::create_dir_all(&deemix_config) {
            eprintln!("[save_arl] Failed to create .config/deemix: {}", e);
        }
        let arl_file = deemix_config.join(".arl");
        if let Err(e) = std::fs::write(&arl_file, trimmed) {
            eprintln!("[save_arl] Failed to write to {}: {}", arl_file.display(), e);
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&arl_file, std::fs::Permissions::from_mode(0o600));
            }
        }

        // 3. Write to ~/Library/Application Support/deemix/.arl
        let app_support_deemix = home.join("Library/Application Support/deemix");
        if let Err(e) = std::fs::create_dir_all(&app_support_deemix) {
            eprintln!("[save_arl] Failed to create Library/Application Support/deemix: {}", e);
        }
        let arl_file_app_support = app_support_deemix.join(".arl");
        if let Err(e) = std::fs::write(&arl_file_app_support, trimmed) {
            eprintln!("[save_arl] Failed to write to {}: {}", arl_file_app_support.display(), e);
        } else {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&arl_file_app_support, std::fs::Permissions::from_mode(0o600));
            }
        }
    }

    Ok(())
}

pub use deezer::{ArlStatusResult, ResolvedDeezerTrack};

#[tauri::command]
async fn check_arl_status(
    app: tauri::AppHandle,
    token: Option<String>,
) -> Result<ArlStatusResult, String> {
    let effective_token = match token {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => get_arl(app.clone()),
    };

    deezer::validate_arl(&effective_token).await
}

#[tauri::command]
async fn resolve_deezer_link(
    _app: tauri::AppHandle,
    url: String,
) -> Result<ResolvedDeezerTrack, String> {
    deezer::resolve_deezer_link(&url, 5).await
}


#[derive(serde::Serialize, Clone)]
struct AcousticPair {
    a: String,
    b: String,
    score: f64,
}

#[derive(serde::Serialize, Clone)]
struct AcousticCompareResult {
    pairs: Vec<AcousticPair>,
    only_a: Vec<String>,
    only_b: Vec<String>,
    skipped: Vec<String>,
}

#[derive(serde::Serialize, Clone)]
struct CompareAcousticProgress {
    processed: usize,
    total: usize,
}


#[derive(serde::Serialize, Clone)]
struct FingerprintCacheInfo {
    entries: usize,
    bytes: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct EngineHealth {
    pub fpcalc_ok: bool,
    pub fpcalc_version: Option<String>,
    pub ffmpeg_ok: bool,
    pub ffmpeg_version: Option<String>,
    pub python_ok: bool,
    pub python_version: Option<String>,
    pub rekordbox_db_exists: bool,
    pub rekordbox_running: bool,
    pub rekordbox_db_path: String,
}

fn find_python_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("python-runtime").join("bin").join("python3");
        if p.exists() { return Some(p); }
        let p = resource_dir.join("_up_").join("python-runtime").join("bin").join("python3");
        if p.exists() { return Some(p); }
    }
    let dev_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent();
    if let Some(parent) = dev_root {
        let p = parent.join("python-runtime").join("bin").join("python3");
        if p.exists() { return Some(p); }
        let p = parent.join(".venv").join("bin").join("python3");
        if p.exists() { return Some(p); }
    }
    if let Ok(out) = std::process::Command::new("python3").arg("--version").output() {
        if out.status.success() {
            return Some(std::path::PathBuf::from("python3"));
        }
    }
    None
}

/// Query runtime dependency status and acoustic engine health for Settings.
#[tauri::command]
async fn check_engine_health(app: tauri::AppHandle) -> Result<EngineHealth, String> {
    let fpcalc_path = similarity::get_fpcalc_path(&app);
    let (fpcalc_ok, fpcalc_version) = match std::process::Command::new(&fpcalc_path).arg("-version").output() {
        Ok(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout).trim().lines().next().unwrap_or("").to_string();
            (true, Some(s))
        }
        _ => (false, None),
    };

    let ffmpeg_path = similarity::get_ffmpeg_path(&app);
    let (ffmpeg_ok, ffmpeg_version) = match std::process::Command::new(&ffmpeg_path).arg("-version").output() {
        Ok(out) if out.status.success() => {
            let s = String::from_utf8_lossy(&out.stdout).trim().lines().next().unwrap_or("").to_string();
            (true, Some(s))
        }
        _ => (false, None),
    };

    let py_path = find_python_path(&app);
    let (python_ok, python_version) = match py_path {
        Some(ref p) => match std::process::Command::new(p).arg("--version").output() {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8_lossy(&out.stdout).trim().lines().next().unwrap_or("").to_string();
                let ver = if s.is_empty() {
                    String::from_utf8_lossy(&out.stderr).trim().lines().next().unwrap_or("").to_string()
                } else {
                    s
                };
                (true, Some(ver))
            }
            _ => (false, None),
        },
        None => (false, None),
    };

    let rb_status = rekordbox::check_rekordbox_status().await?;

    Ok(EngineHealth {
        fpcalc_ok,
        fpcalc_version,
        ffmpeg_ok,
        ffmpeg_version,
        python_ok,
        python_version,
        rekordbox_db_exists: rb_status.db_exists,
        rekordbox_running: rb_status.running,
        rekordbox_db_path: rb_status.db_path,
    })
}

/// Inspect the persistent fingerprint cache (Settings → Storage).
#[tauri::command]
fn fingerprint_cache_info(app: tauri::AppHandle) -> FingerprintCacheInfo {
    let cache = fingerprint_cache::FingerprintCache::load(&app);
    FingerprintCacheInfo {
        entries: cache.len(),
        bytes: cache.bytes(),
    }
}

/// Clear the persistent fingerprint cache. Returns entries dropped.
#[tauri::command]
fn clear_fingerprint_cache(app: tauri::AppHandle) -> usize {
    let mut cache = fingerprint_cache::FingerprintCache::load(&app);
    cache.clear()
}

/// Fingerprint two track lists and pair same-song files across them.
/// Exact path duplicates resolve first (case-insensitive); the leftovers
/// are matched acoustically via fpcalc. Missing files are reported,
/// never fatal. `threshold` overrides the app-wide policy for this call.
#[tauri::command]
async fn compare_playlists_acoustic(
    window: tauri::Window,
    paths_a: Vec<String>,
    paths_b: Vec<String>,
    threshold: Option<f64>,
) -> Result<AcousticCompareResult, String> {
    fn norm(p: &str) -> String {
        p.trim().to_lowercase()
    }

    let threshold = sanitize_threshold(threshold);

    let set_b: std::collections::HashSet<String> =
        paths_b.iter().map(|p| norm(p)).collect();
    let mut seen_a = std::collections::HashSet::new();
    let mut rem_a: Vec<String> = Vec::new();
    for p in &paths_a {
        let k = norm(p);
        if !seen_a.insert(k.clone()) {
            continue;
        }
        if !set_b.contains(&k) {
            rem_a.push(p.clone());
        }
    }
    let set_a: std::collections::HashSet<String> =
        paths_a.iter().map(|p| norm(p)).collect();
    let mut seen_b = std::collections::HashSet::new();
    let mut rem_b: Vec<String> = Vec::new();
    for p in &paths_b {
        let k = norm(p);
        if !seen_b.insert(k.clone()) {
            continue;
        }
        if !set_a.contains(&k) {
            rem_b.push(p.clone());
        }
    }

    let mut skipped: Vec<String> = Vec::new();
    let mut live_a: Vec<String> = Vec::new();
    for p in rem_a {
        if std::path::Path::new(&p).exists() {
            live_a.push(p);
        } else {
            skipped.push(p);
        }
    }
    let mut live_b: Vec<String> = Vec::new();
    for p in rem_b {
        if std::path::Path::new(&p).exists() {
            live_b.push(p);
        } else {
            skipped.push(p);
        }
    }

    // Fingerprint everything left over, in parallel (cap 8, like ingestion).
    // Persistent cache first: repeat comparisons resolve instantly.
    let mut fp_cache = fingerprint_cache::FingerprintCache::load(window.app_handle());
    let jobs: Vec<(usize, usize, std::path::PathBuf)> = live_a
        .iter()
        .enumerate()
        .map(|(i, p)| (0usize, i, std::path::PathBuf::from(p)))
        .chain(
            live_b
                .iter()
                .enumerate()
                .map(|(i, p)| (1usize, i, std::path::PathBuf::from(p))),
        )
        .collect();
    let total = jobs.len();

    let mut fps_a: Vec<Option<Vec<u32>>> = vec![None; live_a.len()];
    let mut fps_b: Vec<Option<Vec<u32>>> = vec![None; live_b.len()];

    // Cache hits resolve without spawning; misses go to the pool below.
    let mut misses: Vec<(usize, usize, std::path::PathBuf)> = Vec::new();
    let mut completed = 0usize;
    for (side, idx, path) in jobs {
        if let Some(fp) = fp_cache.get(&path) {
            if side == 0 {
                fps_a[idx] = Some(fp);
            } else {
                fps_b[idx] = Some(fp);
            }
            completed += 1;
            let _ = window.emit(
                "compare-acoustic-progress",
                CompareAcousticProgress {
                    processed: completed,
                    total,
                },
            );
        } else {
            misses.push((side, idx, path));
        }
    }

    if !misses.is_empty() {
        let fpcalc_path = get_fpcalc_path(window.app_handle());
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        let mut tasks = Vec::new();
        for (side, idx, path) in misses {
            let fp_clone = fpcalc_path.clone();
            let sem_clone = sem.clone();
            tasks.push(tokio::spawn(async move {
                let _permit = sem_clone.acquire().await.unwrap();
                let fp = tokio::task::spawn_blocking(move || {
                    get_audio_fingerprint(&fp_clone, &path)
                })
                .await
                .ok()
                .flatten();
                (side, idx, fp)
            }));
        }
        for task in tasks {
            if let Ok((side, idx, fp)) = task.await {
                if let Some(ref fp_val) = fp {
                    let src = if side == 0 { &live_a[idx] } else { &live_b[idx] };
                    fp_cache.insert(std::path::Path::new(src), fp_val.clone());
                }
                if side == 0 {
                    fps_a[idx] = fp;
                } else {
                    fps_b[idx] = fp;
                }
            }
            completed += 1;
            let _ = window.emit(
                "compare-acoustic-progress",
                CompareAcousticProgress {
                    processed: completed,
                    total,
                },
            );
        }
        fp_cache.save();
    }

    let mut scores: Vec<(usize, usize, f64)> = Vec::new();
    for (ia, fa) in fps_a.iter().enumerate() {
        let fp_a = match fa {
            Some(fp) => fp,
            None => continue,
        };
        for (ib, fb) in fps_b.iter().enumerate() {
            if let Some(fp_b) = fb {
                scores.push((ia, ib, calculate_similarity(fp_a, fp_b, threshold)));
            }
        }
    }
    let matched = greedy_acoustic_match(&scores, threshold);

    let mut used_a = std::collections::HashSet::new();
    let mut used_b = std::collections::HashSet::new();
    let mut pairs: Vec<AcousticPair> = Vec::new();
    for (ia, ib, s) in matched {
        used_a.insert(ia);
        used_b.insert(ib);
        pairs.push(AcousticPair {
            a: live_a[ia].clone(),
            b: live_b[ib].clone(),
            score: (s * 100.0).round() / 100.0,
        });
    }
    pairs.sort_by(|x, y| {
        y.score
            .partial_cmp(&x.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let only_a: Vec<String> = live_a
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !used_a.contains(i))
        .map(|(_, p)| p)
        .collect();
    let only_b: Vec<String> = live_b
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !used_b.contains(i))
        .map(|(_, p)| p)
        .collect();

    Ok(AcousticCompareResult {
        pairs,
        only_a,
        only_b,
        skipped,
    })
}


#[tauri::command]
async fn open_directory(path: String) -> Result<(), String> {
    let path_clone = path.clone();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path_clone)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path_clone)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path_clone)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PipelineManager(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false))))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            select_directory,
            select_output_directory,
            select_xml_file,
            xml::get_xml_track_count,
            check_ledger_exists,
            read_ledger_file,
            write_ledger_file,
            get_node_path,
            start_pipeline,
            cancel_pipeline,
            save_ledger_decision,
            commit_changes,
            get_file_size,
            check_file_exists,
            xml::parse_playlists,
            xml::get_playlist_tracks,
            xml::get_folder_tracks,
            show_confirm_dialog,
            reset_session,
            get_app_data_dir,
            download_track_by_id,
            identify_track,
            get_arl,
            save_arl,
            check_arl_status,
            resolve_deezer_link,
            xml::parse_and_validate_xml,
            xml::execute_safe_clone,
            open_directory,
            check_engine_health,
            rekordbox::check_rekordbox_status,
            rekordbox::get_db_backups,
            rekordbox::list_rekordbox_backups,
            rekordbox::execute_backup_cleanup,
            rekordbox::execute_db_consolidation,
            rekordbox::rollback_to_latest_backup,
            rekordbox::rollback_to_backup,
            rekordbox::delete_db_backup,
            rekordbox::trash_superseded_files,
            xml::select_audio_files,
            xml::select_save_xml_file,
            xml::expand_audio_paths,
            xml::execute_playlist_ingestion,
            rekordbox::parse_playlists_from_db,
            rekordbox::get_playlist_tracks_from_db,
            rekordbox::get_folder_tracks_from_db,
            compare_playlists_acoustic,
            fingerprint_cache_info,
            clear_fingerprint_cache,
            rekordbox::update_rekordbox_db_directly,
            rekordbox::fix_rekordbox_db_duplicates,
            audit::audit_library,
            audit::audit_suggested_roots,
            audit::delete_audit_paths,
            audit::remove_empty_folders,
            xml::update_rekordbox_xml
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

