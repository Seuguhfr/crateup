//! Library Audit: verify a library folder holds exactly what `master.db`
//! references, and sweep stray hardlinks of collected files.
//!
//! Read-only except for the explicit delete commands. No database writes.

use std::os::unix::fs::MetadataExt;
use tauri::Emitter;
use tauri::Manager;

use crate::rekordbox::list_library_entries;
use crate::similarity::get_ffmpeg_path;
use crate::xml::{get_audio_metadata, norm_fs_path, norm_song_key};

const AUDIO_EXTS: [&str; 6] = ["mp3", "wav", "flac", "aif", "aiff", "m4a"];

fn is_audio(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| AUDIO_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct AuditLeftover {
    pub(crate) path: String,
    pub(crate) size: u64,
    /// "duplicate" (same bytes as a collected file) or "orphan".
    pub(crate) kind: String,
    pub(crate) dupe_of: Option<String>,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct StrayGroup {
    pub(crate) folder: String,
    pub(crate) files: Vec<String>,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct AuditProgress {
    pub(crate) phase: String,
    pub(crate) processed: usize,
    pub(crate) total: usize,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct AuditReport {
    pub(crate) library_root: String,
    pub(crate) audio_file_count: usize,
    pub(crate) referenced_count: usize,
    pub(crate) leftovers: Vec<AuditLeftover>,
    pub(crate) stray_groups: Vec<StrayGroup>,
    /// Extra links found vs known to exist (nlink - 1), summed over db files.
    pub(crate) twins_found_extra: usize,
    pub(crate) twins_total_extra: usize,
    /// Collected tracks living outside the loaded folder (info only).
    pub(crate) outside_db: Vec<String>,
    /// Db rows pointing at missing files (info only).
    pub(crate) missing_db: Vec<String>,
    pub(crate) skipped_dirs: Vec<String>,
    /// Leftover bytes (dupes + orphans). Twin groups waste 0 by design.
    pub(crate) bytes_wasted: u64,
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct AuditDeleteResult {
    pub(crate) path: String,
    /// deleted | refused_referenced | missing | delete_failed: … |
    /// removed | not_empty | not_removed: …
    pub(crate) status: String,
}

struct WalkedFile {
    path: std::path::PathBuf,
    size: u64,
    dev: u64,
    ino: u64,
}

/// Recursive audio walk. Hidden entries and symlinked dirs are skipped;
/// unreadable dirs land in `skipped`. Symlinked files stat through.
fn walk_audio(
    root: &std::path::Path,
    skipped: &mut Vec<String>,
    out: &mut Vec<WalkedFile>,
) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(_) => {
            skipped.push(root.to_string_lossy().into_owned());
            return;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            // Never follow directory symlinks (cycles); files stat through.
            if entry.path().is_dir() {
                continue;
            }
        } else if ft.is_dir() {
            walk_audio(&entry.path(), skipped, out);
            continue;
        } else if !ft.is_file() {
            continue;
        }
        let path = entry.path();
        if !is_audio(&path) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(&path) {
            out.push(WalkedFile {
                path,
                size: meta.len(),
                dev: meta.dev(),
                ino: meta.ino(),
            });
        }
    }
}

fn emit_progress(window: &tauri::Window, phase: &str, processed: usize, total: usize) {
    let _ = window.emit(
        "audit-progress",
        AuditProgress {
            phase: phase.to_string(),
            processed,
            total,
        },
    );
}

/// Suggest search roots that actually exist (home-relative staging spots).
#[tauri::command]
pub fn audit_suggested_roots() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() {
        return Vec::new();
    }
    let base = std::path::Path::new(&home);
    ["Downloads", "Music/deemix", "Music/Downloads"]
        .into_iter()
        .map(|d| base.join(d))
        .filter(|p| p.is_dir())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
pub async fn audit_library(
    window: tauri::Window,
    library_root: String,
    search_roots: Vec<String>,
) -> Result<AuditReport, String> {
    let library_root = std::path::PathBuf::from(&library_root);
    if !library_root.is_dir() {
        return Err("Library folder does not exist or is not a directory.".to_string());
    }
    tokio::task::spawn_blocking(move || {
        audit_library_blocking(&window, &library_root, &search_roots)
    })
    .await
    .map_err(|e| format!("Blocking task failed to join: {}", e))?
}

fn audit_library_blocking(
    window: &tauri::Window,
    library_root: &std::path::Path,
    search_roots: &[String],
) -> Result<AuditReport, String> {
    let entries =
        list_library_entries().map_err(|e| format!("No local Rekordbox library: {}", e))?;

    // Db path set + inode index. Missing rows are reported, never matched.
    let mut db_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut db_inode: std::collections::HashMap<(u64, u64), (String, u64)> =
        std::collections::HashMap::new();
    let mut db_devs: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut missing_db: Vec<String> = Vec::new();
    for e in entries.iter() {
        let norm = norm_fs_path(&e.path);
        db_paths.insert(norm);
        match std::fs::metadata(&e.path) {
            Err(_) => missing_db.push(e.path.to_string_lossy().into_owned()),
            Ok(meta) => {
                db_inode.insert(
                    (meta.dev(), meta.ino()),
                    (e.path.to_string_lossy().into_owned(), meta.nlink()),
                );
                db_devs.insert(meta.dev());
            }
        }
    }
    // Title/stem indexes for narrowing content checks.
    let mut by_title: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    let mut by_stem: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        let title = norm_song_key(&e.title);
        if !title.is_empty() {
            by_title.entry(title).or_default().push(i);
        }
        let stem = e
            .path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string().to_lowercase())
            .unwrap_or_default();
        if !stem.is_empty() {
            by_stem.entry(stem).or_default().push(i);
        }
    }
    let root_norm = norm_fs_path(library_root);
    // Outside-db: collected but living elsewhere (info only, skip missing).
    let mut outside_db: Vec<String> = entries
        .iter()
        .map(|e| e.path.to_string_lossy().into_owned())
        .filter(|p| {
            !missing_db.contains(p) && {
                let n = p.replace('\\', "/").to_lowercase();
                !(n == root_norm || n.starts_with(&format!("{}/", root_norm)))
            }
        })
        .collect();
    outside_db.sort();
    outside_db.dedup();
    missing_db.sort();
    missing_db.dedup();

    // Phase 1: walk the library folder.
    emit_progress(window, "scan", 0, 0);
    let mut skipped_dirs: Vec<String> = Vec::new();
    let mut lib_files: Vec<WalkedFile> = Vec::new();
    walk_audio(library_root, &mut skipped_dirs, &mut lib_files);
    let audio_file_count = lib_files.len();
    let mut referenced_count = 0usize;
    let mut leftover_idx: Vec<usize> = Vec::new();
    for (i, f) in lib_files.iter().enumerate() {
        if db_paths.contains(&norm_fs_path(&f.path)) {
            referenced_count += 1;
        } else {
            leftover_idx.push(i);
        }
        if i % 50 == 0 {
            emit_progress(window, "scan", i, 0);
        }
    }

    // Phase 2: content-match leftovers against title/stem-narrowed candidates.
    let ffmpeg_path = get_ffmpeg_path(window.app_handle());
    let mut md5_memo: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    let md5_of = |p: &std::path::Path, memo: &mut std::collections::HashMap<String, Option<String>>| -> Option<String> {
        let key = norm_fs_path(p);
        if let Some(hit) = memo.get(&key) {
            return hit.clone();
        }
        let val = crate::similarity::get_raw_audio_md5(&ffmpeg_path, p);
        memo.insert(key, val.clone());
        val
    };
    let mut leftovers: Vec<AuditLeftover> = Vec::new();
    let mut bytes_wasted = 0u64;
    for (n, &i) in leftover_idx.iter().enumerate() {
        let f = &lib_files[i];
        emit_progress(window, "match", n, leftover_idx.len());
        let meta = get_audio_metadata(&ffmpeg_path, &f.path);
        let title = norm_song_key(&meta.title);
        let stem = f
            .path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string().to_lowercase())
            .unwrap_or_default();
        let mut cand_idx: Vec<usize> = Vec::new();
        if !title.is_empty() {
            if let Some(v) = by_title.get(&title) {
                cand_idx.extend(v.iter().copied());
            }
        }
        if !stem.is_empty() {
            if let Some(v) = by_stem.get(&stem) {
                cand_idx.extend(v.iter().copied());
            }
        }
        cand_idx.sort_unstable();
        cand_idx.dedup();
        // Size prefilter: equality is necessary for MD5 equality.
        let own_md5 = md5_of(&f.path, &mut md5_memo);
        let mut dupe_of: Option<String> = None;
        if let Some(ref own) = own_md5 {
            for ci in cand_idx {
                let db_path = &entries[ci].path;
                let Ok(meta) = std::fs::metadata(db_path) else {
                    continue;
                };
                if meta.len() != f.size {
                    continue;
                }
                if md5_of(db_path, &mut md5_memo).as_deref() == Some(own.as_str()) {
                    dupe_of = Some(db_path.to_string_lossy().into_owned());
                    break;
                }
            }
        }
        let path_str = f.path.to_string_lossy().into_owned();
        bytes_wasted += f.size;
        leftovers.push(AuditLeftover {
            path: path_str,
            size: f.size,
            kind: if dupe_of.is_some() {
                "duplicate".to_string()
            } else {
                "orphan".to_string()
            },
            dupe_of,
        });
    }

    // Phase 3: stray-link sweep over search roots (same device only).
    emit_progress(window, "sweep", 0, 0);
    let mut twin_paths: std::collections::HashMap<(u64, u64), Vec<String>> =
        std::collections::HashMap::new();
    for root in search_roots {
        let root_path = std::path::PathBuf::from(root);
        if !root_path.is_dir() {
            skipped_dirs.push(root.clone());
            continue;
        }
        let mut found: Vec<WalkedFile> = Vec::new();
        walk_audio(&root_path, &mut skipped_dirs, &mut found);
        for wf in found {
            if !db_devs.contains(&wf.dev) {
                continue;
            }
            if db_inode.contains_key(&(wf.dev, wf.ino)) {
                twin_paths
                    .entry((wf.dev, wf.ino))
                    .or_default()
                    .push(wf.path.to_string_lossy().into_owned());
            }
        }
        emit_progress(window, "sweep", twin_paths.len(), 0);
    }
    // Group twins per folder, excluding the db-referenced path itself.
    let mut folders: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
    let mut twins_found_extra = 0usize;
    let mut twins_total_extra = 0usize;
    let mut seen_twins: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut inode_keys: Vec<(u64, u64)> = twin_paths.keys().copied().collect();
    inode_keys.sort_unstable();
    for key in inode_keys {
        let (db_path, nlink) = &db_inode[&key];
        twins_total_extra += (*nlink).saturating_sub(1) as usize;
        let db_norm = norm_fs_path(std::path::Path::new(db_path));
        let mut paths = twin_paths.remove(&key).unwrap_or_default();
        paths.sort();
        paths.dedup();
        for p in paths {
            if norm_fs_path(std::path::Path::new(&p)) == db_norm {
                continue;
            }
            if !seen_twins.insert(p.clone()) {
                continue;
            }
            twins_found_extra += 1;
            let folder = std::path::Path::new(&p)
                .parent()
                .map(|d| d.to_string_lossy().into_owned())
                .unwrap_or_default();
            folders.entry(folder).or_default().push(p);
        }
    }
    let mut stray_groups: Vec<StrayGroup> = folders
        .into_iter()
        .map(|(folder, mut files)| {
            files.sort();
            StrayGroup {
                folder,
                files,
            }
        })
        .collect();
    stray_groups.sort_by(|a, b| a.folder.cmp(&b.folder));

    leftovers.sort_by(|a, b| a.path.cmp(&b.path));
    skipped_dirs.sort();
    skipped_dirs.dedup();
    emit_progress(window, "done", 1, 1);

    Ok(AuditReport {
        library_root: library_root.to_string_lossy().into_owned(),
        audio_file_count,
        referenced_count,
        leftovers,
        stray_groups,
        twins_found_extra,
        twins_total_extra,
        outside_db,
        missing_db,
        skipped_dirs,
        bytes_wasted,
    })
}

