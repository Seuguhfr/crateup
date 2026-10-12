//! Direct Rekordbox `master.db` (SQLCipher) access: playlist/tree reads,
//! database consolidation, backups, cleanup, duplicate repair, and direct
//! commit-time path sync. Extracted from lib.rs.

use rusqlite::OptionalExtension;
use tauri::Emitter;
use tauri::Manager;

use crate::fingerprint_cache::FingerprintCache;
use crate::similarity::{
    calculate_similarity, get_audio_fingerprint, get_fpcalc_path, is_better_quality,
    sanitize_threshold,
};
use crate::xml::{sanitize_filename, ConsolidationProgressPayload, ResultPayload};

fn get_rekordbox_db_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME environment variable not set".to_string())?;
    let base = std::path::Path::new(&home)
        .join("Library")
        .join("Pioneer");
    let lowercase_path = base.join("rekordbox").join("master.db");
    if lowercase_path.exists() {
        return Ok(lowercase_path);
    }
    let camelcase_path = base.join("Rekordbox").join("master.db");
    if camelcase_path.exists() {
        return Ok(camelcase_path);
    }
    Ok(lowercase_path)
}

fn is_rekordbox_running() -> bool {
    // Check for lowercase process name "rekordbox" exactly
    let output = std::process::Command::new("pgrep")
        .arg("-x")
        .arg("rekordbox")
        .output();
    if let Ok(out) = output {
        if !out.stdout.is_empty() {
            return true;
        }
    }

    // Check for camelcase process name "Rekordbox" exactly
    let output_camel = std::process::Command::new("pgrep")
        .arg("-x")
        .arg("Rekordbox")
        .output();
    if let Ok(out) = output_camel {
        if !out.stdout.is_empty() {
            return true;
        }
    }

    // Check command lines exactly in ps -ax
    let output_ps = std::process::Command::new("ps")
        .arg("-ax")
        .output();
    if let Ok(out) = output_ps {
        let ps_str = String::from_utf8_lossy(&out.stdout);
        for line in ps_str.lines() {
            let cmd = line.trim();
            let cmd_lower = cmd.to_lowercase();
            if let Some(last_part) = cmd_lower.split('/').last() {
                let last_part_trimmed = last_part.trim();
                if last_part_trimmed == "rekordbox" || last_part_trimmed.starts_with("rekordbox ") {
                    return true;
                }
            }
        }
    }
    false
}

fn open_rekordbox_db(db_path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| format!("Failed to open DB: {}", e))?;
    
    // Format 1: Plain key
    let key1 = "PRAGMA key = \"402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497\";";
    if let Ok(mut stmt) = conn.prepare(key1) {
        let _ = stmt.query([]);
    }
    let mut check1_ok = false;
    if let Ok(mut s) = conn.prepare("PRAGMA table_info(djmdContent)") {
        if s.query([]).is_ok() {
            check1_ok = true;
        }
    }
    if check1_ok {
        return Ok(conn);
    }
    
    // Format 2: Hex key
    let key2 = "PRAGMA key = \"x'402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497'\";";
    if let Ok(mut stmt) = conn.prepare(key2) {
        let _ = stmt.query([]);
    }
    let mut check2_ok = false;
    if let Ok(mut s) = conn.prepare("PRAGMA table_info(djmdContent)") {
        if s.query([]).is_ok() {
            check2_ok = true;
        }
    }
    if check2_ok {
        return Ok(conn);
    }
    
    Err("Failed to decrypt database with any key format".to_string())
}

fn merge_duplicate_content_id(tx: &rusqlite::Transaction, keep_id: &str, dup_id: &str) -> Result<(), rusqlite::Error> {
    if keep_id == dup_id {
        return Ok(());
    }

    let child_tables = [
        "djmdActiveCues",
        "djmdContentHistory",
        "djmdContentMyTag",
        "djmdContentProperty",
        "djmdCue",
        "djmdHotCueBank",
        "djmdHotCueBanklist",
        "djmdMixerParam",
        "djmdRelatedTracks",
        "djmdSongHistory",
        "djmdSongPlaylist",
        "djmdSongProperty",
        "djmdSongRelatedTracks",
        "djmdTrackHistory",
    ];

    for table in &child_tables {
        let sql_update = format!("UPDATE OR IGNORE {} SET ContentID = ? WHERE ContentID = ?", table);
        let _ = tx.execute(&sql_update, [keep_id, dup_id]);

        let sql_delete_orphans = format!("DELETE FROM {} WHERE ContentID = ?", table);
        let _ = tx.execute(&sql_delete_orphans, [dup_id]);
    }

    let _ = tx.execute("DELETE FROM djmdContent WHERE ID = ?", [dup_id]);

    Ok(())
}

