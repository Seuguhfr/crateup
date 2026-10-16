use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::ledger::{load_ledger, save_ledger, FileEntry, Ledger, LEDGER_VERSION};
use crate::similarity::get_ffprobe_path;

pub fn scan_dir(dir: &Path, root: &Path, files_list: &mut Vec<String>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "crateup-staging" || name == ".crateup-staging" {
            continue;
        }

        let full_path = entry.path();
        if full_path.is_dir() {
            scan_dir(&full_path, root, files_list);
        } else if full_path.is_file() {
            if let Some(ext) = full_path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();
                if matches!(
                    ext_lower.as_str(),
                    "mp3" | "flac" | "aiff" | "aif" | "wav" | "m4a"
                ) {
                    if let Ok(rel) = full_path.strip_prefix(root) {
                        let mut rel_str = rel.to_string_lossy().replace('\\', "/");
                        if !rel_str.starts_with('/') {
                            rel_str = format!("/{}", rel_str);
                        }
                        files_list.push(rel_str);
                    }
                }
            }
        }
    }
}

pub fn get_file_details(ffprobe_path: &Path, file_path: &Path) -> (Option<u32>, bool) {
    let output = match std::process::Command::new(ffprobe_path)
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
        ])
        .arg(file_path)
        .output()
    {
        Ok(out) if out.status.success() => out.stdout,
        _ => return (None, false),
    };

    let data: serde_json::Value = match serde_json::from_slice(&output) {
        Ok(v) => v,
        Err(_) => return (None, false),
    };

    let format = data.get("format");
    let streams = data.get("streams").and_then(|s| s.as_array());

    let raw_bitrate = streams
        .and_then(|arr| {
            arr.iter()
                .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"))
                .and_then(|s| s.get("bit_rate"))
        })
        .or_else(|| format.and_then(|f| f.get("bit_rate")));

    let bitrate = raw_bitrate.and_then(|v| {
        if let Some(n) = v.as_u64() {
            Some((n as f64 / 1000.0).round() as u32)
        } else if let Some(s) = v.as_str() {
            s.parse::<f64>().ok().map(|n| (n / 1000.0).round() as u32)
        } else {
            None
        }
    });

    let mut deezer_origin = false;
    if let Some(tags) = format.and_then(|f| f.get("tags")).and_then(|t| t.as_object()) {
        let mut norm_tags = HashMap::new();
        for (k, v) in tags {
            if let Some(val_str) = v.as_str() {
                norm_tags.insert(k.to_lowercase(), val_str.trim().to_lowercase());
            }
        }

        let has_barcode = norm_tags
            .get("barcode")
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        let has_isrc = norm_tags
            .get("isrc")
            .or_else(|| norm_tags.get("tsrc"))
            .map(|s| !s.is_empty())
            .unwrap_or(false);

        deezer_origin = has_barcode && has_isrc;
    }

    (bitrate, deezer_origin)
}

pub fn get_bitrate(ffprobe_path: &Path, file_path: &Path) -> Option<u32> {
    get_file_details(ffprobe_path, file_path).0
}

pub fn init_ledger(
    app: &tauri::AppHandle,
    root_path: &Path,
    output_format: &str,
    file_list: Option<Vec<String>>,
) -> Result<Ledger, String> {
    if !root_path.exists() {
        fs::create_dir_all(root_path).map_err(|e| e.to_string())?;
    }

    let ffprobe_path = get_ffprobe_path(app);

    let mut ledger = match load_ledger(root_path)? {
        Some(mut existing) => {
            // Reset any in-flight items from interrupted pipeline runs back to pending
            for entry in existing.files.values_mut() {
                if entry.status == "fingerprinting" || entry.status == "downloading" {
                    entry.status = "pending".to_string();
                }
            }
            existing
        }
        None => Ledger {
            session_id: uuid::Uuid::new_v4().to_string(),
            root_path: root_path.to_string_lossy().to_string(),
            output_format: output_format.to_string(),
            ledger_version: LEDGER_VERSION,
            files: BTreeMap::new(),
            extra: serde_json::Map::new(),
        },
    };

    let mut files_to_process = Vec::new();
    let mut abs_paths_map: HashMap<String, String> = HashMap::new();

    if let Some(list) = file_list {
        for abs_str in list {
            let abs_path = PathBuf::from(&abs_str);
            let mut rel_str = match abs_path.strip_prefix(root_path) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => abs_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            };
            if !rel_str.starts_with('/') {
                rel_str = format!("/{}", rel_str);
            }
            files_to_process.push(rel_str.clone());
            abs_paths_map.insert(rel_str, abs_str);
        }
    } else {
        scan_dir(root_path, root_path, &mut files_to_process);
    }

    for rel_path in files_to_process {
        let abs_path = abs_paths_map
            .get(&rel_path)
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let sub = rel_path.trim_start_matches('/');
                root_path.join(sub)
            });

        let (bitrate, deezer_origin) = get_file_details(&ffprobe_path, &abs_path);

        if let Some(entry) = ledger.files.get_mut(&rel_path) {
            if entry.original_bitrate.is_none() {
                entry.original_bitrate = bitrate;
            }
            if entry.deezer_origin.is_none() {
                entry.deezer_origin = Some(deezer_origin);
            }
            if abs_paths_map.contains_key(&rel_path) && entry.original_abs_path.is_none() {
                entry.original_abs_path = abs_paths_map.get(&rel_path).cloned();
            }
        } else {
            let mut entry = FileEntry {
                status: "pending".to_string(),
                original_bitrate: bitrate,
                deezer_origin: Some(deezer_origin),
                ..Default::default()
            };
            if let Some(abs_str) = abs_paths_map.get(&rel_path) {
                entry.original_abs_path = Some(abs_str.clone());
            }
            ledger.files.insert(rel_path, entry);
        }
    }

    save_ledger(root_path, &ledger)?;
    Ok(ledger)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_dir_filtering() {
        let temp_dir = std::env::temp_dir().join(format!("crateup-test-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let sub = temp_dir.join("Subfolder");
        fs::create_dir_all(&sub).unwrap();

        let staging = temp_dir.join("crateup-staging");
        fs::create_dir_all(&staging).unwrap();

        fs::write(temp_dir.join("track1.mp3"), b"test").unwrap();
        fs::write(sub.join("track2.flac"), b"test").unwrap();
        fs::write(temp_dir.join("ignored.txt"), b"test").unwrap();
        fs::write(temp_dir.join(".hidden.mp3"), b"test").unwrap();
        fs::write(staging.join("staged.flac"), b"test").unwrap();

        let mut list = Vec::new();
        scan_dir(&temp_dir, &temp_dir, &mut list);
        list.sort();

        assert_eq!(list, vec!["/Subfolder/track2.flac", "/track1.mp3"]);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
