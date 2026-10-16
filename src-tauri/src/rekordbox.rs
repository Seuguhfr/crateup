//! Direct Rekordbox `master.db` (SQLCipher) access: playlist/tree reads,
//! database consolidation, backups, cleanup, duplicate repair, and direct
//! commit-time path sync. Extracted from lib.rs.

use rusqlite::OptionalExtension;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;
use tauri::Manager;

use crate::fingerprint_cache::FingerprintCache;
use crate::similarity::{
    get_audio_fingerprint, get_ffmpeg_path, get_fpcalc_path,
    is_better_quality_transcode_aware, sanitize_threshold,
};
use crate::waveform::check_is_transcode;
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

fn get_backup_timestamp() -> String {
    if let Ok(out) = std::process::Command::new("/bin/date").arg("+%Y%m%d_%H%M%S").output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    if let Ok(out) = std::process::Command::new("date").arg("+%Y%m%d_%H%M%S").output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}_{:09}", duration.as_secs(), duration.subsec_nanos())
}

fn create_master_db_backup(
    conn: &rusqlite::Connection,
    live_db_path: &std::path::Path,
    backup_path: &std::path::Path,
) -> Result<(), String> {
    // 1. Attempt WAL TRUNCATE checkpoint to flush uncommitted pages into master.db
    let checkpoint_res: Result<(i32, i32, i32), _> = conn.query_row(
        "PRAGMA wal_checkpoint(TRUNCATE);",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    );

    let (busy, _log, _ckp) = checkpoint_res.unwrap_or((1, -1, -1));

    // 2. Copy the main database file
    std::fs::copy(live_db_path, backup_path)
        .map_err(|e| format!("Failed to create database backup: {}", e))?;

    // 3. If TRUNCATE was busy or failed, and a non-empty -wal file remains, preserve it alongside the backup
    if let Some(db_dir) = live_db_path.parent() {
        let wal_path = db_dir.join("master.db-wal");
        if wal_path.exists() {
            let wal_len = std::fs::metadata(&wal_path).map(|m| m.len()).unwrap_or(0);
            if busy != 0 && wal_len > 0 {
                let backup_wal_name = format!("{}-wal", backup_path.file_name().unwrap().to_string_lossy());
                let backup_wal_path = db_dir.join(backup_wal_name);
                let _ = std::fs::copy(&wal_path, &backup_wal_path);
            }
        }
    }

    Ok(())
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
            if let Some(last_part) = cmd_lower.split('/').next_back() {
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

        for val in rows.flatten() {
            dup_rows.push(val);
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

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RekordboxBackup {
    pub filename: String,
    pub created_at: String,
    pub size_bytes: u64,
    pub is_active: bool,
    pub is_newer_than_active: bool,
    pub total_tracks: usize,
    pub intact_tracks: usize,
    pub missing_tracks: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RollbackResult {
    pub restored_filename: String,
    pub created_safety_backup: Option<String>,
    pub total_tracks: usize,
    pub intact_tracks: usize,
    pub missing_tracks: usize,
    pub healed_paths_count: usize,
}

type HealthCacheKey = (String, u64, u64);
type HealthStats = (usize, usize, usize);
type HealthMap = std::collections::HashMap<HealthCacheKey, HealthStats>;

static BACKUP_HEALTH_CACHE: OnceLock<Mutex<HealthMap>> = OnceLock::new();

fn get_health_cache() -> &'static Mutex<HealthMap> {
    BACKUP_HEALTH_CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub fn files_are_identical(path_a: &std::path::Path, path_b: &std::path::Path) -> bool {
    let meta_a = match std::fs::metadata(path_a) {
        Ok(m) => m,
        Err(_) => return false,
    };
    let meta_b = match std::fs::metadata(path_b) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if meta_a.len() != meta_b.len() {
        return false;
    }
    let mut file_a = match std::fs::File::open(path_a) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut file_b = match std::fs::File::open(path_b) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut buf_a = [0u8; 65536];
    let mut buf_b = [0u8; 65536];
    use std::io::Read;
    loop {
        let n_a = match file_a.read(&mut buf_a) {
            Ok(n) => n,
            Err(_) => return false,
        };
        let n_b = match file_b.read(&mut buf_b) {
            Ok(n) => n,
            Err(_) => return false,
        };
        if n_a != n_b {
            return false;
        }
        if n_a == 0 {
            return true;
        }
        if buf_a[..n_a] != buf_b[..n_b] {
            return false;
        }
    }
}

pub fn get_backup_disk_health(
    backup_path: &std::path::Path,
    filename: &str,
    size_bytes: u64,
    mtime_secs: u64,
) -> (usize, usize, usize) {
    let cache_key = (filename.to_string(), size_bytes, mtime_secs);
    if let Ok(guard) = get_health_cache().lock() {
        if let Some(val) = guard.get(&cache_key) {
            return *val;
        }
    }

    let (total, intact, missing) = if let Ok(conn) = open_rekordbox_db_readonly(backup_path) {
        if let Ok(mut stmt) = conn.prepare("SELECT FolderPath FROM djmdContent WHERE FolderPath IS NOT NULL AND FolderPath != ''") {
            if let Ok(mut rows) = stmt.query([]) {
                let mut tot = 0usize;
                let mut inc = 0usize;
                while let Ok(Some(row)) = rows.next() {
                    if let Ok(path) = row.get::<_, String>(0) {
                        tot += 1;
                        if std::path::Path::new(&path).exists() {
                            inc += 1;
                        }
                    }
                }
                (tot, inc, tot.saturating_sub(inc))
            } else {
                (0, 0, 0)
            }
        } else {
            (0, 0, 0)
        }
    } else {
        (0, 0, 0)
    };

    if let Ok(mut guard) = get_health_cache().lock() {
        guard.insert(cache_key, (total, intact, missing));
    }

    (total, intact, missing)
}

pub fn extract_backup_date_from_str(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.len() < 8 {
        return None;
    }
    for i in 0..=(bytes.len() - 8) {
        if i > 0 && bytes[i - 1].is_ascii_digit() {
            continue;
        }
        if !bytes[i..i + 8].iter().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let year: u32 = s[i..i + 4].parse().ok()?;
        let month: u32 = s[i + 4..i + 6].parse().ok()?;
        let day: u32 = s[i + 6..i + 8].parse().ok()?;
        if !(2000..=2099).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            continue;
        }
        let y_str = &s[i..i + 4];
        let m_str = &s[i + 4..i + 6];
        let d_str = &s[i + 6..i + 8];

        if i + 8 < bytes.len() && bytes[i + 8] == b'_' {
            let rest = &s[i + 9..];
            let rest_bytes = rest.as_bytes();
            // Case A: 6 digits (HHMMSS)
            if rest_bytes.len() >= 6 && rest_bytes[0..6].iter().all(|b| b.is_ascii_digit()) {
                let hour: u32 = rest[0..2].parse().unwrap_or(99);
                let min: u32 = rest[2..4].parse().unwrap_or(99);
                let sec: u32 = rest[4..6].parse().unwrap_or(99);
                if hour < 24 && min < 60 && sec < 60 {
                    return Some(format!(
                        "{}-{}-{} {:02}:{:02}:{:02}",
                        y_str, m_str, d_str, hour, min, sec
                    ));
                }
            }
            // Case B: 4 digits (HHMM)
            if rest_bytes.len() >= 4 && rest_bytes[0..4].iter().all(|b| b.is_ascii_digit()) {
                let not_followed_by_digit = rest_bytes.len() == 4 || !rest_bytes[4].is_ascii_digit();
                if not_followed_by_digit {
                    let hour: u32 = rest[0..2].parse().unwrap_or(99);
                    let min: u32 = rest[2..4].parse().unwrap_or(99);
                    if hour < 24 && min < 60 {
                        return Some(format!(
                            "{}-{}-{} {:02}:{:02}:00",
                            y_str, m_str, d_str, hour, min
                        ));
                    }
                }
            }
        }

        // Case C: Date only
        return Some(format!("{}-{}-{} 00:00:00", y_str, m_str, d_str));
    }
    None
}

pub fn parse_backup_date(filename: &str, metadata: Option<&std::fs::Metadata>) -> String {
    if let Some(d) = extract_backup_date_from_str(filename) {
        return d;
    }
    if let Some(meta) = metadata {
        if let Ok(mtime) = meta.modified() {
            if let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH) {
                let secs = dur.as_secs();
                if let Ok(out) = std::process::Command::new("/bin/date")
                    .args(["-r", &secs.to_string(), "+%Y-%m-%d %H:%M:%S"])
                    .output()
                {
                    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if !s.is_empty() {
                        return s;
                    }
                }
            }
        }
    }
    filename.to_string()
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
        if filename.starts_with("master.db.backup_") && !filename.ends_with("-wal") && !filename.ends_with("-shm") {
            backups.push(filename);
        }
    }
    backups.sort_by(|a, b| {
        let date_a = parse_backup_date(a, None);
        let date_b = parse_backup_date(b, None);
        date_b.cmp(&date_a).then_with(|| b.cmp(a))
    });
    Ok(backups)
}

#[tauri::command]
pub async fn list_rekordbox_backups() -> Result<Vec<RekordboxBackup>, String> {
    let db_path = get_rekordbox_db_path()?;
    let db_dir = db_path.parent().ok_or_else(|| "Failed to get database parent directory".to_string())?;
    if !db_dir.exists() {
        return Ok(Vec::new());
    }
    let mut backups = Vec::new();
    for entry in std::fs::read_dir(db_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let filename = entry.file_name().to_string_lossy().to_string();
        if filename.starts_with("master.db.backup_") && !filename.ends_with("-wal") && !filename.ends_with("-shm") {
            let metadata = entry.metadata().ok();
            let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime_secs = metadata
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let created_at = parse_backup_date(&filename, metadata.as_ref());
            let backup_path = db_dir.join(&filename);
            let is_active = if db_path.exists() {
                files_are_identical(&db_path, &backup_path)
            } else {
                false
            };
            let (total_tracks, intact_tracks, missing_tracks) =
                get_backup_disk_health(&backup_path, &filename, size_bytes, mtime_secs);

            backups.push(RekordboxBackup {
                filename,
                created_at,
                size_bytes,
                is_active,
                is_newer_than_active: false,
                total_tracks,
                intact_tracks,
                missing_tracks,
            });
        }
    }
    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.filename.cmp(&a.filename)));

    if let Some(active_pos) = backups.iter().position(|b| b.is_active) {
        for b in &mut backups[0..active_pos] {
            b.is_newer_than_active = true;
        }
    }

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
        
        let timestamp = get_backup_timestamp();
        
        let mut conn = open_rekordbox_db(&live_db_path)?;
        let db_dir = live_db_path.parent().unwrap();
        let backup_filename = format!("master.db.backup_{}", timestamp);
        let backup_path = db_dir.join(&backup_filename);
        create_master_db_backup(&conn, &live_db_path, &backup_path)?;
        
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
        let mut superseded_paths = Vec::new();
        let mut missing_list = Vec::new();
        
        let mut fingerprint_cache: std::collections::HashMap<std::path::PathBuf, Vec<u32>> = std::collections::HashMap::new();
        let mut transcode_cache: std::collections::HashMap<std::path::PathBuf, bool> = std::collections::HashMap::new();

        let need_fuzzy = dedup_depth == "fuzzy" || dedup_depth == "tier3";
        let need_dedup_check = cross_format == "smart" || dedup_depth == "standard" || dedup_depth == "tier2" || need_fuzzy;

        if need_dedup_check {
            let mut persistent_cache = FingerprintCache::load(window.app_handle());
            let fpcalc_path = get_fpcalc_path(window.app_handle());
            let ffmpeg_path = get_ffmpeg_path(window.app_handle());

            struct PreTask {
                path: std::path::PathBuf,
                need_fp: bool,
                need_tc: bool,
            }
            let mut tasks_to_run = Vec::new();

            for track in &tracks {
                let src_path = std::path::PathBuf::from(&track.folder_path);
                if !src_path.exists() {
                    continue;
                }
                let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                let is_lossless = matches!(ext.as_str(), "flac" | "wav" | "aiff" | "aif");

                let mut need_fp = false;
                if need_fuzzy {
                    if let Some(fp) = persistent_cache.get(&src_path) {
                        fingerprint_cache.insert(src_path.clone(), fp);
                    } else {
                        need_fp = true;
                    }
                }

                let mut need_tc = false;
                if is_lossless {
                    if let Some(tc) = persistent_cache.get_transcode(&src_path) {
                        transcode_cache.insert(src_path.clone(), tc);
                    } else {
                        need_tc = true;
                    }
                } else {
                    transcode_cache.insert(src_path.clone(), false);
                }

                if need_fp || need_tc {
                    tasks_to_run.push(PreTask {
                        path: src_path,
                        need_fp,
                        need_tc,
                    });
                }
            }

            let tasks_len = tasks_to_run.len();
            if tasks_len > 0 {
                let _ = window.emit("rebuilder-consolidation-progress", ConsolidationProgressPayload {
                    filename: "Pre-analyzing audio files...".to_string(),
                    processed: 0,
                    total: tasks_len,
                    percentage: 0.0,
                });
                let handle = tokio::runtime::Handle::current();
                let results = handle.block_on(async {
                    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
                    let mut spawned = Vec::new();
                    for task in tasks_to_run {
                        let fpcalc = fpcalc_path.clone();
                        let ffmpeg = ffmpeg_path.clone();
                        let sem_clone = sem.clone();
                        spawned.push(tokio::spawn(async move {
                            let _permit = sem_clone.acquire().await.unwrap();
                            let p = task.path.clone();
                            tokio::task::spawn_blocking(move || {
                                let fp = if task.need_fp {
                                    get_audio_fingerprint(&fpcalc, &p)
                                } else {
                                    None
                                };
                                let tc = if task.need_tc {
                                    check_is_transcode(&ffmpeg, &p).unwrap_or(false)
                                } else {
                                    false
                                };
                                (p, fp, tc, task.need_tc)
                            }).await.ok()
                        }));
                    }

                    let mut resolved = Vec::new();
                    let mut completed = 0;
                    for s in spawned {
                        if let Ok(Some(res)) = s.await {
                            resolved.push(res);
                        }
                        completed += 1;
                        let percentage = (completed as f64 * 100.0) / tasks_len as f64;
                        let _ = window.emit("rebuilder-consolidation-progress", ConsolidationProgressPayload {
                            filename: format!("Audio Pre-Analysis: {}/{} files", completed, tasks_len),
                            processed: completed,
                            total: tasks_len,
                            percentage,
                        });
                    }
                    resolved
                });

                for (path, fp_opt, tc_val, was_tc_checked) in results {
                    if let Some(fp) = fp_opt {
                        fingerprint_cache.insert(path.clone(), fp.clone());
                        persistent_cache.insert_all(&path, fp, None, if was_tc_checked { Some(tc_val) } else { None });
                    } else if was_tc_checked {
                        persistent_cache.insert_transcode(&path, tc_val);
                    }
                    if was_tc_checked {
                        transcode_cache.insert(path, tc_val);
                    }
                }
                persistent_cache.save();
            }
        }
        
        let mut processed_strict_map: std::collections::HashMap<(u64, String), (std::path::PathBuf, String)> = std::collections::HashMap::new();
        let mut processed_standard_map: std::collections::HashMap<(String, String), (std::path::PathBuf, String, u64, String)> = std::collections::HashMap::new();
        let mut processed_fingerprints: Vec<crate::similarity::FingerprintEntry> = Vec::new();
        let mut candidate_index = crate::similarity::CandidatePriorityIndex::new();
        let mut last_progress_emit = std::time::Instant::now();
        let mut last_emit_processed = 0usize;
        
        let dest_dir = std::path::Path::new(&destination_path);
        if !dest_dir.exists() {
            return Err(format!("Destination directory does not exist: {}", destination_path));
        }
        
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| format!("Failed to start database transaction: {}", e))?;
        
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
                
                let is_last = processed == total;
                if is_last || (processed - last_emit_processed >= 10 && last_progress_emit.elapsed() >= std::time::Duration::from_millis(40)) {
                    last_progress_emit = std::time::Instant::now();
                    last_emit_processed = processed;
                    let progress = ConsolidationProgressPayload {
                        filename: format!("(Missing) {}", filename_str),
                        processed,
                        total,
                        percentage,
                    };
                    let _ = window.emit("rebuilder-consolidation-progress", progress);
                }
            } else {
                healthy_count += 1;
                
                let file_size = std::fs::metadata(src_path).map(|m| m.len()).unwrap_or(0);
                
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
                            let cur_tc = *transcode_cache.get(src_path).unwrap_or(&false);
                            let prev_tc = *transcode_cache.get(prev_path).unwrap_or(&false);
                            if is_better_quality_transcode_aware(&current_ext, file_size, cur_tc, prev_ext, prev_size, prev_tc) {
                                should_swap_duplicate = true;
                                swap_prev_path = Some(prev_path.clone());
                                swap_prev_id = Some(prev_id.clone());
                            }
                        }
                    }
                } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                    let fp = fingerprint_cache.get(src_path).cloned().or_else(|| {
                        let fpcalc_path = get_fpcalc_path(window.app_handle());
                        get_audio_fingerprint(&fpcalc_path, src_path)
                    });
                    if let Some(fp_val) = fp {
                        let current_ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                        let entry = crate::similarity::FingerprintEntry::new(
                            fp_val,
                            src_path.to_path_buf(),
                            current_ext.clone(),
                            file_size,
                            track.id.clone(),
                            &track.artist,
                            &track.title,
                        );

                        let prioritized = candidate_index.get_prioritized_candidates(
                            &entry.title_tokens,
                            processed_fingerprints.len(),
                        );

                        for cand_idx in prioritized {
                            let prev_entry = &processed_fingerprints[cand_idx];
                            let sim = crate::similarity::calculate_similarity_with_profiles(
                                &entry.fp,
                                Some(&entry.profile),
                                &prev_entry.fp,
                                Some(&prev_entry.profile),
                                threshold,
                            );
                            if sim > threshold && (cross_format == "smart" || prev_entry.ext == current_ext) {
                                is_duplicate = true;
                                duplicate_target_path = Some(prev_entry.path.clone());
                                duplicate_keeper_id = Some(prev_entry.id.clone());
                                let cur_tc = *transcode_cache.get(src_path).unwrap_or(&false);
                                let prev_tc = *transcode_cache.get(&prev_entry.path).unwrap_or(&false);
                                if is_better_quality_transcode_aware(&current_ext, file_size, cur_tc, &prev_entry.ext, prev_entry.size, prev_tc) {
                                    should_swap_duplicate = true;
                                    swap_prev_path = Some(prev_entry.path.clone());
                                    swap_prev_id = Some(prev_entry.id.clone());
                                }
                                break;
                            }
                        }
                        current_fp = Some(entry);
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
                    
                    let truncated_stem = stem.chars().take(120).collect::<String>().trim_end().to_string();
                    
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
                        "move" => crate::safe_move_file(src_path, &target_path),
                        "hardlink" | "link" => std::fs::hard_link(src_path, &target_path),
                        _ => std::fs::copy(src_path, &target_path).map(|_| ()),
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
                        superseded_paths.push(src_path.to_string_lossy().to_string());
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
                                if p_path.exists() && p_path != &target_path {
                                    let _ = crate::safe_delete_file(p_path);
                                }
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
                            if let Some(mut entry) = current_fp {
                                entry.path = target_path.clone();
                                let mut updated = false;
                                if let Some(ref p_path) = swap_prev_path {
                                    for (idx, prev) in processed_fingerprints.iter_mut().enumerate() {
                                        if &prev.path == p_path {
                                            *prev = entry.clone();
                                            candidate_index.insert(idx, &entry.title_tokens);
                                            updated = true;
                                            break;
                                        }
                                    }
                                }
                                if !updated {
                                    let idx = processed_fingerprints.len();
                                    candidate_index.insert(idx, &entry.title_tokens);
                                    processed_fingerprints.push(entry);
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
                
                let is_last = processed == total;
                if is_last || (processed - last_emit_processed >= 10 && last_progress_emit.elapsed() >= std::time::Duration::from_millis(40)) {
                    last_progress_emit = std::time::Instant::now();
                    last_emit_processed = processed;
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
        }
        
        let _ = cleanup_master_db_duplicates(&tx);
        tx.commit().map_err(|e| format!("Failed to commit database changes: {}", e))?;
        
        superseded_paths.sort();
        superseded_paths.dedup();

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
            superseded_paths: Some(superseded_paths),
        })
    }).await.map_err(|e| format!("Blocking task failed to join: {}", e))?
}