fn cleanup_master_db_duplicates(tx: &rusqlite::Transaction) -> Result<usize, rusqlite::Error> {
    let query = "
        SELECT FolderPath, FileNameL, COUNT(*) as cnt, GROUP_CONCAT(ID) as ids
        FROM djmdContent
        WHERE FolderPath IS NOT NULL AND FolderPath != '' AND FileNameL IS NOT NULL AND FileNameL != ''
        GROUP BY FolderPath, FileNameL
        HAVING cnt > 1
    ";

    let mut dup_rows: Vec<(String, String, String)> = Vec::new();
    {
        let mut dup_stmt = tx.prepare(query)?;
        let rows = dup_stmt.query_map([], |row| {
            let folder: String = row.get(0)?;
            let filename: String = row.get(1)?;
            let ids: String = row.get(3)?;
            Ok((folder, filename, ids))
        })?;

        for r in rows {
            if let Ok(val) = r {
                dup_rows.push(val);
            }
        }
    }

    if dup_rows.is_empty() {
        return Ok(0);
    }

    let child_tables = [
        "djmdActiveCues",
        "djmdContentHistory",
        "djmdContentMyTag",
        "djmdContentProperty",
        "djmdCue",
        "djmdHotCueBank",
        "djmdHotCueBanklist",
        "djmdMixerParam",
        "djmdRelatedTracks",
        "djmdSongHistory",
        "djmdSongPlaylist",
        "djmdSongProperty",
        "djmdSongRelatedTracks",
        "djmdTrackHistory",
    ];

    let mut merged_count = 0;

    for (_folder, _filename, ids_str) in dup_rows {
        let id_list: Vec<&str> = ids_str.split(',').collect();
        if id_list.len() < 2 {
            continue;
        }

        let mut best_keeper = id_list[0];
        let mut max_score: i64 = -1;

        for &id in &id_list {
            let cue_cnt: i64 = tx.query_row("SELECT COUNT(*) FROM djmdCue WHERE ContentID = ?", [id], |r| r.get(0)).unwrap_or(0);
            let pl_cnt: i64 = tx.query_row("SELECT COUNT(*) FROM djmdSongPlaylist WHERE ContentID = ?", [id], |r| r.get(0)).unwrap_or(0);
            
            let score = (cue_cnt * 10) + (pl_cnt * 5);
            if score > max_score {
                max_score = score;
                best_keeper = id;
            }
        }

        for &dup_id in &id_list {
            if dup_id == best_keeper {
                continue;
            }

            for table in &child_tables {
                let sql_update = format!("UPDATE OR IGNORE {} SET ContentID = ? WHERE ContentID = ?", table);
                let _ = tx.execute(&sql_update, [best_keeper, dup_id]);

                let sql_delete_orphans = format!("DELETE FROM {} WHERE ContentID = ?", table);
                let _ = tx.execute(&sql_delete_orphans, [dup_id]);
            }

            if tx.execute("DELETE FROM djmdContent WHERE ID = ?", [dup_id]).is_ok() {
                merged_count += 1;
            }
        }
    }

    Ok(merged_count)
}

#[tauri::command]
pub async fn fix_rekordbox_db_duplicates() -> Result<usize, String> {
    if is_rekordbox_running() {
        return Err("Rekordbox is currently running. Please close Rekordbox before running database cleanup.".to_string());
    }

    let db_path = get_rekordbox_db_path()?;
    if !db_path.exists() {
        return Err("Rekordbox master.db database not found".to_string());
    }

    tokio::task::spawn_blocking(move || {
        let mut conn = open_rekordbox_db(&db_path)?;
        let tx = conn.transaction().map_err(|e| format!("Failed to start transaction: {}", e))?;
        
        let merged_count = cleanup_master_db_duplicates(&tx)
            .map_err(|e| format!("Failed to merge database duplicates: {}", e))?;
        
        tx.commit().map_err(|e| format!("Failed to commit database changes: {}", e))?;
        
        Ok(merged_count)
    }).await.map_err(|e| format!("Blocking task failed to join: {}", e))?
}

#[derive(serde::Serialize)]
pub(crate) struct RekordboxStatus {
    pub(crate) running: bool,
    pub(crate) db_exists: bool,
    pub(crate) db_path: String,
}

