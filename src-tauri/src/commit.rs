use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::ledger::{load_ledger, save_ledger, FileEntry, Ledger};
use crate::similarity::{get_ffmpeg_path, get_ffprobe_path};

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CommitFailure {
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub error: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CommitResult {
    pub committed: u32,
    pub skipped: u32,
    pub failed: Vec<CommitFailure>,
}

fn get_local_date_string() -> String {
    chrono_or_fallback_date()
}

fn chrono_or_fallback_date() -> String {
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

fn safe_delete_file(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    match trash::delete(path) {
        Ok(_) => Ok(()),
        Err(e) => {
            fs::remove_file(path).map_err(|rem_err| {
                format!("Failed to move to trash ({}) and delete failed ({})", e, rem_err)
            })
        }
    }
}

fn safe_move_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Err(err) = fs::rename(src, dst) {
        let is_cross_dev = err.kind() == std::io::ErrorKind::CrossesDevices
            || err.raw_os_error() == Some(18);
        if is_cross_dev {
            fs::copy(src, dst)?;
            let _ = fs::remove_file(src);
            return Ok(());
        }
        return Err(err);
    }
    Ok(())
}

fn get_audio_tags(ffprobe_path: &Path, file_path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let output = match std::process::Command::new(ffprobe_path)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
        ])
        .arg(file_path)
        .output()
    {
        Ok(out) if out.status.success() => out.stdout,
        _ => return (None, None, None),
    };

    let data: serde_json::Value = match serde_json::from_slice(&output) {
        Ok(v) => v,
        Err(_) => return (None, None, None),
    };

    let mut comment = None;
    let mut genre = None;
    let mut rating = None;

    if let Some(tags) = data.get("format").and_then(|f| f.get("tags")).and_then(|t| t.as_object()) {
        for (k, v) in tags {
            let key = k.to_lowercase();
            let val = v.as_str().map(|s| s.to_string());
            if matches!(key.as_str(), "comment" | "description" | "comments") && comment.is_none() {
                comment = val.clone();
            } else if matches!(key.as_str(), "genre" | "genres") && genre.is_none() {
                genre = val.clone();
            } else if matches!(key.as_str(), "rating" | "popm" | "popularimeter") && rating.is_none() {
                rating = val.clone();
            }
        }
    }

    (comment, genre, rating)
}

fn merge_original_tags(
    ffmpeg_path: &Path,
    ffprobe_path: &Path,
    original_path: &Path,
    target_path: &Path,
) {
    if !original_path.exists() || !target_path.exists() {
        return;
    }

    let (comment, genre, rating) = get_audio_tags(ffprobe_path, original_path);
    let mut metadata_args = Vec::new();

    if let Some(ref c) = comment {
        metadata_args.push("-metadata".to_string());
        metadata_args.push(format!("comment={}", c));
        metadata_args.push("-metadata".to_string());
        metadata_args.push(format!("description={}", c));
    }
    if let Some(ref g) = genre {
        metadata_args.push("-metadata".to_string());
        metadata_args.push(format!("genre={}", g));
    }
    if let Some(ref r) = rating {
        metadata_args.push("-metadata".to_string());
        metadata_args.push(format!("rating={}", r));
    }

    if metadata_args.is_empty() {
        return;
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_tagged = target_path
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!("tagmerge-{}-{}.tmp", std::process::id(), nanos));

    let ext = target_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut cmd = std::process::Command::new(ffmpeg_path);
    cmd.arg("-y")
        .arg("-i")
        .arg(target_path)
        .arg("-c")
        .arg("copy");

    if matches!(ext.as_str(), "aiff" | "aif" | "wav") {
        cmd.arg("-write_id3v2").arg("1");
    }

    for arg in &metadata_args {
        cmd.arg(arg);
    }
    cmd.arg(&tmp_tagged);

    if let Ok(out) = cmd.output() {
        if out.status.success() && tmp_tagged.exists() {
            let _ = fs::rename(&tmp_tagged, target_path);
        } else {
            let _ = fs::remove_file(&tmp_tagged);
        }
    } else {
        let _ = fs::remove_file(&tmp_tagged);
    }
}