/// Delete audit-surfaced paths. Fail-closed: when the live db can't be read,
/// everything is refused. Db-referenced paths are always refused, even if
/// the UI state went stale.
#[tauri::command]
pub async fn delete_audit_paths(paths: Vec<String>) -> Result<Vec<AuditDeleteResult>, String> {
    let live: std::collections::HashSet<String> = list_library_entries()
        .map_err(|e| format!("Cannot verify against the library ({}); refused all.", e))?
        .iter()
        .map(|e| norm_fs_path(&e.path))
        .collect();
    let mut results = Vec::new();
    for p in paths {
        let path = std::path::PathBuf::from(&p);
        if live.contains(&norm_fs_path(&path)) {
            results.push(AuditDeleteResult {
                path: p,
                status: "refused_referenced".to_string(),
            });
            continue;
        }
        if !path.exists() {
            results.push(AuditDeleteResult {
                path: p,
                status: "missing".to_string(),
            });
            continue;
        }
        match crate::safe_delete_file(&path) {
            Ok(_) => results.push(AuditDeleteResult {
                path: p,
                status: "deleted".to_string(),
            }),
            Err(e) => results.push(AuditDeleteResult {
                path: p,
                status: format!("delete_failed: {}", e),
            }),
        }
    }
    Ok(results)
}

