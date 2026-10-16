use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

pub const PROD_LEDGER_FILENAME: &str = ".crateup-progress.json";
pub const DEV_LEDGER_FILENAME: &str = ".crateup-progress-dev.json";
pub const LEDGER_VERSION: u64 = 1;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Ledger {
    pub session_id: String,
    pub root_path: String,
    pub output_format: String,
    #[serde(default = "default_ledger_version")]
    pub ledger_version: u64,
    #[serde(default)]
    pub files: BTreeMap<String, FileEntry>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn default_ledger_version() -> u64 {
    LEDGER_VERSION
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct FileEntry {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deezer_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub similarity_score: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub similarity_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_bit_identical: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_bitrate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_bitrate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deezer_origin: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_abs_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peaks: Option<Vec<f32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_peaks: Option<Vec<f32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orig_rms: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_rms: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset_ms: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_transcode: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub fn resolve_ledger_filename() -> String {
    if let Ok(name) = std::env::var("CRATEUP_LEDGER_FILENAME") {
        if !name.trim().is_empty() {
            return name.trim().to_string();
        }
    }
    PROD_LEDGER_FILENAME.to_string()
}

pub fn resolve_ledger_path(root_path: &Path) -> PathBuf {
    let custom = resolve_ledger_filename();
    let primary = root_path.join(custom);
    if !primary.exists() {
        let dev_fallback = root_path.join(DEV_LEDGER_FILENAME);
        if dev_fallback.exists() {
            return dev_fallback;
        }
    }
    primary
}

#[derive(Clone)]
struct CacheEntry {
    mtime_nanos: u128,
    size: u64,
    ledger: Ledger,
}

static LEDGER_CACHE: Mutex<Option<HashMap<PathBuf, CacheEntry>>> = Mutex::new(None);

fn get_file_stat(path: &Path) -> Option<(u128, u64)> {
    let meta = fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((mtime, meta.len()))
}

pub fn clear_ledger_cache() {
    let mut guard = LEDGER_CACHE.lock().unwrap();
    *guard = None;
}

pub fn load_ledger(root_path: &Path) -> Result<Option<Ledger>, String> {
    let ledger_path = resolve_ledger_path(root_path);
    let stat = match get_file_stat(&ledger_path) {
        Some(s) => s,
        None => {
            let mut guard = LEDGER_CACHE.lock().unwrap();
            if let Some(ref mut map) = *guard {
                map.remove(&ledger_path);
            }
            return Ok(None);
        }
    };

    {
        let mut guard = LEDGER_CACHE.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        if let Some(entry) = map.get(&ledger_path) {
            if entry.mtime_nanos == stat.0 && entry.size == stat.1 {
                return Ok(Some(entry.ledger.clone()));
            }
        }
    }

    let content = fs::read_to_string(&ledger_path).map_err(|e| e.to_string())?;
    let mut val: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    // Handle legacy staging paths migration
    let mut modified = false;
    if let Some(rp) = val.get("root_path").and_then(|r| r.as_str()) {
        let old_staging = Path::new(rp).join(".crateup-staging");
        let new_staging = Path::new(rp).join("crateup-staging");
        if old_staging.exists() && !new_staging.exists() {
            let _ = fs::rename(&old_staging, &new_staging);
        }
    }

    // Ensure ledger_version stamp
    if let Some(obj) = val.as_object_mut() {
        if obj.get("ledger_version").and_then(|v| v.as_u64()).is_none() {
            obj.insert("ledger_version".to_string(), serde_json::Value::from(LEDGER_VERSION));
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

    let ledger: Ledger = serde_json::from_value(val).map_err(|e| e.to_string())?;

    if modified {
        save_ledger(root_path, &ledger)?;
    } else {
        let mut guard = LEDGER_CACHE.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(
            ledger_path,
            CacheEntry {
                mtime_nanos: stat.0,
                size: stat.1,
                ledger: ledger.clone(),
            },
        );
    }

    Ok(Some(ledger))
}

pub fn save_ledger(root_path: &Path, ledger: &Ledger) -> Result<PathBuf, String> {
    let ledger_path = resolve_ledger_path(root_path);
    let parent = ledger_path.parent().unwrap_or(Path::new("."));
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_path = parent.join(format!(
        "{}.tmp.{}.{}",
        ledger_path
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("ledger"),
        std::process::id(),
        nanos
    ));

    let json = serde_json::to_string_pretty(ledger).map_err(|e| e.to_string())?;
    fs::write(&tmp_path, &json).map_err(|e| e.to_string())?;

    if let Err(e) = fs::rename(&tmp_path, &ledger_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to rename ledger file: {}", e));
    }

    let stat = get_file_stat(&ledger_path).unwrap_or((0, 0));
    {
        let mut guard = LEDGER_CACHE.lock().unwrap();
        let map = guard.get_or_insert_with(HashMap::new);
        map.insert(
            ledger_path.clone(),
            CacheEntry {
                mtime_nanos: stat.0,
                size: stat.1,
                ledger: ledger.clone(),
            },
        );
    }

    Ok(ledger_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ledger_preserves_unknown_fields() {
        let raw = r#"{
            "session_id": "test-uuid",
            "root_path": "/test/root",
            "output_format": "flac",
            "ledger_version": 1,
            "future_top_level": "forward_compatible",
            "files": {
                "/track.mp3": {
                    "status": "pending",
                    "original_bitrate": 320,
                    "future_file_field": 12345
                }
            }
        }"#;

        let ledger: Ledger = serde_json::from_str(raw).expect("Failed to deserialize");
        assert_eq!(ledger.session_id, "test-uuid");
        assert_eq!(
            ledger.extra.get("future_top_level"),
            Some(&serde_json::Value::String("forward_compatible".to_string()))
        );

        let entry = ledger.files.get("/track.mp3").expect("File not found");
        assert_eq!(entry.status, "pending");
        assert_eq!(entry.original_bitrate, Some(320));
        assert_eq!(
            entry.extra.get("future_file_field"),
            Some(&serde_json::Value::from(12345))
        );

        let serialized = serde_json::to_string(&ledger).expect("Failed to serialize");
        assert!(serialized.contains("future_top_level"));
        assert!(serialized.contains("future_file_field"));
    }

    #[test]
    fn test_ledger_atomic_save_and_cache_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("crateup-test-ledger-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        clear_ledger_cache();

        let mut ledger = Ledger {
            session_id: "test-sess".to_string(),
            root_path: temp_dir.to_string_lossy().to_string(),
            output_format: "flac".to_string(),
            ledger_version: 1,
            files: BTreeMap::new(),
            extra: serde_json::Map::new(),
        };

        ledger.files.insert(
            "/test.mp3".to_string(),
            FileEntry {
                status: "pending".to_string(),
                original_bitrate: Some(256),
                ..Default::default()
            },
        );

        let saved_path = save_ledger(&temp_dir, &ledger).expect("Save failed");
        assert!(saved_path.exists());

        // Cache hit
        let loaded = load_ledger(&temp_dir).expect("Load failed").expect("Should exist");
        assert_eq!(loaded.session_id, "test-sess");
        assert_eq!(loaded.files.get("/test.mp3").unwrap().original_bitrate, Some(256));

        // External modification invalidates cache
        let modified_raw = fs::read_to_string(&saved_path).unwrap().replace("256", "320");
        std::thread::sleep(std::time::Duration::from_millis(15));
        fs::write(&saved_path, modified_raw).unwrap();

        let loaded2 = load_ledger(&temp_dir).expect("Load failed").expect("Should exist");
        assert_eq!(loaded2.files.get("/test.mp3").unwrap().original_bitrate, Some(320));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_resolve_ledger_fallback() {
        let temp_dir = std::env::temp_dir().join(format!("crateup-test-resolve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();

        let dev_file = temp_dir.join(DEV_LEDGER_FILENAME);
        fs::write(&dev_file, "{}").unwrap();

        let resolved = resolve_ledger_path(&temp_dir);
        assert_eq!(resolved, dev_file);

        let prod_file = temp_dir.join(PROD_LEDGER_FILENAME);
        fs::write(&prod_file, "{}").unwrap();

        let resolved2 = resolve_ledger_path(&temp_dir);
        assert_eq!(resolved2, prod_file);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