#[tauri::command]
pub async fn rollback_to_latest_backup() -> Result<RollbackResult, String> {
    let backups = get_db_backups().await?;
    if backups.is_empty() {
        return Err("No database backups found to restore.".to_string());
    }
    rollback_to_backup(backups[0].clone(), None).await
}

#[tauri::command]
pub async fn rollback_to_backup(
    backup_filename: String,
    keep_valid_paths: Option<bool>,
) -> Result<RollbackResult, String> {
    if !backup_filename.starts_with("master.db.backup_")
        || backup_filename.contains('/')
        || backup_filename.contains('\\')
        || backup_filename.contains("..")
    {
        return Err(format!("Invalid backup filename: {}", backup_filename));
    }

    if is_rekordbox_running() {
        return Err("Rekordbox process is active; database is locked. Close Rekordbox first.".to_string());
    }
    let db_path = get_rekordbox_db_path()?;
    let db_dir = db_path.parent().ok_or_else(|| "Failed to get database parent directory".to_string())?;

    let backup_path = db_dir.join(&backup_filename);
    if !backup_path.exists() {
        return Err(format!("Backup file not found: {}", backup_filename));
    }

    // 1. Auto-protect unsaved live state:
    // If live master.db exists and does NOT match ANY existing backup file in db_dir,
    // automatically create a safety snapshot before restoring.
    let mut created_safety_backup = None;
    if db_path.exists() {
        let mut live_matches_any = false;
        if let Ok(entries) = std::fs::read_dir(db_dir) {
            for entry in entries.flatten() {
                let fname = entry.file_name().to_string_lossy().to_string();
                if fname.starts_with("master.db.backup_") && !fname.ends_with("-wal") && !fname.ends_with("-shm") {
                    let candidate = db_dir.join(&fname);
                    if files_are_identical(&db_path, &candidate) {
                        live_matches_any = true;
                        break;
                    }
                }
            }
        }
        if !live_matches_any {
            let ts = get_backup_timestamp();
            let safety_name = format!("master.db.backup_{}_pre_rollback", ts);
            let safety_path = db_dir.join(&safety_name);
            let _ = std::fs::copy(&db_path, &safety_path);

            let live_wal = db_dir.join("master.db-wal");
            if live_wal.exists() {
                let safety_wal_name = format!("{}-wal", safety_name);
                let safety_wal = db_dir.join(&safety_wal_name);
                let _ = std::fs::copy(&live_wal, &safety_wal);
            }
            created_safety_backup = Some(safety_name);
        }
    }

    // 2. If keep_valid_paths is requested, harvest valid disk paths from the live database
    let mut live_valid_paths = std::collections::HashMap::new();
    if keep_valid_paths.unwrap_or(false) && db_path.exists() {
        if let Ok(conn_live) = open_rekordbox_db_readonly(&db_path) {
            if let Ok(mut stmt) = conn_live.prepare("SELECT ID, FolderPath, FileNameL FROM djmdContent WHERE FolderPath IS NOT NULL AND FolderPath != ''") {
                if let Ok(mut rows) = stmt.query([]) {
                    while let Ok(Some(row)) = rows.next() {
                        let id: String = row.get(0).unwrap_or_default();
                        let folder_path: String = row.get(1).unwrap_or_default();
                        let file_name: String = row.get(2).unwrap_or_default();
                        if !id.is_empty() && !folder_path.is_empty() && std::path::Path::new(&folder_path).exists() {
                            live_valid_paths.insert(id, (folder_path, file_name));
                        }
                    }
                }
            }
        }
    }

    // 3. Restore the backup database over live master.db (NEVER deletes any backup!)
    std::fs::copy(&backup_path, &db_path)
        .map_err(|e| format!("Failed to restore backup: {}", e))?;

    let wal_path = db_dir.join("master.db-wal");
    let backup_wal_name = format!("{}-wal", backup_filename);
    let backup_wal_path = db_dir.join(&backup_wal_name);

    if backup_wal_path.exists() {
        let _ = std::fs::copy(&backup_wal_path, &wal_path);
    } else if wal_path.exists() {
        let _ = std::fs::remove_file(&wal_path);
    }

    let shm_path = db_dir.join("master.db-shm");
    if shm_path.exists() {
        let _ = std::fs::remove_file(&shm_path);
    }

    // 4. Perform smart path healing if requested
    let mut healed_paths_count = 0;
    if keep_valid_paths.unwrap_or(false) && !live_valid_paths.is_empty() {
        if let Ok(conn_restored) = open_rekordbox_db(&db_path) {
            if let Ok(mut stmt) = conn_restored.prepare("SELECT ID, FolderPath FROM djmdContent WHERE FolderPath IS NOT NULL AND FolderPath != ''") {
                let mut updates = Vec::new();
                if let Ok(mut rows) = stmt.query([]) {
                    while let Ok(Some(row)) = rows.next() {
                        let id: String = row.get(0).unwrap_or_default();
                        let folder_path: String = row.get(1).unwrap_or_default();
                        if !std::path::Path::new(&folder_path).exists() {
                            if let Some((live_folder, live_file)) = live_valid_paths.get(&id) {
                                updates.push((id, live_folder.clone(), live_file.clone()));
                            }
                        }
                    }
                }
                drop(stmt);
                for (id, live_folder, live_file) in updates {
                    if conn_restored.execute(
                        "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE ID = ?",
                        rusqlite::params![live_folder, live_file, id],
                    ).is_ok() {
                        healed_paths_count += 1;
                    }
                }
            }
        }
    }

    // 5. Compute health stats of restored database
    let (total_tracks, intact_tracks, missing_tracks) = {
        if let Ok(conn_check) = open_rekordbox_db_readonly(&db_path) {
            if let Ok(mut stmt) = conn_check.prepare("SELECT FolderPath FROM djmdContent WHERE FolderPath IS NOT NULL AND FolderPath != ''") {
                if let Ok(mut rows) = stmt.query([]) {
                    let mut tot = 0usize;
                    let mut inc = 0usize;
                    while let Ok(Some(row)) = rows.next() {
                        if let Ok(path) = row.get::<_, String>(0) {
                            tot += 1;
                            if std::path::Path::new(&path).exists() {
                                inc += 1;
                            }
                        }
                    }
                    (tot, inc, tot.saturating_sub(inc))
                } else {
                    (0, 0, 0)
                }
            } else {
                (0, 0, 0)
            }
        } else {
            (0, 0, 0)
        }
    };

    Ok(RollbackResult {
        restored_filename: backup_filename,
        created_safety_backup,
        total_tracks,
        intact_tracks,
        missing_tracks,
        healed_paths_count,
    })
}