#[tauri::command]
pub async fn check_rekordbox_status() -> Result<RekordboxStatus, String> {
    let db_path = get_rekordbox_db_path()?;
    let db_exists = db_path.exists();
    let running = is_rekordbox_running();
    Ok(RekordboxStatus {
        running,
        db_exists,
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn get_db_backups() -> Result<Vec<String>, String> {
    let db_path = get_rekordbox_db_path()?;
    let db_dir = db_path.parent().ok_or_else(|| "Failed to get database parent directory".to_string())?;
    if !db_dir.exists() {
        return Ok(Vec::new());
    }
    let mut backups = Vec::new();
    for entry in std::fs::read_dir(db_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let filename = entry.file_name().to_string_lossy().to_string();
        if filename.starts_with("master.db.backup_") {
            backups.push(filename);
        }
    }
    backups.sort_by(|a, b| b.cmp(a));
    Ok(backups)
}

#[derive(serde::Serialize)]
struct CleanupResult {
    path: String,
    status: String,
}

#[derive(serde::Serialize)]
pub(crate) struct CleanupReport {
    results: Vec<CleanupResult>,
}

#[tauri::command]
pub async fn execute_backup_cleanup(backup_filename: String) -> Result<CleanupReport, String> {
    let db_path = get_rekordbox_db_path()?;
    let db_dir = db_path.parent().ok_or_else(|| "Failed to get database parent directory".to_string())?;
    let backup_path = db_dir.join(&backup_filename);
    if !backup_path.exists() {
        return Err(format!("Backup file does not exist: {}", backup_filename));
    }
    
    let conn_backup = open_rekordbox_db(&backup_path)?;
    let mut stmt = conn_backup.prepare("SELECT FolderPath FROM djmdContent").map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut old_paths = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let path: String = row.get(0).map_err(|e| e.to_string())?;
        if !path.trim().is_empty() {
            old_paths.push(path);
        }
    }
    drop(rows);
    drop(stmt);
    
    let live_paths = with_rekordbox_query_conn(|conn_live| {
        let mut stmt_live = conn_live.prepare("SELECT FolderPath FROM djmdContent").map_err(|e| e.to_string())?;
        let mut rows_live = stmt_live.query([]).map_err(|e| e.to_string())?;
        let mut set = std::collections::HashSet::new();
        while let Some(row) = rows_live.next().map_err(|e| e.to_string())? {
            let path: String = row.get(0).map_err(|e| e.to_string())?;
            if !path.trim().is_empty() {
                set.insert(path);
            }
        }
        Ok(set)
    })?;
    
    let mut results = Vec::new();
    for path in old_paths {
        if live_paths.contains(&path) {
            results.push(CleanupResult {
                path: path.clone(),
                status: "skipped_in_live_db".to_string(),
            });
            continue;
        }
        
        let file_path = std::path::Path::new(&path);
        if !file_path.exists() {
            results.push(CleanupResult {
                path: path.clone(),
                status: "skipped_not_exists".to_string(),
            });
            continue;
        }
        
        match crate::safe_delete_file(file_path) {
            Ok(_) => {
                results.push(CleanupResult {
                    path: path.clone(),
                    status: "deleted".to_string(),
                });
                if let Some(parent) = file_path.parent() {
                    if parent.exists() {
                        if let Ok(entries) = std::fs::read_dir(parent) {
                            let count = entries.count();
                            if count == 0 {
                                let _ = std::fs::remove_dir(parent);
                            }
                        }
                    }
                }
            }
            Err(e) => {
                results.push(CleanupResult {
                    path: path.clone(),
                    status: format!("delete_failed: {}", e),
                });
            }
        }
    }
    
    Ok(CleanupReport { results })
}

#[allow(dead_code)]
struct DbTrack {
    id: String,
    folder_path: String,
    file_name: String,
    title: String,
    artist: String,
    album: String,
    genre: String,
    bpm_num: i64,
    year_num: i64,
    key: String,
}

/// Lightweight library entry for cross-checking staged files (ingestion
/// library match). Reads only — safe while Rekordbox is open.
pub(crate) struct LibraryEntry {
    pub(crate) path: std::path::PathBuf,
    pub(crate) file_name: String,
    pub(crate) title: String,
    pub(crate) artist: String,
}

/// Every track known to the live `master.db`. Errors when the database is
/// missing or unreadable — callers fall back to staged-only behavior.
pub(crate) fn list_library_entries() -> Result<Vec<LibraryEntry>, String> {
    with_rekordbox_query_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT c.FolderPath, c.FileNameL, c.Title, a.Name AS ArtistName \
                 FROM djmdContent c LEFT JOIN djmdArtist a ON c.ArtistID = a.ID",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut entries = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let folder_path: String = row.get(0).map_err(|e| e.to_string())?;
            let file_name: String = row.get(1).unwrap_or_default();
            let title: String = row.get(2).unwrap_or_default();
            let artist: String = row.get(3).unwrap_or_default();
            entries.push(LibraryEntry {
                path: std::path::PathBuf::from(&folder_path),
                file_name,
                title,
                artist,
            });
        }
        Ok(entries)
    })
}

