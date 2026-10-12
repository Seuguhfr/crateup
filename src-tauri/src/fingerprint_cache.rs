//! Persistent acoustic-fingerprint cache.
//!
//! Keyed by absolute path + mtime + size, so edited files re-fingerprint
//! automatically. Stored as JSON in the OS cache dir and written atomically
//! (tmp + rename), so readers never see a torn file.
//!
//! The cache is purely advisory: a missing/corrupt/unwritable file just
//! means fingerprints get recomputed. Used by every fpcalc consumer
//! (library consolidation, ingestion, playlist compare) so repeat work
//! across tools and reruns resolves instantly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CachedFingerprint {
    mtime_secs: u64,
    size: u64,
    fp: Vec<u32>,
    /// Raw-audio MD5 where computed (ingestion pre-scan). Absent otherwise.
    #[serde(default)]
    md5: Option<String>,
}

pub struct FingerprintCache {
    file: Option<PathBuf>,
    entries: HashMap<String, CachedFingerprint>,
    dirty: bool,
}

fn cache_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .cache_dir()
        .ok()
        .map(|d| d.join("crateup").join("fingerprints.json"))
}

fn file_sig(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((mtime, meta.len()))
}

impl FingerprintCache {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let file = cache_file(app);
        let entries = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str::<HashMap<String, CachedFingerprint>>(&s).ok())
            .unwrap_or_default();
        Self {
            file,
            entries,
            dirty: false,
        }
    }

    /// Look up a fingerprint, validating the file hasn't changed.
    pub fn get(&self, path: &Path) -> Option<Vec<u32>> {
        self.get_full(path).map(|(fp, _)| fp)
    }

    /// Look up fingerprint + MD5 together.
    pub fn get_full(&self, path: &Path) -> Option<(Vec<u32>, Option<String>)> {
        let (mtime, size) = file_sig(path)?;
        let key = path.to_string_lossy().to_string();
        let hit = self.entries.get(&key)?;
        if hit.mtime_secs == mtime && hit.size == size {
            Some((hit.fp.clone(), hit.md5.clone()))
        } else {
            None
        }
    }

    /// Store a fingerprint (stats the file for the validity signature).
    pub fn insert(&mut self, path: &Path, fp: Vec<u32>) {
        self.insert_full(path, fp, None);
    }

    /// Store a fingerprint plus its raw-audio MD5.
    pub fn insert_full(&mut self, path: &Path, fp: Vec<u32>, md5: Option<String>) {
        if let Some((mtime_secs, size)) = file_sig(path) {
            let key = path.to_string_lossy().to_string();
            // Keep a previously cached MD5 when this write has none.
            let md5 = md5.or_else(|| {
                self.entries
                    .get(&key)
                    .and_then(|e| e.md5.clone())
            });
            self.entries.insert(key, CachedFingerprint { mtime_secs, size, fp, md5 });
            self.dirty = true;
        }
    }

    /// Persist if anything changed. Best-effort; failures are silent.
    pub fn save(&self) {
        if !self.dirty {
            return;
        }
        let file = match &self.file {
            Some(f) => f,
            None => return,
        };
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = file.with_extension("json.tmp");
        let write_ok = serde_json::to_string(&self.entries)
            .ok()
            .and_then(|s| std::fs::write(&tmp, s).ok())
            .is_some();
        if write_ok {
            let _ = std::fs::rename(&tmp, file);
        } else {
            let _ = std::fs::remove_file(&tmp);
        }
    }

    /// Number of cached entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// On-disk size in bytes (0 when no cache file exists).
    pub fn bytes(&self) -> u64 {
        self.file
            .as_ref()
            .and_then(|f| std::fs::metadata(f).ok())
            .map(|m| m.len())
            .unwrap_or(0)
    }

    /// Drop all entries and delete the file. Returns the cleared count.
    pub fn clear(&mut self) -> usize {
        let n = self.entries.len();
        self.entries.clear();
        self.dirty = false;
        if let Some(f) = &self.file {
            let _ = std::fs::remove_file(f);
        }
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cache_miss_without_file() {
        // Nonexistent path: no signature, no hit, insert skipped.
        let cache = FingerprintCache {
            file: None,
            entries: HashMap::new(),
            dirty: false,
        };
        let ghost = PathBuf::from("/no/such/file/crateup-test.mp3");
        assert!(cache.get(&ghost).is_none());
    }

    #[test]
    fn test_cache_roundtrip_and_invalidation() {
        let dir = std::env::temp_dir().join("crateup-fp-test");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("track.mp3");
        std::fs::write(&file, b"fake-audio-bytes").unwrap();

        let mut cache = FingerprintCache {
            file: None,
            entries: HashMap::new(),
            dirty: false,
        };
        assert!(cache.get(&file).is_none());
        cache.insert(&file, vec![1, 2, 3]);
        assert_eq!(cache.get(&file), Some(vec![1, 2, 3]));

        // Same size, different content, same mtime granularity risk aside:
        // changing the size must invalidate.
        std::fs::write(&file, b"fake-audio-bytes!!").unwrap();
        assert!(cache.get(&file).is_none());

        let _ = std::fs::remove_file(&file);
    }
}