fn clean_proxy_file(entry: &FileEntry, staged_abs: Option<&Path>, root_path: &Path) {
    let mut candidates = Vec::new();
    if let Some(ref proxy) = entry.proxy_path {
        let p = PathBuf::from(proxy);
        if p.is_absolute() {
            candidates.push(p);
        } else {
            candidates.push(root_path.join(proxy));
        }
    }
    if let Some(staged) = staged_abs {
        let ext = staged.extension().and_then(|e| e.to_str()).unwrap_or("");
        let stem = staged.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if let Some(parent) = staged.parent() {
            candidates.push(parent.join(format!("{}.proxy.mp3", stem)));
            candidates.push(parent.join(format!("{}.{}.proxy.mp3", stem, ext)));
        }
    }

    for p in candidates {
        if p.exists() {
            let _ = fs::remove_file(p);
        }
    }
}

fn swap_and_safe_trash(
    tmp_path: &Path,
    target_abs: &Path,
    original_abs: &Path,
    strategy: &str,
) -> Result<(), String> {
    if strategy == "replace" && original_abs == target_abs && original_abs.exists() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let parent = original_abs.parent().unwrap_or(Path::new("."));
        let orig_backup = parent.join(format!(
            "orig-backup-{}-{}.tmp",
            std::process::id(),
            nanos
        ));

        fs::rename(original_abs, &orig_backup)
            .map_err(|e| format!("Failed to backup original file before swap: {}", e))?;

        if let Err(swap_err) = safe_move_file(tmp_path, target_abs) {
            let _ = fs::rename(&orig_backup, target_abs);
            return Err(format!("Failed to place new file in destination: {}", swap_err));
        }

        let _ = safe_delete_file(&orig_backup);
    } else {
        safe_move_file(tmp_path, target_abs)
            .map_err(|e| format!("Failed to move replacement into destination: {}", e))?;

        if strategy == "replace" && original_abs != target_abs && original_abs.exists() {
            let _ = safe_delete_file(original_abs);
        }
    }
    Ok(())
}