#[tauri::command]
pub async fn execute_db_consolidation(
    window: tauri::Window,
    destination_path: String,
    file_mode: String,
    cross_format: String,
    dedup_depth: String,
    renaming_rule: String,
    threshold: Option<f64>,
) -> Result<ResultPayload, String> {
    let threshold = sanitize_threshold(threshold);
    tokio::task::spawn_blocking(move || {
        let live_db_path = get_rekordbox_db_path()?;
        if !live_db_path.exists() {
            return Err("Rekordbox master.db database not found".to_string());
        }
        
        if is_rekordbox_running() {
            return Err("Rekordbox process is active; database is locked. Close Rekordbox first.".to_string());
        }
        
        let timestamp = if let Ok(out) = std::process::Command::new("date").arg("+%Y%m%d_%H%M").output() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            "unknown".to_string()
        };
        
        let db_dir = live_db_path.parent().unwrap();
        let backup_filename = format!("master.db.backup_{}", timestamp);
        let backup_path = db_dir.join(&backup_filename);
        std::fs::copy(&live_db_path, &backup_path).map_err(|e| format!("Failed to create database backup: {}", e))?;
        
        let mut conn = open_rekordbox_db(&live_db_path)?;
        
        let query = "
            SELECT 
                c.ID, 
                c.FolderPath, 
                c.FileNameL, 
                c.Title,
                a.Name AS ArtistName,
                al.Name AS AlbumName,
                g.Name AS GenreName,
                c.BPM,
                c.ReleaseYear,
                k.ScaleName AS KeyName
            FROM djmdContent c
            LEFT JOIN djmdArtist a ON c.ArtistID = a.ID
            LEFT JOIN djmdAlbum al ON c.AlbumID = al.ID
            LEFT JOIN djmdGenre g ON c.GenreID = g.ID
            LEFT JOIN djmdKey k ON c.KeyID = k.ID
        ";
        
        let mut tracks = Vec::new();
        {
            let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let id: String = row.get(0).map_err(|e| e.to_string())?;
                let folder_path: String = row.get(1).map_err(|e| e.to_string())?;
                let file_name: String = row.get(2).map_err(|e| e.to_string())?;
                let title: String = row.get(3).unwrap_or_default();
                let artist: String = row.get(4).unwrap_or_default();
                let album: String = row.get(5).unwrap_or_default();
                let genre: String = row.get(6).unwrap_or_default();
                let bpm_num: i64 = row.get(7).unwrap_or(0);
                let year_num: i64 = row.get(8).unwrap_or(0);
                let key: String = row.get(9).unwrap_or_default();
                
                tracks.push(DbTrack {
                    id,
                    folder_path,
                    file_name,
                    title,
                    artist,
                    album,
                    genre,
                    bpm_num,
                    year_num,
                    key,
                });
            }
        }
        
        let total = tracks.len();
        let mut processed = 0;
        let mut healthy_count = 0;
        let mut missing_count = 0;
        let mut duplicate_count = 0;
        let mut processed_list = Vec::new();
        let mut duplicate_list = Vec::new();
        let mut missing_list = Vec::new();
        
        let mut fingerprint_cache: std::collections::HashMap<std::path::PathBuf, Vec<u32>> = std::collections::HashMap::new();
        if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
            let _ = window.emit("rebuilder-consolidation-progress", ConsolidationProgressPayload {
                filename: "Pre-analyzing audio files...".to_string(),
                processed: 0,
                total: 0,
                percentage: 0.0,
            });
            
            let fpcalc_path = get_fpcalc_path(&window.app_handle());

            let mut persistent_cache =
                FingerprintCache::load(&window.app_handle());
            let mut paths_to_fingerprint = Vec::new();
            for track in &tracks {
                let src_path = std::path::PathBuf::from(&track.folder_path);
                if !src_path.exists() {
                    continue;
                }
                // Persistent cache first: unchanged files skip fpcalc entirely.
                if let Some(fp) = persistent_cache.get(&src_path) {
                    fingerprint_cache.insert(src_path, fp);
                } else {
                    paths_to_fingerprint.push(src_path);
                }
            }
            
            let paths_len = paths_to_fingerprint.len();
            if paths_len > 0 {
                let handle = tokio::runtime::Handle::current();
                let results = handle.block_on(async {
                    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
                    let mut tasks = Vec::new();
                    for path in paths_to_fingerprint {
                        let fpcalc_path_clone = fpcalc_path.clone();
                        let sem_clone = sem.clone();
                        tasks.push(tokio::spawn(async move {
                            let _permit = sem_clone.acquire().await.unwrap();
                            let path_clone = path.clone();
                            let fp = tokio::task::spawn_blocking(move || {
                                get_audio_fingerprint(&fpcalc_path_clone, &path_clone)
                            }).await.ok().flatten();
                            (path, fp)
                        }));
                    }
                    
                    let mut resolved = Vec::new();
                    let mut completed = 0;
                    for task in tasks {
                        if let Ok(res) = task.await {
                            resolved.push(res);
                        }
                        completed += 1;
                        let percentage = (completed as f64 * 100.0) / paths_len as f64;
                        let _ = window.emit("rebuilder-consolidation-progress", ConsolidationProgressPayload {
                            filename: format!("Acoustic Analysis: {}/{} files", completed, paths_len),
                            processed: completed,
                            total: paths_len,
                            percentage,
                        });
                    }
                    resolved
                });
                
                for (path, fp_opt) in results {
                    if let Some(fp) = fp_opt {
                        persistent_cache.insert(&path, fp.clone());
                        fingerprint_cache.insert(path, fp);
                    }
                }
                persistent_cache.save();
            }
        }
        
        let mut processed_strict_map: std::collections::HashMap<(u64, String), (std::path::PathBuf, String)> = std::collections::HashMap::new();
        let mut processed_standard_map: std::collections::HashMap<(String, String), (std::path::PathBuf, String, u64, String)> = std::collections::HashMap::new();
        let mut processed_fingerprints: Vec<(Vec<u32>, std::path::PathBuf, String, u64, String)> = Vec::new();
        
        let dest_dir = std::path::Path::new(&destination_path);
        if !dest_dir.exists() {
            return Err(format!("Destination directory does not exist: {}", destination_path));
        }
        
        let tx = conn.transaction().map_err(|e| format!("Failed to start database transaction: {}", e))?;
        
        for track in &tracks {
            processed += 1;
            let src_path = std::path::Path::new(&track.folder_path);
            let filename_str = track.file_name.clone();
            
            if !src_path.exists() {
                missing_count += 1;
                missing_list.push(track.folder_path.clone());
                
                let percentage = if total > 0 {
                    (processed as f64 * 100.0) / total as f64
                } else {
                    0.0
                };
                
                let progress = ConsolidationProgressPayload {
                    filename: format!("(Missing) {}", filename_str),
                    processed,
                    total,
                    percentage,
                };
                let _ = window.emit("rebuilder-consolidation-progress", progress);
            } else {
                healthy_count += 1;
                
                let file_size = std::fs::metadata(&src_path).map(|m| m.len()).unwrap_or(0);
                
                let mut target_path: std::path::PathBuf;
                let mut is_duplicate = false;
                let mut duplicate_target_path = None;
                let mut duplicate_keeper_id: Option<String> = None;
                let mut current_fp = None;
                let mut should_swap_duplicate = false;
                let mut swap_prev_path = None;
                let mut swap_prev_id: Option<String> = None;

                // Check if file is a Rekordbox Sampler/Groove Circuit or Demo Tracks file to skip moving/copying it, keeping original path
                let normalized_src = src_path.to_string_lossy().replace('\\', "/");
                let is_sampler_file = normalized_src.contains("/rekordbox/Sampler/") 
                    || normalized_src.contains("/Rekordbox/Sampler/")
                    || normalized_src.contains("/PioneerDJ/Demo Tracks/");

                if dedup_depth == "strict" || dedup_depth == "tier1" {
                    let key = (file_size, filename_str.clone());
                    if let Some((prev_path, prev_id)) = processed_strict_map.get(&key) {
                        is_duplicate = true;
                        duplicate_target_path = Some(prev_path.clone());
                        duplicate_keeper_id = Some(prev_id.clone());
                    }
                } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                    let key = (track.artist.to_lowercase(), track.title.to_lowercase());
                    if let Some(&(ref prev_path, ref prev_ext, prev_size, ref prev_id)) = processed_standard_map.get(&key) {
                        let current_ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                        if cross_format == "smart" || prev_ext == &current_ext {
                            is_duplicate = true;
                            duplicate_target_path = Some(prev_path.clone());
                            duplicate_keeper_id = Some(prev_id.clone());
                            if is_better_quality(&current_ext, file_size, prev_ext, prev_size) {
                                should_swap_duplicate = true;
                                swap_prev_path = Some(prev_path.clone());
                                swap_prev_id = Some(prev_id.clone());
                            }
                        }
                    }
                } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                    let fp = fingerprint_cache.get(src_path).cloned().or_else(|| {
                        let fpcalc_path = get_fpcalc_path(&window.app_handle());
                        get_audio_fingerprint(&fpcalc_path, src_path)
                    });
                    if let Some(fp_val) = fp {
                        for (prev_fp, prev_path, prev_ext, prev_size, prev_id) in &processed_fingerprints {
                            let sim = calculate_similarity(&fp_val, prev_fp, threshold);
                            if sim > threshold {
                                let current_ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                                if cross_format == "smart" || prev_ext == &current_ext {
                                    is_duplicate = true;
                                    duplicate_target_path = Some(prev_path.clone());
                                    duplicate_keeper_id = Some(prev_id.clone());
                                    if is_better_quality(&current_ext, file_size, prev_ext, *prev_size) {
                                        should_swap_duplicate = true;
                                        swap_prev_path = Some(prev_path.clone());
                                        swap_prev_id = Some(prev_id.clone());
                                    }
                                    break;
                                }
                            }
                        }
                        current_fp = Some(fp_val);
                    }
                }

                let mut needs_write = true;
                if is_duplicate && !should_swap_duplicate {
                    target_path = duplicate_target_path.unwrap();
                    needs_write = false;
                } else if is_sampler_file {
                    target_path = src_path.to_path_buf();
                    needs_write = false;
                } else {
                    if should_swap_duplicate {
                        if let Some(ref p_path) = swap_prev_path {
                            if p_path.exists() {
                                let _ = std::fs::remove_file(p_path);
                            }
                        }
                    }
                    let ext = src_path.extension()
                        .map(|e| e.to_string_lossy().to_string())
                        .unwrap_or_else(|| "mp3".to_string());
                        
                    let stem = match renaming_rule.as_str() {
                        "clean" => {
                            let artist_clean = sanitize_filename(&track.artist);
                            let title_clean = sanitize_filename(&track.title);
                            let artist_val = if artist_clean.is_empty() { "Unknown Artist".to_string() } else { artist_clean };
                            let title_val = if title_clean.is_empty() { "Unknown Title".to_string() } else { title_clean };
                            format!("{} - {}", artist_val, title_val)
                        }
                        "performance" => {
                            let artist_clean = sanitize_filename(&track.artist);
                            let title_clean = sanitize_filename(&track.title);
                            let bpm_val = if track.bpm_num > 0 { (track.bpm_num / 100).to_string() } else { "0".to_string() };
                            let key_clean = sanitize_filename(&track.key);
                            
                            let artist_val = if artist_clean.is_empty() { "Unknown Artist".to_string() } else { artist_clean };
                            let title_val = if title_clean.is_empty() { "Unknown Title".to_string() } else { title_clean };
                            let key_val = if key_clean.is_empty() { "Unknown Key".to_string() } else { key_clean };
                            format!("{} - {} - {} - {}", bpm_val, key_val, artist_val, title_val)
                        }
                        _ => src_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Unknown Track".to_string()),
                    };
                    
                    let truncated_stem = {
                        let max_stem_len = 120;
                        let mut truncated = String::new();
                        let mut char_count = 0;
                        for c in stem.chars() {
                            if char_count >= max_stem_len {
                                break;
                            }
                            truncated.push(c);
                            char_count += 1;
                        }
                        truncated.trim_end().to_string()
                    };
                    
                    let new_filename = format!("{}.{}", truncated_stem, ext);
                    
                    let bpm_val = if track.bpm_num > 0 { (track.bpm_num / 100).to_string() } else { "0".to_string() };
                    let bpm_num: u32 = bpm_val.parse().unwrap_or(0);
                    let _bpm_folder = if bpm_num > 0 {
                        let start = (bpm_num / 10) * 10;
                        format!("{}-{}", start, start + 9)
                    } else {
                        "Unknown BPM".to_string()
                    };
                    
                    let target_dir = dest_dir.to_path_buf();
                    
                    if let Err(e) = std::fs::create_dir_all(&target_dir) {
                        eprintln!("[Consolidation Error] Failed to create directories {:?}: {}", target_dir, e);
                    }
                    
                    target_path = target_dir.join(&new_filename);
                    let mut counter = 1;
                    
                    while target_path.exists() {
                        if let Ok(target_meta) = std::fs::metadata(&target_path) {
                            if target_meta.len() == file_size {
                                needs_write = false;
                                break;
                            }
                        }
                        let final_filename = format!("{} ({}).{}", truncated_stem, counter, ext);
                        target_path = target_dir.join(&final_filename);
                        counter += 1;
                    }
                }
                
                let mut copy_success = true;
                if is_duplicate && !should_swap_duplicate {
                    duplicate_count += 1;
                } else if needs_write {
                    let op_result = match file_mode.as_str() {
                        "move" => std::fs::rename(&src_path, &target_path),
                        "hardlink" | "link" => std::fs::hard_link(&src_path, &target_path),
                        _ => std::fs::copy(&src_path, &target_path).map(|_| ()),
                    };
                    
                    if let Err(e) = op_result {
                        eprintln!("[Consolidation Error] Failed operation for {:?} -> {:?}: {}", src_path, target_path, e);
                        copy_success = false;
                        healthy_count -= 1;
                        missing_count += 1;
                        missing_list.push(format!("{} (Operation error: {})", track.folder_path.clone(), e));
                    }
                }
                
                if copy_success {
                    let new_folder_path = target_path.to_string_lossy().to_string();
                    let new_file_name = target_path.file_name().unwrap().to_string_lossy().to_string();
                    
                    if is_duplicate && !should_swap_duplicate {
                        // Merge duplicate track ID references into keeper track ID, then delete duplicate track row from djmdContent
                        if let Some(ref keeper_id) = duplicate_keeper_id {
                            let _ = merge_duplicate_content_id(&tx, keeper_id, &track.id);
                        }
                        duplicate_list.push(vec![
                            target_path.to_string_lossy().to_string(),
                            src_path.to_string_lossy().to_string()
                        ]);
                    } else {
                        let update_res = tx.execute(
                            "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE ID = ?",
                            rusqlite::params![new_folder_path, new_file_name, track.id],
                        );
                        if let Err(e) = update_res {
                            eprintln!("[Consolidation Error] Failed to update DB for track {}: {}", track.id, e);
                        }

                        processed_list.push(target_path.to_string_lossy().to_string());
                        
                        if should_swap_duplicate {
                            duplicate_count += 1;
                            
                            if let Some(ref p_id) = swap_prev_id {
                                let _ = merge_duplicate_content_id(&tx, &track.id, p_id);
                            }

                            if let Some(ref p_path) = swap_prev_path {
                                let p_path_str = p_path.to_string_lossy().to_string();
                                if let Some(pos) = processed_list.iter().position(|x| x == &p_path_str) {
                                    processed_list.remove(pos);
                                }
                                
                                for entry in &mut duplicate_list {
                                    if entry[0] == p_path_str {
                                        entry[0] = target_path.to_string_lossy().to_string();
                                    }
                                }
                                duplicate_list.push(vec![
                                    target_path.to_string_lossy().to_string(),
                                    p_path_str
                                ]);
                            }
                        }
                        
                        let current_ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                        if dedup_depth == "strict" || dedup_depth == "tier1" {
                            let key = (file_size, filename_str.clone());
                            processed_strict_map.insert(key, (target_path.clone(), track.id.clone()));
                        } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                            let key = (track.artist.to_lowercase(), track.title.to_lowercase());
                            processed_standard_map.insert(key, (target_path.clone(), current_ext, file_size, track.id.clone()));
                        } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                            if let Some(fp_val) = current_fp {
                                let mut updated = false;
                                if let Some(ref p_path) = swap_prev_path {
                                    for entry in &mut processed_fingerprints {
                                        if &entry.1 == p_path {
                                            entry.0 = fp_val.clone();
                                            entry.1 = target_path.clone();
                                            entry.2 = current_ext.clone();
                                            entry.3 = file_size;
                                            entry.4 = track.id.clone();
                                            updated = true;
                                            break;
                                        }
                                    }
                                }
                                if !updated {
                                    processed_fingerprints.push((fp_val, target_path.clone(), current_ext, file_size, track.id.clone()));
                                }
                            }
                        }
                    }
                }
                
                let percentage = if total > 0 {
                    (processed as f64 * 100.0) / total as f64
                } else {
                    0.0
                };
                
                let label_prefix = if is_duplicate {
                    "(Duplicate) "
                } else if !copy_success {
                    "(Failed) "
                } else {
                    ""
                };
                
                let progress = ConsolidationProgressPayload {
                    filename: format!("{}{}", label_prefix, filename_str),
                    processed,
                    total,
                    percentage,
                };
                let _ = window.emit("rebuilder-consolidation-progress", progress);
            }
        }
        
        let _ = cleanup_master_db_duplicates(&tx);
        tx.commit().map_err(|e| format!("Failed to commit database changes: {}", e))?;
        
        Ok(ResultPayload {
            success: true,
            healthy_count,
            missing_count,
            duplicate_count,
            missing_list,
            backup_filename: Some(backup_filename),
            processed_list: Some(processed_list),
            duplicate_list: Some(duplicate_list),
            library_matched_count: 0,
        })
    }).await.map_err(|e| format!("Blocking task failed to join: {}", e))?
}