#[tauri::command]
pub async fn trash_superseded_files(paths: Vec<String>) -> Result<usize, String> {
    let mut count = 0;
    for p in paths {
        let path = std::path::PathBuf::from(&p);
        if path.exists() {
            if let Ok(()) = crate::safe_delete_file(&path) {
                count += 1;
                if let Some(parent) = path.parent() {
                    if parent.exists() {
                        if let Ok(entries) = std::fs::read_dir(parent) {
                            if entries.count() == 0 {
                                let _ = std::fs::remove_dir(parent);
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(count)
}

#[tauri::command]
pub async fn delete_db_backup(backup_filename: String) -> Result<String, String> {
    if !backup_filename.starts_with("master.db.backup_")
        || backup_filename.contains('/')
        || backup_filename.contains('\\')
        || backup_filename.contains("..")
    {
        return Err(format!("Invalid backup filename: {}", backup_filename));
    }

    let db_path = get_rekordbox_db_path()?;
    let db_dir = db_path.parent().ok_or_else(|| "Failed to get database parent directory".to_string())?;
    let backup_path = db_dir.join(&backup_filename);

    if !backup_path.exists() {
        return Err(format!("Backup file not found: {}", backup_filename));
    }

    crate::safe_delete_file(&backup_path)
        .map_err(|e| format!("Failed to delete backup file: {}", e))?;

    let backup_wal_name = format!("{}-wal", backup_filename);
    let backup_wal_path = db_dir.join(&backup_wal_name);
    if backup_wal_path.exists() {
        let _ = crate::safe_delete_file(&backup_wal_path);
    }

    Ok(backup_filename)
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

pub fn shift_cues_for_content(
    conn: &rusqlite::Connection,
    content_id: &str,
    offset_ms: i32,
) -> rusqlite::Result<usize> {
    if offset_ms == 0 {
        return Ok(0);
    }

    conn.execute(
        "UPDATE djmdCue SET
            InMsec = CASE WHEN (InMsec + ?1) < 0 THEN 0 ELSE (InMsec + ?1) END,
            OutMsec = CASE WHEN OutMsec >= 0 THEN (CASE WHEN (OutMsec + ?1) < 0 THEN 0 ELSE (OutMsec + ?1) END) ELSE OutMsec END
         WHERE ContentID = ?2",
        rusqlite::params![offset_ms, content_id],
    )
}

#[tauri::command]
pub async fn update_rekordbox_db_directly(
    ledger_path: String,
    decisions: std::collections::HashMap<String, String>,
    output_path: String,
    output_strategy: String,
    auto_shift_cues: Option<bool>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let live_db_path = get_rekordbox_db_path()?;
        if !live_db_path.exists() {
            return Err("Rekordbox master.db database not found".to_string());
        }

        if is_rekordbox_running() {
            return Err("Rekordbox process is active; database is locked. Close Rekordbox first.".to_string());
        }

        let timestamp = get_backup_timestamp();

        let mut conn = open_rekordbox_db(&live_db_path)?;
        let db_dir = live_db_path.parent().unwrap();
        let backup_path = db_dir.join(format!("master.db.backup_{}", timestamp));
        create_master_db_backup(&conn, &live_db_path, &backup_path)?;

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

            let original_abs_path_str = if let Some(orig_saved) = entry.get("original_abs_path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                orig_saved.to_string()
            } else {
                let p = std::path::Path::new(root_path).join(rel_path.trim_start_matches('/'));
                p.to_string_lossy().to_string()
            };

            let (new_abs_path_str, new_filename) = if let Some(committed_out) = entry.get("output_path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                let p = std::path::Path::new(committed_out);
                let fname = p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
                (committed_out.to_string(), fname)
            } else {
                let orig_p = std::path::Path::new(&original_abs_path_str);
                let new_abs_path = if output_strategy == "replace" {
                    let ext = orig_p.extension().and_then(|e| e.to_str()).unwrap_or("");
                    let new_ext = if status == "downloaded" && !staged_path.is_empty() {
                        let sp = std::path::Path::new(staged_path);
                        sp.extension().and_then(|e| e.to_str()).unwrap_or(output_format)
                    } else {
                        ext
                    };
                    orig_p.with_extension(new_ext)
                } else {
                    let rel_clean = rel_path.trim_start_matches('/');
                    let mut target_basename = orig_p.file_name().unwrap_or_default().to_string_lossy().to_string();
                    if status == "downloaded" && !staged_path.is_empty() {
                        let sp = std::path::Path::new(staged_path);
                        target_basename = sp.file_name().unwrap_or_default().to_string_lossy().to_string();
                    }
                    
                    if output_strategy == "consolidate" {
                        std::path::Path::new(&output_path).join(target_basename)
                    } else {
                        std::path::Path::new(&output_path).join(rel_clean).with_file_name(target_basename)
                    }
                };
                let fname = new_abs_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                (new_abs_path.to_string_lossy().to_string(), fname)
            };

            let file_size_opt = std::fs::metadata(&new_abs_path_str).map(|m| m.len() as i64).ok();
            let staged_bitrate_opt = entry.get("staged_bitrate").and_then(|v| v.as_i64());

            let rows_affected = if let (Some(sz), Some(br)) = (file_size_opt, staged_bitrate_opt) {
                tx.execute(
                    "UPDATE djmdContent SET FolderPath = ?, FileNameL = ?, FileSize = ?, BitRate = ? WHERE FolderPath = ?",
                    rusqlite::params![&new_abs_path_str, &new_filename, sz, br, &original_abs_path_str],
                ).unwrap_or_else(|_| {
                    tx.execute(
                        "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE FolderPath = ?",
                        rusqlite::params![&new_abs_path_str, &new_filename, &original_abs_path_str],
                    ).unwrap_or(0)
                })
            } else if let Some(sz) = file_size_opt {
                tx.execute(
                    "UPDATE djmdContent SET FolderPath = ?, FileNameL = ?, FileSize = ? WHERE FolderPath = ?",
                    rusqlite::params![&new_abs_path_str, &new_filename, sz, &original_abs_path_str],
                ).unwrap_or_else(|_| {
                    tx.execute(
                        "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE FolderPath = ?",
                        rusqlite::params![&new_abs_path_str, &new_filename, &original_abs_path_str],
                    ).unwrap_or(0)
                })
            } else {
                tx.execute(
                    "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE FolderPath = ?",
                    rusqlite::params![&new_abs_path_str, &new_filename, &original_abs_path_str],
                ).map_err(|e| format!("Failed to update database record for {}: {}", rel_path, e))?
            };

            if rows_affected == 0 {
                // Fallback: Case or Unicode normalization difference
                if let (Some(sz), Some(br)) = (file_size_opt, staged_bitrate_opt) {
                    let _ = tx.execute(
                        "UPDATE djmdContent SET FolderPath = ?, FileNameL = ?, FileSize = ?, BitRate = ? WHERE lower(FolderPath) = lower(?)",
                        rusqlite::params![&new_abs_path_str, &new_filename, sz, br, &original_abs_path_str],
                    ).or_else(|_| {
                        tx.execute(
                            "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE lower(FolderPath) = lower(?)",
                            rusqlite::params![&new_abs_path_str, &new_filename, &original_abs_path_str],
                        )
                    });
                } else if let Some(sz) = file_size_opt {
                    let _ = tx.execute(
                        "UPDATE djmdContent SET FolderPath = ?, FileNameL = ?, FileSize = ? WHERE lower(FolderPath) = lower(?)",
                        rusqlite::params![&new_abs_path_str, &new_filename, sz, &original_abs_path_str],
                    ).or_else(|_| {
                        tx.execute(
                            "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE lower(FolderPath) = lower(?)",
                            rusqlite::params![&new_abs_path_str, &new_filename, &original_abs_path_str],
                        )
                    });
                } else {
                    let _ = tx.execute(
                        "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE lower(FolderPath) = lower(?)",
                        rusqlite::params![&new_abs_path_str, &new_filename, &original_abs_path_str],
                    );
                }
            }

            if auto_shift_cues.unwrap_or(true) {
                if let Some(offset_ms) = entry.get("offset_ms").and_then(|v| v.as_i64()).map(|v| v as i32) {
                    if offset_ms != 0 {
                        let content_id_opt: Option<String> = tx.query_row(
                            "SELECT ID FROM djmdContent WHERE FolderPath = ? OR lower(FolderPath) = lower(?)",
                            rusqlite::params![&new_abs_path_str, &new_abs_path_str],
                            |row| row.get(0),
                        ).ok();

                        if let Some(ref cid) = content_id_opt {
                            let _ = shift_cues_for_content(&tx, cid, offset_ms);
                        }
                    }
                }
            }
        }

        let _ = cleanup_master_db_duplicates(&tx);
        tx.commit().map_err(|e| format!("Failed to commit database changes: {}", e))?;

        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_duplicate_content_id() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE djmdContent (ID TEXT PRIMARY KEY, FolderPath TEXT, FileNameL TEXT);
             CREATE TABLE djmdActiveCues (ID TEXT PRIMARY KEY, ContentID TEXT);
             CREATE TABLE djmdCue (ID TEXT PRIMARY KEY, ContentID TEXT);
             CREATE TABLE djmdSongPlaylist (ID TEXT PRIMARY KEY, ContentID TEXT);
             INSERT INTO djmdContent VALUES ('keep1', '/music/a.flac', 'a.flac');
             INSERT INTO djmdContent VALUES ('dup1', '/music/a.mp3', 'a.mp3');
             INSERT INTO djmdCue VALUES ('c1', 'dup1');
             INSERT INTO djmdSongPlaylist VALUES ('sp1', 'dup1');"
        ).unwrap();

        let tx = conn.transaction().unwrap();
        merge_duplicate_content_id(&tx, "keep1", "dup1").unwrap();
        tx.commit().unwrap();

        let count_dup: i64 = conn
            .query_row("SELECT count(*) FROM djmdContent WHERE ID = 'dup1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_dup, 0);

        let count_keep: i64 = conn
            .query_row("SELECT count(*) FROM djmdContent WHERE ID = 'keep1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_keep, 1);

        let cue_content: String = conn
            .query_row("SELECT ContentID FROM djmdCue WHERE ID = 'c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cue_content, "keep1");

        let sp_content: String = conn
            .query_row("SELECT ContentID FROM djmdSongPlaylist WHERE ID = 'sp1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sp_content, "keep1");
    }

    #[test]
    fn test_cleanup_master_db_duplicates() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE djmdContent (ID TEXT PRIMARY KEY, FolderPath TEXT, FileNameL TEXT);
             CREATE TABLE djmdSongPlaylist (ID TEXT PRIMARY KEY, ContentID TEXT);
             INSERT INTO djmdContent VALUES ('id1', '/music/a.mp3', 'a.mp3');
             INSERT INTO djmdContent VALUES ('id2', '/music/a.mp3', 'a.mp3');
             INSERT INTO djmdSongPlaylist VALUES ('1', 'id2');"
        ).unwrap();

        let tx = conn.transaction().unwrap();
        let merged = cleanup_master_db_duplicates(&tx).unwrap();
        tx.commit().unwrap();

        assert_eq!(merged, 1);
        let count_content: i64 = conn
            .query_row("SELECT count(*) FROM djmdContent", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_content, 1);

        let remaining_id: String = conn
            .query_row("SELECT ID FROM djmdContent", [], |r| r.get(0))
            .unwrap();
        assert_eq!(remaining_id, "id2");

        let sp_content: String = conn
            .query_row("SELECT ContentID FROM djmdSongPlaylist WHERE ID = '1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sp_content, "id2");
    }

    #[test]
    fn test_create_master_db_backup() {
        let temp_dir = std::env::temp_dir();
        let pid = std::process::id();
        let live_db = temp_dir.join(format!("test_live_{}.db", pid));
        let backup_db = temp_dir.join(format!("test_backup_{}.db", pid));

        if live_db.exists() {
            let _ = std::fs::remove_file(&live_db);
        }
        if backup_db.exists() {
            let _ = std::fs::remove_file(&backup_db);
        }

        let conn = rusqlite::Connection::open(&live_db).unwrap();
        conn.execute_batch("CREATE TABLE test_data (id INT, val TEXT); INSERT INTO test_data VALUES (1, 'hello');")
            .unwrap();

        create_master_db_backup(&conn, &live_db, &backup_db).unwrap();
        assert!(backup_db.exists());

        let backup_conn = rusqlite::Connection::open(&backup_db).unwrap();
        let val: String = backup_conn
            .query_row("SELECT val FROM test_data WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(val, "hello");

        let _ = std::fs::remove_file(live_db);
        let _ = std::fs::remove_file(backup_db);
    }

    #[test]
    fn test_get_backup_timestamp() {
        let ts = get_backup_timestamp();
        assert!(!ts.is_empty());
        assert!(ts.len() >= 8);
    }

    #[test]
    fn test_parse_backup_date() {
        let d1 = parse_backup_date("master.db.backup_20261014_204139", None);
        assert_eq!(d1, "2026-10-14 20:41:39");

        let d2 = parse_backup_date("master.db.backup_20261006_1431", None);
        assert_eq!(d2, "2026-10-06 14:31:00");

        let d3 = parse_backup_date("master.db.backup_fix_dedup_20260801", None);
        assert_eq!(d3, "2026-08-01 00:00:00");

        let unknown = parse_backup_date("other_name.db", None);
        assert_eq!(unknown, "other_name.db");
    }

    #[test]
    fn test_backup_chronological_sorting() {
        let mut backups = vec![
            "master.db.backup_fix_dedup_20260801".to_string(),
            "master.db.backup_20261014_204139".to_string(),
            "master.db.backup_20261006_1431".to_string(),
        ];
        backups.sort_by(|a, b| {
            let date_a = parse_backup_date(a, None);
            let date_b = parse_backup_date(b, None);
            date_b.cmp(&date_a).then_with(|| b.cmp(a))
        });
        assert_eq!(
            backups,
            vec![
                "master.db.backup_20261014_204139".to_string(),
                "master.db.backup_20261006_1431".to_string(),
                "master.db.backup_fix_dedup_20260801".to_string(),
            ]
        );
    }

    #[test]
    fn test_shift_cues_for_content() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE djmdCue (
                ID TEXT PRIMARY KEY,
                ContentID TEXT,
                InMsec INTEGER,
                OutMsec INTEGER
            );
            INSERT INTO djmdCue VALUES ('c1', 'track1', 500, -1);
            INSERT INTO djmdCue VALUES ('c2', 'track1', 1000, 5000);
            INSERT INTO djmdCue VALUES ('c3', 'track2', 200, -1);",
        ).unwrap();

        // Positive shift (+45 ms)
        let shifted = shift_cues_for_content(&conn, "track1", 45).unwrap();
        assert_eq!(shifted, 2);

        let (in_msec, out_msec): (i32, i32) = conn
            .query_row("SELECT InMsec, OutMsec FROM djmdCue WHERE ID = 'c1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(in_msec, 545);
        assert_eq!(out_msec, -1); // Sentinel untouched

        let (in_msec2, out_msec2): (i32, i32) = conn
            .query_row("SELECT InMsec, OutMsec FROM djmdCue WHERE ID = 'c2'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(in_msec2, 1045);
        assert_eq!(out_msec2, 5045);

        // Track 2 untouched
        let in_msec3: i32 = conn
            .query_row("SELECT InMsec FROM djmdCue WHERE ID = 'c3'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(in_msec3, 200);

        // Negative shift with clamping to 0 (-600 ms on track1)
        shift_cues_for_content(&conn, "track1", -600).unwrap();
        let in_msec_clamped: i32 = conn
            .query_row("SELECT InMsec FROM djmdCue WHERE ID = 'c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(in_msec_clamped, 0); // 545 - 600 clamped to 0
    }

    #[test]
    fn test_files_are_identical() {
        let temp_dir = std::env::temp_dir();
        let pid = std::process::id();
        let file_a = temp_dir.join(format!("test_identical_a_{}.bin", pid));
        let file_b = temp_dir.join(format!("test_identical_b_{}.bin", pid));
        let file_c = temp_dir.join(format!("test_identical_c_{}.bin", pid));
        let file_d = temp_dir.join(format!("test_identical_d_{}.bin", pid));

        std::fs::write(&file_a, b"hello world 1234567890").unwrap();
        std::fs::write(&file_b, b"hello world 1234567890").unwrap();
        std::fs::write(&file_c, b"hello world 1234567891").unwrap(); // same len, different byte
        std::fs::write(&file_d, b"hello").unwrap(); // different len

        assert!(files_are_identical(&file_a, &file_b));
        assert!(!files_are_identical(&file_a, &file_c));
        assert!(!files_are_identical(&file_a, &file_d));

        let _ = std::fs::remove_file(&file_a);
        let _ = std::fs::remove_file(&file_b);
        let _ = std::fs::remove_file(&file_c);
        let _ = std::fs::remove_file(&file_d);
    }

    #[test]
    fn test_backup_health_cache() {
        let temp_dir = std::env::temp_dir();
        let pid = std::process::id();
        let test_audio = temp_dir.join(format!("test_track_{}.mp3", pid));
        std::fs::write(&test_audio, b"fake audio").unwrap();

        let dummy_backup = temp_dir.join(format!("test_backup_health_{}.db", pid));
        std::fs::write(&dummy_backup, b"dummy").unwrap();

        let fname = format!("test_backup_health_{}.db", pid);
        // Direct insertion and retrieval from cache
        let (tot, inc, mis) = get_backup_disk_health(&dummy_backup, &fname, 12345, 99999);
        assert_eq!((tot, inc, mis), (0, 0, 0));

        // Insert custom entry into cache
        if let Ok(mut guard) = get_health_cache().lock() {
            guard.insert((fname.clone(), 12345, 99999), (1400, 1390, 10));
        }
        let cached = get_backup_disk_health(&dummy_backup, &fname, 12345, 99999);
        assert_eq!(cached, (1400, 1390, 10));

        let _ = std::fs::remove_file(&test_audio);
        let _ = std::fs::remove_file(&dummy_backup);
    }
}