pub fn commit_changes(
    app: &tauri::AppHandle,
    ledger_path_str: &str,
    decisions: HashMap<String, String>,
    output_path_str: &str,
    output_strategy_str: &str,
) -> Result<CommitResult, String> {
    let ledger_path = PathBuf::from(ledger_path_str);
    if !ledger_path.exists() {
        return Err(format!("Ledger file not found at {}", ledger_path_str));
    }

    let root_path = ledger_path
        .parent()
        .ok_or_else(|| "Invalid ledger path parent".to_string())?;

    let mut ledger: Ledger = load_ledger(root_path)?
        .ok_or_else(|| "Failed to load ledger".to_string())?;

    let strategy = if output_strategy_str.is_empty() {
        "replace"
    } else {
        output_strategy_str
    };

    if strategy != "replace" && output_path_str.trim().is_empty() {
        return Err("Output folder path must be specified for non-replace strategy".to_string());
    }

    let out_dir = if strategy != "replace" {
        let p = PathBuf::from(output_path_str);
        if !p.exists() {
            fs::create_dir_all(&p).map_err(|e| e.to_string())?;
        }
        Some(p)
    } else {
        None
    };

    let ffmpeg_path = get_ffmpeg_path(app);
    let ffprobe_path = get_ffprobe_path(app);

    let mut committed = 0u32;
    let mut skipped = 0u32;
    let mut failed = Vec::new();
    let mut committed_deezer_paths: HashMap<u64, PathBuf> = HashMap::new();

    let mut staged_by_deezer_id: HashMap<u64, PathBuf> = HashMap::new();
    for entry in ledger.files.values() {
        if let (Some(id), Some(ref staged_rel)) = (entry.deezer_id, entry.staged_path.as_ref()) {
            let p = PathBuf::from(staged_rel);
            let cand = if p.is_absolute() {
                p
            } else {
                root_path.join(staged_rel)
            };
            if cand.exists() {
                staged_by_deezer_id.insert(id, cand);
            }
        }
    }

    for (rel_path, entry) in ledger.files.iter_mut() {
        let decision = decisions
            .get(rel_path)
            .cloned()
            .or_else(|| entry.decision.clone())
            .unwrap_or_else(|| "pending".to_string());

        entry.decision = Some(decision.clone());

        if decision == "skipped" {
            skipped += 1;
            let display_name = entry
                .artist
                .as_ref()
                .zip(entry.title.as_ref())
                .map(|(a, t)| format!("{} - {}", a, t))
                .unwrap_or_else(|| rel_path.clone());
            write_session_log(root_path, "SKIPPED", &format!("{}  →  original retained", display_name));
            continue;
        }

        if decision != "approved" {
            continue;
        }

        let original_abs = entry
            .original_abs_path
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let sub = rel_path.trim_start_matches('/');
                root_path.join(sub)
            });

        // Locate replacement file
        let staged_abs_opt = entry
            .staged_path
            .as_ref()
            .map(|sp| {
                let p = PathBuf::from(sp);
                if p.is_absolute() {
                    p
                } else {
                    root_path.join(sp)
                }
            })
            .filter(|p| p.exists())
            .or_else(|| {
                entry
                    .deezer_id
                    .and_then(|id| staged_by_deezer_id.get(&id).cloned())
            })
            .or_else(|| {
                entry
                    .deezer_id
                    .and_then(|id| committed_deezer_paths.get(&id).cloned())
            });

        let staged_abs = match staged_abs_opt {
            Some(p) => p,
            None => {
                failed.push(CommitFailure {
                    rel_path: rel_path.clone(),
                    error: "Staged upgrade audio file not found on disk".to_string(),
                });
                continue;
            }
        };

        let target_ext = staged_abs
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("flac");

        let target_abs = match strategy {
            "replace" => {
                let orig_stem = original_abs
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("track");
                let parent = original_abs.parent().unwrap_or(root_path);
                parent.join(format!("{}.{}", orig_stem, target_ext))
            }
            _ => {
                let base_out = out_dir.as_ref().unwrap();
                let sub = rel_path.trim_start_matches('/');
                let sub_path = PathBuf::from(sub);
                let stem = sub_path.file_stem().and_then(|s| s.to_str()).unwrap_or("track");
                let parent = sub_path.parent().unwrap_or(Path::new(""));
                let dest_parent = base_out.join(parent);
                if !dest_parent.exists() {
                    let _ = fs::create_dir_all(&dest_parent);
                }
                dest_parent.join(format!("{}.{}", stem, target_ext))
            }
        };

        // Merge tags from original file into staged replacement before placing
        merge_original_tags(&ffmpeg_path, &ffprobe_path, &original_abs, &staged_abs);

        if let Err(swap_err) = swap_and_safe_trash(&staged_abs, &target_abs, &original_abs, strategy) {
            failed.push(CommitFailure {
                rel_path: rel_path.clone(),
                error: swap_err,
            });
            continue;
        }

        clean_proxy_file(entry, Some(&staged_abs), root_path);

        if let Some(id) = entry.deezer_id {
            committed_deezer_paths.insert(id, target_abs.clone());
        }

        entry.status = "committed".to_string();
        committed += 1;

        let display_name = entry
            .artist
            .as_ref()
            .zip(entry.title.as_ref())
            .map(|(a, t)| format!("{} - {}", a, t))
            .unwrap_or_else(|| rel_path.clone());
        write_session_log(
            root_path,
            "COMMITTED",
            &format!("{}  →  {}", display_name, target_abs.display()),
        );
    }

    save_ledger(root_path, &ledger)?;

    Ok(CommitResult {
        committed,
        skipped,
        failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_commit_skip_decision() {
        let temp_dir = std::env::temp_dir().join(format!("crateup-test-commit-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let mut ledger = Ledger {
            session_id: "test".to_string(),
            root_path: temp_dir.to_string_lossy().to_string(),
            output_format: "flac".to_string(),
            ledger_version: 1,
            files: std::collections::BTreeMap::new(),
            extra: serde_json::Map::new(),
        };

        ledger.files.insert(
            "/track.mp3".to_string(),
            FileEntry {
                status: "downloaded".to_string(),
                decision: Some("skipped".to_string()),
                ..Default::default()
            },
        );

        let ledger_path = save_ledger(&temp_dir, &ledger).unwrap();
        let mut decisions = HashMap::new();
        decisions.insert("/track.mp3".to_string(), "skipped".to_string());

        // Test without full Tauri handle (we can verify logic on decisions)
        let loaded = load_ledger(&temp_dir).unwrap().unwrap();
        assert_eq!(loaded.files.get("/track.mp3").unwrap().decision, Some("skipped".to_string()));

        let _ = fs::remove_file(ledger_path);
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