#[tauri::command]
pub async fn rollback_to_latest_backup() -> Result<String, String> {
    if is_rekordbox_running() {
        return Err("Rekordbox process is active; database is locked. Close Rekordbox first.".to_string());
    }
    let db_path = get_rekordbox_db_path()?;
    let db_dir = db_path.parent().ok_or_else(|| "Failed to get database parent directory".to_string())?;
    
    let backups = get_db_backups().await?;
    if backups.is_empty() {
        return Err("No database backups found to restore.".to_string());
    }
    
    let latest_backup = &backups[0];
    let backup_path = db_dir.join(latest_backup);
    
    std::fs::copy(&backup_path, &db_path)
        .map_err(|e| format!("Failed to restore backup: {}", e))?;
        
    crate::safe_delete_file(&backup_path)
        .map_err(|e| format!("Successfully restored database, but failed to move backup to trash: {}", e))?;
        
    Ok(latest_backup.clone())
}

fn get_all_child_playlist_ids(
    conn: &rusqlite::Connection,
    folder_id: &str,
    playlist_ids: &mut Vec<String>,
) -> Result<(), String> {
    let query = "SELECT ID, Attribute FROM djmdPlaylist WHERE ParentID = ?";
    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([folder_id]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let child_id: String = row.get(0).unwrap_or_default();
        let attr: i32 = row.get(1).unwrap_or(0);
        if attr == 1 {
            get_all_child_playlist_ids(conn, &child_id, playlist_ids)?;
        } else {
            playlist_ids.push(child_id);
        }
    }
    Ok(())
}