/// Remove folders, but only when actually empty. Never touches non-empty,
/// missing, or unreadable directories.
#[tauri::command]
pub fn remove_empty_folders(folders: Vec<String>) -> Vec<AuditDeleteResult> {
    let mut results = Vec::new();
    for f in folders {
        let path = std::path::PathBuf::from(&f);
        let status = match std::fs::read_dir(&path) {
            Err(_) => {
                if path.exists() {
                    "not_removed: unreadable"
                } else {
                    "missing"
                }
            }
            Ok(entries) => {
                if entries.count() == 0 {
                    match std::fs::remove_dir(&path) {
                        Ok(_) => "removed",
                        Err(_) => "not_removed: rmdir failed",
                    }
                } else {
                    "not_empty"
                }
            }
        };
        results.push(AuditDeleteResult {
            path: f,
            status: status.to_string(),
        });
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remove_empty_folders() {
        let base = std::env::temp_dir().join(format!(
            "crateup-audit-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let empty = base.join("empty");
        let full = base.join("full");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&full).unwrap();
        std::fs::write(full.join("track.mp3"), b"fake").unwrap();

        let res = remove_empty_folders(vec![
            empty.to_string_lossy().into_owned(),
            full.to_string_lossy().into_owned(),
            base.join("ghost").to_string_lossy().into_owned(),
        ]);
        assert_eq!(res[0].status, "removed");
        assert!(!empty.exists());
        assert_eq!(res[1].status, "not_empty");
        assert!(full.join("track.mp3").exists());
        assert_eq!(res[2].status, "missing");

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn test_walk_audio_filters() {
        let base = std::env::temp_dir().join(format!(
            "crateup-audit-walk-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sub = base.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(base.join("a.mp3"), b"fake").unwrap();
        std::fs::write(base.join("cover.jpg"), b"fake").unwrap();
        std::fs::write(base.join(".hidden.mp3"), b"fake").unwrap();
        std::fs::write(sub.join("b.FLAC"), b"fake").unwrap();

        let mut skipped = Vec::new();
        let mut out = Vec::new();
        walk_audio(&base, &mut skipped, &mut out);
        let mut names: Vec<String> = out
            .iter()
            .map(|f| f.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["a.mp3".to_string(), "b.FLAC".to_string()]);
        assert!(skipped.is_empty());

        std::fs::remove_dir_all(&base).unwrap();
    }
}