fn open_rekordbox_db_readonly(db_path: &std::path::Path) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("Failed to open DB read-only: {}", e))?;

    let key1 = "PRAGMA key = \"402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497\";";
    if let Ok(mut stmt) = conn.prepare(key1) {
        let _ = stmt.query([]);
    }
    let mut check1_ok = false;
    if let Ok(mut s) = conn.prepare("PRAGMA table_info(djmdContent)") {
        if s.query([]).is_ok() {
            check1_ok = true;
        }
    }
    if check1_ok {
        return Ok(conn);
    }

    let key2 = "PRAGMA key = \"x'402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497'\";";
    if let Ok(mut stmt) = conn.prepare(key2) {
        let _ = stmt.query([]);
    }
    let mut check2_ok = false;
    if let Ok(mut s) = conn.prepare("PRAGMA table_info(djmdContent)") {
        if s.query([]).is_ok() {
            check2_ok = true;
        }
    }
    if check2_ok {
        return Ok(conn);
    }

    Err("Failed to decrypt database with any key format".to_string())
}

fn with_rekordbox_query_conn<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&rusqlite::Connection) -> Result<T, String>,
{
    let db_path = get_rekordbox_db_path()?;
    if !db_path.exists() {
        return Err("Rekordbox master.db database not found".to_string());
    }

    // Try direct read-only connection first (fast, zero copies)
    if let Ok(conn) = open_rekordbox_db_readonly(&db_path) {
        return f(&conn);
    }

    // Fallback: create unique snapshot if locked
    let unique_name = format!(
        "crateup_snap_{}_{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let temp_db_path = std::env::temp_dir().join(unique_name);
    std::fs::copy(&db_path, &temp_db_path)
        .map_err(|e| format!("Failed to create temporary database copy: {}", e))?;

    let res = (|| {
        let conn = open_rekordbox_db(&temp_db_path)?;
        f(&conn)
    })();

    let _ = std::fs::remove_file(&temp_db_path);
    res
}

#[tauri::command]
pub async fn parse_playlists_from_db() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        with_rekordbox_query_conn(|conn| {
            struct RawPlaylist {
                id: String,
                parent_id: String,
                name: String,
                attribute: i32,
            }

            let mut raw_playlists = Vec::new();
            let query = "SELECT ID, ParentID, Name, Attribute FROM djmdPlaylist ORDER BY Seq ASC";
            let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
            let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let id: String = row.get(0).unwrap_or_default();
                let parent_id: String = row.get(1).unwrap_or_default();
                let name: String = row.get(2).unwrap_or_default();
                let attribute: i32 = row.get(3).unwrap_or(0);
                raw_playlists.push(RawPlaylist { id, parent_id, name, attribute });
            }

            #[derive(serde::Serialize, Clone)]
            struct UiPlaylistNode {
                name: String,
                #[serde(rename = "type")]
                node_type: String,
                #[serde(skip_serializing_if = "Option::is_none")]
                children: Option<Vec<UiPlaylistNode>>,
                #[serde(skip_serializing_if = "Option::is_none")]
                #[serde(rename = "totalTracks")]
                total_tracks: Option<i32>,
                #[serde(skip_serializing_if = "Option::is_none")]
                #[serde(rename = "entryCount")]
                entry_count: Option<i32>,
                id: String,
            }

            fn get_song_count(conn: &rusqlite::Connection, playlist_id: &str) -> i32 {
                let count_query = "SELECT COUNT(*) FROM djmdSongPlaylist WHERE PlaylistID = ?";
                conn.query_row(count_query, [playlist_id], |row| row.get(0)).unwrap_or(0)
            }

            fn build_node(
                conn: &rusqlite::Connection,
                raw: &RawPlaylist,
                all_raw: &[RawPlaylist],
            ) -> UiPlaylistNode {
                let is_folder = raw.attribute == 1;
                let node_type = if is_folder { "folder".to_string() } else { "playlist".to_string() };
                
                let mut children = None;
                let mut total_tracks = None;
                let mut entry_count = None;

                if is_folder {
                    let mut child_nodes = Vec::new();
                    let mut sum_tracks = 0;
                    for item in all_raw {
                        if item.parent_id == raw.id {
                            let child_node = build_node(conn, item, all_raw);
                            if child_node.node_type == "playlist" {
                                sum_tracks += child_node.entry_count.unwrap_or(0);
                            } else {
                                sum_tracks += child_node.total_tracks.unwrap_or(0);
                            }
                            child_nodes.push(child_node);
                        }
                    }
                    children = Some(child_nodes);
                    total_tracks = Some(sum_tracks);
                } else {
                    entry_count = Some(get_song_count(conn, &raw.id));
                }

                UiPlaylistNode {
                    name: raw.name.clone(),
                    node_type,
                    children,
                    total_tracks,
                    entry_count,
                    id: raw.id.clone(),
                }
            }

            let mut root_nodes = Vec::new();
            for item in &raw_playlists {
                if item.parent_id == "root" {
                    root_nodes.push(build_node(conn, item, &raw_playlists));
                }
            }

            serde_json::to_string(&root_nodes).map_err(|e| e.to_string())
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_playlist_tracks_from_db(playlist_name: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        with_rekordbox_query_conn(|conn| {
            let mut paths = Vec::new();

            if playlist_name == "ROOT" {
                let query = "SELECT FolderPath FROM djmdContent";
                let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
                let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let path: String = row.get(0).unwrap_or_default();
                    if !path.is_empty() {
                        paths.push(path);
                    }
                }
            } else {
                let pl_query = "SELECT ID FROM djmdPlaylist WHERE Name = ? AND Attribute = 0 LIMIT 1";
                let pl_id: Option<String> = conn.query_row(pl_query, [&playlist_name], |row| row.get(0)).optional().map_err(|e| e.to_string())?;
                
                if let Some(id) = pl_id {
                    let track_query = "
                        SELECT c.FolderPath 
                        FROM djmdSongPlaylist sp
                        JOIN djmdContent c ON sp.ContentID = c.ID
                        WHERE sp.PlaylistID = ?
                        ORDER BY sp.TrackNo ASC
                    ";
                    let mut stmt = conn.prepare(track_query).map_err(|e| e.to_string())?;
                    let mut rows = stmt.query([&id]).map_err(|e| e.to_string())?;
                    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                        let path: String = row.get(0).unwrap_or_default();
                        if !path.is_empty() {
                            paths.push(path);
                        }
                    }
                }
            }

            Ok(paths)
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_folder_tracks_from_db(folder_name: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        with_rekordbox_query_conn(|conn| {
            let mut paths = Vec::new();

            let folder_query = "SELECT ID FROM djmdPlaylist WHERE Name = ? AND Attribute = 1 LIMIT 1";
            let folder_id: Option<String> = conn.query_row(folder_query, [&folder_name], |row| row.get(0)).optional().map_err(|e| e.to_string())?;

            if let Some(fid) = folder_id {
                let mut playlist_ids = Vec::new();
                get_all_child_playlist_ids(conn, &fid, &mut playlist_ids)?;

                if !playlist_ids.is_empty() {
                    let track_query = "
                        SELECT DISTINCT c.FolderPath 
                        FROM djmdSongPlaylist sp
                        JOIN djmdContent c ON sp.ContentID = c.ID
                        WHERE sp.PlaylistID = ?
                    ";
                    let mut stmt = conn.prepare(track_query).map_err(|e| e.to_string())?;
                    for pid in playlist_ids {
                        let mut rows = stmt.query([&pid]).map_err(|e| e.to_string())?;
                        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                            let path: String = row.get(0).unwrap_or_default();
                            if !path.is_empty() {
                                paths.push(path);
                            }
                        }
                    }
                }
            }

            Ok(paths)
        })
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn update_rekordbox_db_directly(
    ledger_path: String,
    decisions: std::collections::HashMap<String, String>,
    output_path: String,
    output_strategy: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let live_db_path = get_rekordbox_db_path()?;
        if !live_db_path.exists() {
            return Err("Rekordbox master.db database not found".to_string());
        }

        if is_rekordbox_running() {
            return Err("Rekordbox process is active; database is locked. Close Rekordbox first.".to_string());
        }

        let timestamp = if let Ok(out) = std::process::Command::new("date").arg("+%Y%m%d_%H%M").output() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            "unknown".to_string()
        };
        let db_dir = live_db_path.parent().unwrap();
        let backup_path = db_dir.join(format!("master.db.backup_{}", timestamp));
        std::fs::copy(&live_db_path, &backup_path).map_err(|e| format!("Failed to create database backup: {}", e))?;

        let mut conn = open_rekordbox_db(&live_db_path)?;

        let ledger_content = std::fs::read_to_string(&ledger_path).map_err(|e| e.to_string())?;
        let ledger_json: serde_json::Value = serde_json::from_str(&ledger_content).map_err(|e| e.to_string())?;
        
        let root_path = ledger_json.get("root_path").and_then(|v| v.as_str()).ok_or("Missing root_path in ledger")?;
        let output_format = ledger_json.get("output_format").and_then(|v| v.as_str()).unwrap_or("flac");
        let files = ledger_json.get("files").and_then(|v| v.as_object()).ok_or("Missing files object in ledger")?;

        let tx = conn.transaction().map_err(|e| format!("Failed to start database transaction: {}", e))?;

        for (rel_path, entry_val) in files {
            let decision = decisions.get(rel_path).map(|s| s.as_str()).unwrap_or("skipped");
            if decision != "approved" {
                continue;
            }

            let entry = entry_val.as_object().ok_or("Invalid file entry")?;
            let status = entry.get("status").and_then(|v| v.as_str()).unwrap_or("");
            let staged_path = entry.get("staged_path").and_then(|v| v.as_str()).unwrap_or("");

            let original_abs_path = std::path::Path::new(root_path).join(rel_path.trim_start_matches('/'));
            let original_abs_path_str = original_abs_path.to_string_lossy().to_string();

            let new_abs_path = if output_strategy == "replace" {
                let ext = original_abs_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                let new_ext = if status == "downloaded" && !staged_path.is_empty() {
                    let sp = std::path::Path::new(staged_path);
                    sp.extension().and_then(|e| e.to_str()).unwrap_or(output_format)
                } else {
                    ext
                };
                original_abs_path.with_extension(new_ext)
            } else {
                let rel_clean = rel_path.trim_start_matches('/');
                let mut target_basename = original_abs_path.file_name().unwrap().to_string_lossy().to_string();
                if status == "downloaded" && !staged_path.is_empty() {
                    let sp = std::path::Path::new(staged_path);
                    target_basename = sp.file_name().unwrap().to_string_lossy().to_string();
                }
                
                if output_strategy == "consolidate" {
                    std::path::Path::new(&output_path).join(target_basename)
                } else {
                    std::path::Path::new(&output_path).join(rel_clean).with_file_name(target_basename)
                }
            };

            let new_abs_path_str = new_abs_path.to_string_lossy().to_string();
            let new_filename = new_abs_path.file_name().unwrap().to_string_lossy().to_string();

            tx.execute(
                "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE FolderPath = ?",
                [&new_abs_path_str, &new_filename, &original_abs_path_str]
            ).map_err(|e| format!("Failed to update database record for {}: {}", rel_path, e))?;
        }

        let _ = cleanup_master_db_duplicates(&tx);
        tx.commit().map_err(|e| format!("Failed to commit database changes: {}", e))?;

        Ok(())
    }).await.map_err(|e| e.to_string())?
}
