//! Rekordbox XML collection handling: playlist/tree parsing, collection
//! validation, safe-clone consolidation, playlist ingestion, and the shared
//! result/progress shapes reused by the database consolidator.
//! Extracted from lib.rs.

use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use tauri::Emitter;
use tauri::Manager;
use crate::fingerprint_cache::FingerprintCache;
use crate::rekordbox::list_library_entries;
use crate::similarity::{
    calculate_similarity, format_priority, get_audio_fingerprint, get_ffmpeg_path,
    get_fpcalc_path, get_raw_audio_md5, is_better_quality, is_better_quality_transcode_aware,
    sanitize_threshold,
};
use crate::waveform::check_is_transcode;

#[tauri::command]
pub fn get_xml_track_count(xml_path: String) -> Result<usize, String> {
    let file = File::open(&xml_path).map_err(|e| format!("Failed to open XML file: {}", e))?;
    let mut reader = BufReader::new(file);
    let mut count = 0;
    let mut line = String::new();
    while reader.read_line(&mut line).map_err(|e| e.to_string())? > 0 {
        count += line.matches("Location=\"").count();
        line.clear();
    }
    Ok(count)
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct ResultPayload {
    pub(crate) success: bool,
    pub(crate) healthy_count: usize,
    pub(crate) missing_count: usize,
    pub(crate) duplicate_count: usize,
    pub(crate) missing_list: Vec<String>,
    pub(crate) backup_filename: Option<String>,
    pub(crate) processed_list: Option<Vec<String>>,
    pub(crate) duplicate_list: Option<Vec<Vec<String>>>, // Vec of [kept_file, skipped_file] pairs
    pub(crate) library_matched_count: usize,
    pub(crate) superseded_paths: Option<Vec<String>>,
}

#[derive(serde::Serialize, Clone)]
struct ProgressPayload {
    track_name: String,
    processed: usize,
    total: usize,
    percentage: f64,
}

fn unescape_xml(s: &str) -> String {
    let mut intermediate = s
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");

    if intermediate.contains("&#") {
        let mut result = String::with_capacity(intermediate.len());
        let mut rest = intermediate.as_str();
        while let Some(start) = rest.find("&#") {
            result.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            if let Some(semi) = after.find(';') {
                let entity_val = &after[..semi];
                let decoded_char = if entity_val.starts_with('x') || entity_val.starts_with('X') {
                    u32::from_str_radix(&entity_val[1..], 16).ok().and_then(char::from_u32)
                } else {
                    entity_val.parse::<u32>().ok().and_then(char::from_u32)
                };
                if let Some(ch) = decoded_char {
                    result.push(ch);
                    rest = &after[semi + 1..];
                    continue;
                }
            }
            result.push_str("&#");
            rest = after;
        }
        result.push_str(rest);
        intermediate = result;
    }

    intermediate.replace("&amp;", "&")
}

fn extract_attribute(line: &str, attr: &str) -> Option<String> {
    let search_str = format!("{}=\"", attr);
    if let Some(start_idx) = line.find(&search_str) {
        let val_start = start_idx + search_str.len();
        if let Some(end_idx) = line[val_start..].find('"') {
            return Some(unescape_xml(&line[val_start..(val_start + end_idx)]));
        }
    }
    None
}

fn decode_location(location: &str) -> Option<String> {
    let mut cleaned = location;
    if cleaned.starts_with("file://localhost") {
        cleaned = &cleaned["file://localhost".len()..];
    } else if cleaned.starts_with("file://") {
        cleaned = &cleaned["file://".len()..];
    }
    
    let decoded = percent_encoding::percent_decode_str(cleaned)
        .decode_utf8()
        .ok()?
        .into_owned();
        
    let mut final_path = decoded;
    
    if cfg!(target_os = "windows")
        && final_path.starts_with('/') && final_path.len() >= 3 && final_path.as_bytes()[2] == b':' {
        final_path.remove(0);
    }
    
    Some(final_path)
}

#[derive(Clone, Debug)]
struct RawNode {
    name: String,
    node_type: String, // "folder" or "playlist"
    entry_count: Option<usize>,
    children: Vec<RawNode>,
    tracks: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistUiNode {
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tracks: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<PlaylistUiNode>>,
}

fn count_tracks(node: &RawNode) -> usize {
    if node.node_type == "playlist" {
        node.entry_count.unwrap_or(node.tracks.len())
    } else {
        node.children.iter().map(count_tracks).sum()
    }
}

fn map_tree_for_ui(node: &RawNode) -> PlaylistUiNode {
    let (entry_count, total_tracks) = if node.node_type == "playlist" {
        (Some(node.entry_count.unwrap_or(node.tracks.len())), None)
    } else {
        (None, Some(count_tracks(node)))
    };
    let children = if node.node_type == "folder" && !node.children.is_empty() {
        Some(node.children.iter().map(map_tree_for_ui).collect())
    } else {
        None
    };
    PlaylistUiNode {
        name: node.name.clone(),
        node_type: node.node_type.clone(),
        entry_count,
        total_tracks,
        children,
    }
}

fn parse_playlists_xml_tree(
    xml_path: &str,
) -> Result<(std::collections::HashMap<String, String>, Vec<RawNode>), String> {
    let file = File::open(xml_path).map_err(|e| format!("Failed to open XML file: {}", e))?;
    let mut reader = BufReader::new(file);

    let mut collection = std::collections::HashMap::new();
    let mut in_collection = false;
    let mut in_playlists = false;

    let mut stack: Vec<RawNode> = Vec::new();
    let mut root_children: Vec<RawNode> = Vec::new();

    let mut line_buf = String::new();
    let mut remainder = String::new();

    while reader.read_line(&mut line_buf).map_err(|e| e.to_string())? > 0 {
        let mut text = std::mem::take(&mut remainder);
        text.push_str(&line_buf);
        line_buf.clear();

        let mut pos = 0;
        while let Some(start_offset) = text[pos..].find('<') {
            let start = pos + start_offset;
            let end = match text[start..].find('>') {
                Some(e) => start + e,
                None => {
                    remainder = text[start..].to_string();
                    break;
                }
            };

            let tag = &text[start..=end];
            pos = end + 1;

            if tag.starts_with("<?") || tag.starts_with("<!--") {
                continue;
            }

            if tag.starts_with("<COLLECTION") {
                in_collection = true;
                continue;
            } else if tag.starts_with("</COLLECTION") {
                in_collection = false;
                continue;
            } else if tag.starts_with("<PLAYLISTS") {
                in_playlists = true;
                continue;
            } else if tag.starts_with("</PLAYLISTS") {
                in_playlists = false;
                continue;
            }

            if in_collection && tag.starts_with("<TRACK") {
                if let (Some(id), Some(loc)) = (
                    extract_attribute(tag, "TrackID"),
                    extract_attribute(tag, "Location"),
                ) {
                    if let Some(decoded) = decode_location(&loc) {
                        collection.insert(id, decoded);
                    }
                }
            } else if in_playlists {
                if tag.starts_with("</NODE") {
                    if let Some(finished) = stack.pop() {
                        if let Some(parent) = stack.last_mut() {
                            parent.children.push(finished);
                        } else {
                            root_children.push(finished);
                        }
                    }
                } else if tag.starts_with("<NODE") {
                    let is_self_closing = tag.trim_end().ends_with("/>");
                    let name = extract_attribute(tag, "Name").unwrap_or_default();
                    let type_attr = extract_attribute(tag, "Type").unwrap_or_default();
                    let node_type = if type_attr == "0" {
                        "folder".to_string()
                    } else {
                        "playlist".to_string()
                    };
                    let entry_count = extract_attribute(tag, "Entries")
                        .and_then(|e| e.parse::<usize>().ok());

                    let node = RawNode {
                        name,
                        node_type,
                        entry_count,
                        children: Vec::new(),
                        tracks: Vec::new(),
                    };

                    if is_self_closing {
                        if let Some(parent) = stack.last_mut() {
                            parent.children.push(node);
                        } else {
                            root_children.push(node);
                        }
                    } else {
                        stack.push(node);
                    }
                } else if tag.starts_with("<TRACK") {
                    if let Some(key) = extract_attribute(tag, "Key") {
                        if let Some(current) = stack.last_mut() {
                            current.tracks.push(key);
                        }
                    }
                }
            }
        }
    }

    while let Some(finished) = stack.pop() {
        if let Some(parent) = stack.last_mut() {
            parent.children.push(finished);
        } else {
            root_children.push(finished);
        }
    }

    Ok((collection, root_children))
}

fn find_playlist_tracks<'a>(nodes: &'a [RawNode], target: &str) -> Option<&'a [String]> {
    for node in nodes {
        if node.node_type == "playlist" && node.name == target {
            return Some(&node.tracks);
        }
        if !node.children.is_empty() {
            if let Some(found) = find_playlist_tracks(&node.children, target) {
                return Some(found);
            }
        }
    }
    None
}

fn find_folder_node<'a>(nodes: &'a [RawNode], target: &str) -> Option<&'a RawNode> {
    for node in nodes {
        if node.node_type == "folder" && node.name == target {
            return Some(node);
        }
        if !node.children.is_empty() {
            if let Some(found) = find_folder_node(&node.children, target) {
                return Some(found);
            }
        }
    }
    None
}

fn collect_tracks_from_folder(
    node: &RawNode,
    out: &mut Vec<String>,
    seen: &mut std::collections::HashSet<String>,
) {
    if node.node_type == "playlist" {
        for t in &node.tracks {
            if seen.insert(t.clone()) {
                out.push(t.clone());
            }
        }
    } else {
        for child in &node.children {
            collect_tracks_from_folder(child, out, seen);
        }
    }
}

pub fn parse_playlists_inner(xml_path: &str) -> Result<String, String> {
    let (_collection, root_children) = parse_playlists_xml_tree(xml_path)?;
    let root_node = root_children.iter().find(|n| n.name == "ROOT");
    let top_level: Vec<&RawNode> = if let Some(root) = root_node {
        root.children.iter().collect()
    } else {
        root_children.iter().collect()
    };
    let ui_nodes: Vec<PlaylistUiNode> = top_level.into_iter().map(map_tree_for_ui).collect();
    serde_json::to_string(&ui_nodes).map_err(|e| e.to_string())
}

pub fn get_playlist_tracks_inner(xml_path: &str, playlist_name: &str) -> Result<Vec<String>, String> {
    let (collection, root_children) = parse_playlists_xml_tree(xml_path)?;
    let track_ids = match find_playlist_tracks(&root_children, playlist_name) {
        Some(tracks) => tracks,
        None => return Ok(Vec::new()),
    };
    let paths = track_ids
        .iter()
        .filter_map(|key| collection.get(key).cloned())
        .collect();
    Ok(paths)
}

pub fn get_folder_tracks_inner(xml_path: &str, folder_name: &str) -> Result<Vec<String>, String> {
    let (collection, root_children) = parse_playlists_xml_tree(xml_path)?;
    let folder_node = match find_folder_node(&root_children, folder_name) {
        Some(f) => f,
        None => return Ok(Vec::new()),
    };
    let mut track_keys = Vec::new();
    let mut seen = std::collections::HashSet::new();
    collect_tracks_from_folder(folder_node, &mut track_keys, &mut seen);

    let paths = track_keys
        .iter()
        .filter_map(|key| collection.get(key).cloned())
        .collect();
    Ok(paths)
}

#[tauri::command]
pub async fn parse_playlists(_app: tauri::AppHandle, xml_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || parse_playlists_inner(&xml_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_playlist_tracks(
    _app: tauri::AppHandle,
    xml_path: String,
    playlist_name: String,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || get_playlist_tracks_inner(&xml_path, &playlist_name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_folder_tracks(
    _app: tauri::AppHandle,
    xml_path: String,
    folder_name: String,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || get_folder_tracks_inner(&xml_path, &folder_name))
        .await
        .map_err(|e| e.to_string())?
}

fn get_track_name(line: &str) -> String {
    let artist = extract_attribute(line, "Artist").unwrap_or_default();
    let name = extract_attribute(line, "Name").unwrap_or_default();
    if !artist.is_empty() && !name.is_empty() {
        format!("{} - {}", artist, name)
    } else if !name.is_empty() {
        name
    } else if let Some(loc) = extract_attribute(line, "Location") {
        if let Some(decoded) = decode_location(&loc) {
            std::path::Path::new(&decoded)
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| "Unknown Track".to_string())
        } else {
            "Unknown Track".to_string()
        }
    } else {
        "Unknown Track".to_string()
    }
}

async fn parse_and_validate_xml_inner(
    window: Option<&tauri::Window>,
    xml_path: String,
) -> Result<ResultPayload, String> {
    let file = File::open(&xml_path).map_err(|e| format!("Failed to open XML file: {}", e))?;
    let mut reader = BufReader::new(file);
    
    let mut total = 0;
    let mut processed = 0;
    let mut healthy_tracks = Vec::new();
    let mut missing_tracks = Vec::new();
    
    let mut line_buf = String::new();
    let mut in_track = false;
    let mut track_buf = String::new();
    
    while reader.read_line(&mut line_buf).map_err(|e| e.to_string())? > 0 {
        let trimmed = line_buf.trim();
        
        // 1. Check for COLLECTION Total or Entries
        if total == 0 && trimmed.contains("<COLLECTION") {
            if let Some(total_str) = extract_attribute(trimmed, "Entries").or_else(|| extract_attribute(trimmed, "Total")) {
                if let Ok(parsed_total) = total_str.parse::<usize>() {
                    total = parsed_total;
                }
            }
        }
        
        if !in_track {
            if trimmed.contains("<TRACK ") || trimmed.contains("<TRACK>") {
                in_track = true;
                track_buf.clear();
                track_buf.push_str(&line_buf);
            }
        } else {
            track_buf.push_str(&line_buf);
        }
        
        if in_track && line_buf.contains('>') {
            let trimmed_track = track_buf.trim();
            if let Some(location_str) = extract_attribute(trimmed_track, "Location") {
                if let Some(decoded_path) = decode_location(&location_str) {
                    let exists = std::path::Path::new(&decoded_path).exists();
                    let track_name = get_track_name(trimmed_track);
                    
                    processed += 1;
                    
                    if exists {
                        healthy_tracks.push(decoded_path.clone());
                    } else {
                        missing_tracks.push(decoded_path.clone());
                    }
                    
                    let percentage = if total > 0 {
                        (processed as f64 * 100.0) / total as f64
                    } else {
                        0.0
                    };
                    
                    let progress = ProgressPayload {
                        track_name,
                        processed,
                        total,
                        percentage,
                    };
                    
                    if let Some(w) = window {
                        let _ = w.emit("xml-scan-progress", progress);
                    }
                }
            }
            in_track = false;
            track_buf.clear();
        }
        
        line_buf.clear();
    }
    
    Ok(ResultPayload {
        success: true,
        healthy_count: healthy_tracks.len(),
        missing_count: missing_tracks.len(),
        duplicate_count: 0,
        missing_list: missing_tracks,
        backup_filename: None,
        processed_list: None,
        duplicate_list: None,
        library_matched_count: 0,
        superseded_paths: None,
    })
}

#[tauri::command]
pub async fn parse_and_validate_xml(
    window: tauri::Window,
    xml_path: String,
) -> Result<ResultPayload, String> {
    parse_and_validate_xml_inner(Some(&window), xml_path).await
}


#[derive(serde::Serialize, Clone)]
pub(crate) struct ConsolidationProgressPayload {
    pub(crate) filename: String,
    pub(crate) processed: usize,
    pub(crate) total: usize,
    pub(crate) percentage: f64,
}

fn decode_xml_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

pub(crate) fn sanitize_filename(name: &str) -> String {
    let mut sanitized = String::new();
    for c in name.chars() {
        if c.is_alphanumeric() || " -_.,()[]{}".contains(c) {
            sanitized.push(c);
        } else {
            sanitized.push('_');
        }
    }
    sanitized.trim().to_string()
}

#[allow(dead_code)]
fn clean_fuzzy(s: &str) -> String {
    let mut cleaned = String::new();
    let mut in_parentheses = 0;
    
    for c in s.chars() {
        if c == '(' || c == '[' {
            in_parentheses += 1;
        } else if (c == ')' || c == ']') && in_parentheses > 0 {
            in_parentheses -= 1;
        } else if in_parentheses == 0 && c.is_alphanumeric() {
            cleaned.push(c.to_ascii_lowercase());
        }
    }
    
    if cleaned.is_empty() {
        for c in s.chars() {
            if c.is_alphanumeric() {
                cleaned.push(c.to_ascii_lowercase());
            }
        }
    }
    
    cleaned
}

const PATH_ENCODE_SET: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'`')
    .add(b'{')
    .add(b'}');

fn encode_location(path: &std::path::Path) -> String {
    let path_str = path.to_string_lossy();
    let normalized = path_str.replace('\\', "/");
    let segments: Vec<String> = normalized
        .split('/')
        .map(|seg| {
            if seg.is_empty() {
                String::new()
            } else {
                percent_encoding::utf8_percent_encode(seg, PATH_ENCODE_SET).to_string()
            }
        })
        .collect();
    let mut encoded = segments.join("/");
    if !encoded.starts_with('/') {
        encoded = format!("/{}", encoded);
    }
    format!("file://localhost{}", encoded)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_safe_clone(
    window: tauri::Window,
    xml_path: String,
    destination_path: String,
    file_mode: String,
    cross_format: String,
    dedup_depth: String,
    renaming_rule: String,
    threshold: Option<f64>,
) -> Result<ResultPayload, String> {
    let threshold = sanitize_threshold(threshold);
    let file = File::open(&xml_path).map_err(|e| format!("Failed to open XML file: {}", e))?;
    let mut reader = BufReader::new(file);
    
    let mut total = 0;
    let mut processed = 0;
    let mut healthy_count = 0;
    let mut missing_count = 0;
    let mut duplicate_count = 0;
    let mut processed_list = Vec::new();
    let mut duplicate_list = Vec::new();
    let mut superseded_paths = Vec::new();
    let mut missing_list = Vec::new();
    let mut missing_track_ids: Vec<String> = Vec::new();
    let mut line_buf = String::new();
    
    let mut processed_strict_map: std::collections::HashMap<(u64, String), std::path::PathBuf> = std::collections::HashMap::new();
    let mut processed_standard_map: std::collections::HashMap<(String, String), (std::path::PathBuf, String, u64)> = std::collections::HashMap::new();
    let mut processed_fingerprints: Vec<crate::similarity::FingerprintEntry> = Vec::new();
    let mut candidate_index = crate::similarity::CandidatePriorityIndex::new();
    let mut last_progress_emit = std::time::Instant::now();
    let mut last_emit_processed = 0usize;
    
    let mut xml_out = String::new();
    
    let mut fingerprint_cache: std::collections::HashMap<std::path::PathBuf, Vec<u32>> = std::collections::HashMap::new();
    let mut transcode_cache: std::collections::HashMap<std::path::PathBuf, bool> = std::collections::HashMap::new();

    let need_fuzzy = dedup_depth == "fuzzy" || dedup_depth == "tier3";
    let need_dedup_check = cross_format == "smart" || dedup_depth == "standard" || dedup_depth == "tier2" || need_fuzzy;

    if need_dedup_check {
        let _ = window.emit("rebuilder-consolidation-progress", ConsolidationProgressPayload {
            filename: "Reading XML index...".to_string(),
            processed: 0,
            total: 0,
            percentage: 0.0,
        });
        
        let pre_file = File::open(&xml_path).map_err(|e| format!("Failed to open XML file for pre-scan: {}", e))?;
        let mut pre_reader = BufReader::new(pre_file);
        let mut track_paths = Vec::new();
        let mut pre_line_buf = String::new();
        let mut pre_in_track = false;
        let mut pre_track_buf = String::new();
        
        while pre_reader.read_line(&mut pre_line_buf).map_err(|e| e.to_string())? > 0 {
            let trimmed = pre_line_buf.trim();
            if !pre_in_track {
                if trimmed.contains("<TRACK ") || trimmed.contains("<TRACK>") {
                    pre_in_track = true;
                    pre_track_buf.clear();
                    pre_track_buf.push_str(&pre_line_buf);
                }
            } else {
                pre_track_buf.push_str(&pre_line_buf);
            }
            
            if pre_in_track && pre_line_buf.contains('>') {
                let trimmed_track = pre_track_buf.trim();
                if let Some(location_str) = extract_attribute(trimmed_track, "Location") {
                    if let Some(decoded_path) = decode_location(&location_str) {
                        let path = std::path::PathBuf::from(&decoded_path);
                        if path.exists() {
                            track_paths.push(path);
                        }
                    }
                }
                pre_in_track = false;
                pre_track_buf.clear();
            }
            pre_line_buf.clear();
        }
        
        let paths_len = track_paths.len();
        if paths_len > 0 {
            let mut persistent_cache = FingerprintCache::load(window.app_handle());
            let fpcalc_path = get_fpcalc_path(window.app_handle());
            let ffmpeg_path = get_ffmpeg_path(window.app_handle());

            struct PreTask {
                path: std::path::PathBuf,
                need_fp: bool,
                need_tc: bool,
            }
            let mut tasks_to_run = Vec::new();

            for path in track_paths {
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                let is_lossless = matches!(ext.as_str(), "flac" | "wav" | "aiff" | "aif");

                let mut need_fp = false;
                if need_fuzzy {
                    if let Some(fp) = persistent_cache.get(&path) {
                        fingerprint_cache.insert(path.clone(), fp);
                    } else {
                        need_fp = true;
                    }
                }

                let mut need_tc = false;
                if is_lossless {
                    if let Some(tc) = persistent_cache.get_transcode(&path) {
                        transcode_cache.insert(path.clone(), tc);
                    } else {
                        need_tc = true;
                    }
                } else {
                    transcode_cache.insert(path.clone(), false);
                }

                if need_fp || need_tc {
                    tasks_to_run.push(PreTask {
                        path,
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
    }
    
    let dest_dir = std::path::Path::new(&destination_path);
    if !dest_dir.exists() {
        return Err(format!("Destination directory does not exist: {}", destination_path));
    }
    
    let mut in_track = false;
    let mut track_buf = String::new();
    
    while reader.read_line(&mut line_buf).map_err(|e| e.to_string())? > 0 {
        let trimmed = line_buf.trim();
        
        if total == 0 && trimmed.contains("<COLLECTION") {
            if let Some(total_str) = extract_attribute(trimmed, "Entries").or_else(|| extract_attribute(trimmed, "Total")) {
                if let Ok(parsed_total) = total_str.parse::<usize>() {
                    total = parsed_total;
                }
            }
        }
        
        if !in_track {
            if trimmed.contains("<TRACK ") || trimmed.contains("<TRACK>") {
                in_track = true;
                track_buf.clear();
                track_buf.push_str(&line_buf);
            } else {
                xml_out.push_str(&line_buf);
            }
        } else {
            track_buf.push_str(&line_buf);
        }
        
        if in_track && line_buf.contains('>') {
            let mut line_written = false;
            let trimmed_track = track_buf.trim();
            
            if let Some(location_str) = extract_attribute(trimmed_track, "Location") {
                if let Some(decoded_path) = decode_location(&location_str) {
                    let src_path = std::path::Path::new(&decoded_path);
                    processed += 1;
                    
                    let filename_str = src_path.file_name()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or_else(|| "Unknown Track".to_string());
                    
                    if !src_path.exists() {
                        missing_count += 1;
                        missing_list.push(decoded_path.clone());
                        
                        // Collect TrackID for the missing tracks playlist
                        if let Some(track_id) = extract_attribute(trimmed_track, "TrackID") {
                            missing_track_ids.push(track_id);
                        }
                        
                        // Write original track_buf untouched
                        xml_out.push_str(&track_buf);
                        line_written = true;
                        
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
                        // Increment healthy_count since exists is true
                        healthy_count += 1;
                        
                        let artist = extract_attribute(trimmed_track, "Artist").unwrap_or_default();
                        let title = extract_attribute(trimmed_track, "Name").unwrap_or_default();
                        let key = extract_attribute(trimmed_track, "Tonality").unwrap_or_default();
                        let bpm = extract_attribute(trimmed_track, "AverageBpm").unwrap_or_default();
                        let _year = extract_attribute(trimmed_track, "Year").unwrap_or_default();
                        
                        let file_size = std::fs::metadata(src_path)
                            .map(|m| m.len())
                            .unwrap_or(0);
                        
                        let mut target_path: std::path::PathBuf;
                        let mut is_duplicate = false;
                        let mut duplicate_target_path = None;
                        let mut current_fp = None;
                        let mut should_swap_duplicate = false;
                        let mut swap_prev_path = None;

                        // Check if file is a Rekordbox Sampler/Groove Circuit or Demo Tracks file to skip moving/copying it, keeping original path
                        let normalized_src = src_path.to_string_lossy().replace('\\', "/");
                        let is_sampler_file = normalized_src.contains("/rekordbox/Sampler/") 
                            || normalized_src.contains("/Rekordbox/Sampler/")
                            || normalized_src.contains("/PioneerDJ/Demo Tracks/");

                        if dedup_depth == "strict" || dedup_depth == "tier1" {
                            let key = (file_size, filename_str.clone());
                            if let Some(prev_path) = processed_strict_map.get(&key) {
                                is_duplicate = true;
                                duplicate_target_path = Some(prev_path.clone());
                            }
                        } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                            let key = (artist.to_lowercase(), title.to_lowercase());
                            if let Some(&(ref prev_path, ref prev_ext, prev_size)) = processed_standard_map.get(&key) {
                                let current_ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                                if cross_format == "smart" || prev_ext == &current_ext {
                                    is_duplicate = true;
                                    duplicate_target_path = Some(prev_path.clone());
                                    let cur_tc = *transcode_cache.get(src_path).unwrap_or(&false);
                                    let prev_tc = *transcode_cache.get(prev_path).unwrap_or(&false);
                                    if is_better_quality_transcode_aware(&current_ext, file_size, cur_tc, prev_ext, prev_size, prev_tc) {
                                        should_swap_duplicate = true;
                                        swap_prev_path = Some(prev_path.clone());
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
                                    String::new(),
                                    &artist,
                                    &title,
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
                                        let cur_tc = *transcode_cache.get(src_path).unwrap_or(&false);
                                        let prev_tc = *transcode_cache.get(&prev_entry.path).unwrap_or(&false);
                                        if is_better_quality_transcode_aware(&current_ext, file_size, cur_tc, &prev_entry.ext, prev_entry.size, prev_tc) {
                                            should_swap_duplicate = true;
                                            swap_prev_path = Some(prev_entry.path.clone());
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
                                    let artist_clean = sanitize_filename(&decode_xml_entities(&artist));
                                    let title_clean = sanitize_filename(&decode_xml_entities(&title));
                                    let artist_val = if artist_clean.is_empty() { "Unknown Artist".to_string() } else { artist_clean };
                                    let title_val = if title_clean.is_empty() { "Unknown Title".to_string() } else { title_clean };
                                    format!("{} - {}", artist_val, title_val)
                                }
                                "performance" => {
                                    let artist_clean = sanitize_filename(&decode_xml_entities(&artist));
                                    let title_clean = sanitize_filename(&decode_xml_entities(&title));
                                    let bpm_clean = sanitize_filename(&decode_xml_entities(&bpm));
                                    let key_clean = sanitize_filename(&decode_xml_entities(&key));
                                    let artist_val = if artist_clean.is_empty() { "Unknown Artist".to_string() } else { artist_clean };
                                    let title_val = if title_clean.is_empty() { "Unknown Title".to_string() } else { title_clean };
                                    let bpm_val = if bpm_clean.is_empty() { "0".to_string() } else { bpm_clean };
                                    let key_val = if key_clean.is_empty() { "Unknown Key".to_string() } else { key_clean };
                                    
                                    let bpm_display = if let Some(dot_idx) = bpm_val.find('.') {
                                        bpm_val[..dot_idx].to_string()
                                    } else {
                                        bpm_val
                                    };
                                    format!("{} - {} - {} - {}", bpm_display, key_val, artist_val, title_val)
                                }
                                _ => src_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Unknown Track".to_string()),
                            };

                            let truncated_stem = stem.chars().take(120).collect::<String>().trim_end().to_string();

                            let new_filename = format!("{}.{}", truncated_stem, ext);
                            
                            let bpm_val = if let Some(dot_idx) = bpm.find('.') {
                                bpm[..dot_idx].to_string()
                            } else {
                                bpm.clone()
                            };
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
                        if is_duplicate {
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
                                missing_list.push(format!("{} (Operation error: {})", decoded_path.clone(), e));
                            }
                        }
                        
                        if copy_success {
                            let old_location_attr = format!("Location=\"{}\"", location_str);
                            let new_location_attr = format!("Location=\"{}\"", encode_location(&target_path));
                            let updated_track = track_buf.replace(&old_location_attr, &new_location_attr);
                            xml_out.push_str(&updated_track);
                            line_written = true;
                            
                            if is_duplicate && !should_swap_duplicate {
                                // Add details: [kept_file, skipped_file]
                                duplicate_list.push(vec![
                                    target_path.to_string_lossy().to_string(),
                                    src_path.to_string_lossy().to_string()
                                ]);
                                superseded_paths.push(src_path.to_string_lossy().to_string());
                            } else {
                                processed_list.push(target_path.to_string_lossy().to_string());
                                
                                if should_swap_duplicate {
                                    duplicate_count += 1;
                                    
                                    if let Some(ref p_path) = swap_prev_path {
                                        if p_path.exists() && p_path != &target_path {
                                            let _ = crate::safe_delete_file(p_path);
                                        }
                                        let p_path_str = p_path.to_string_lossy().to_string();
                                        if let Some(pos) = processed_list.iter().position(|x| x == &p_path_str) {
                                            processed_list.remove(pos);
                                        }
                                        
                                        let old_encoded = encode_location(p_path);
                                        let new_encoded = encode_location(&target_path);
                                        xml_out = xml_out.replace(&old_encoded, &new_encoded);
                                        
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
                                    processed_strict_map.insert(key, target_path.clone());
                                } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                                    let key = (artist.to_lowercase(), title.to_lowercase());
                                    processed_standard_map.insert(key, (target_path.clone(), current_ext, file_size));
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
            }
            
            if !line_written {
                xml_out.push_str(&track_buf);
            }
            
            in_track = false;
            track_buf.clear();
        }
        
        line_buf.clear();
    }
    
    // Inject "Missing Tracks (Crateup)" playlist if there are missing tracks
    if !missing_track_ids.is_empty() {
        // Build the playlist node
        let mut playlist_node = String::new();
        playlist_node.push_str(&format!(
            "      <NODE Type=\"1\" Name=\"Missing Tracks (Crateup)\" KeyType=\"0\" Entries=\"{}\">\n",
            missing_track_ids.len()
        ));
        for tid in &missing_track_ids {
            playlist_node.push_str(&format!("        <TRACK Key=\"{}\"/>\n", tid));
        }
        playlist_node.push_str("      </NODE>\n");
        
        // Insert before </NODE> that closes the ROOT node (just before </PLAYLISTS>)
        // The ROOT closing </NODE> is typically followed by </PLAYLISTS>
        if let Some(pos) = xml_out.rfind("</PLAYLISTS>") {
            // Find the </NODE> before </PLAYLISTS> (the ROOT node closing tag)
            if let Some(node_pos) = xml_out[..pos].rfind("</NODE>") {
                xml_out.insert_str(node_pos, &playlist_node);
            }
        }
    }
    
    let xml_output_path = dest_dir.join("crateup_collection.xml");
    std::fs::write(&xml_output_path, xml_out).map_err(|e| format!("Failed to write crateup_collection.xml: {}", e))?;
    
    superseded_paths.sort();
    superseded_paths.dedup();

    Ok(ResultPayload {
        success: true,
        healthy_count,
        missing_count,
        duplicate_count,
        missing_list,
        backup_filename: None,
        processed_list: Some(processed_list),
        duplicate_list: Some(duplicate_list),
        library_matched_count: 0,
        superseded_paths: Some(superseded_paths),
    })
}

#[derive(Debug, Clone)]
pub(crate) struct AudioMetadata {
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) duration: f64,
    pub(crate) bpm: String,
    pub(crate) key: String,
}

fn extract_line_value(stderr: &str, prefix: &str) -> Option<String> {
    for line in stderr.lines() {
        let trimmed = line.trim();
        if trimmed.to_lowercase().starts_with(&prefix.to_lowercase()) {
            if let Some(idx) = trimmed.find(':') {
                let val = trimmed[idx+1..].trim().to_string();
                if !val.is_empty() {
                    return Some(val);
                }
            }
        }
    }
    None
}


pub(crate) fn get_audio_metadata(ffmpeg_path: &std::path::Path, file_path: &std::path::Path) -> AudioMetadata {
    let mut meta = AudioMetadata {
        title: "".to_string(),
        artist: "".to_string(),
        duration: 0.0,
        bpm: "".to_string(),
        key: "".to_string(),
    };
    
    let file_stem = file_path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown Track".to_string());
    let parts: Vec<&str> = file_stem.split(" - ").collect();
    if parts.len() >= 2 {
        meta.artist = parts[0].trim().to_string();
        meta.title = parts[1..].join(" - ").trim().to_string();
    } else {
        meta.title = file_stem.trim().to_string();
    }
    
    if let Ok(output) = std::process::Command::new(ffmpeg_path)
        .arg("-i")
        .arg(file_path)
        .output() {
        
        let stderr_str = String::from_utf8_lossy(&output.stderr);
        
        for line in stderr_str.lines() {
            if let Some(idx) = line.find("Duration:") {
                let duration_part = line[idx + 9..].split(',').next().unwrap_or("").trim();
                let time_parts: Vec<&str> = duration_part.split(':').collect();
                if time_parts.len() == 3 {
                    let hours: f64 = time_parts[0].trim().parse().unwrap_or(0.0);
                    let minutes: f64 = time_parts[1].trim().parse().unwrap_or(0.0);
                    let seconds: f64 = time_parts[2].trim().parse().unwrap_or(0.0);
                    meta.duration = hours * 3600.0 + minutes * 60.0 + seconds;
                }
                break;
            }
        }
        
        if let Some(val) = extract_line_value(&stderr_str, "title") {
            meta.title = val;
        }
        if let Some(val) = extract_line_value(&stderr_str, "artist") {
            meta.artist = val;
        }
        if let Some(val) = extract_line_value(&stderr_str, "bpm") {
            meta.bpm = val;
        }
        if let Some(val) = extract_line_value(&stderr_str, "tbpm") {
            meta.bpm = val;
        }
        if let Some(val) = extract_line_value(&stderr_str, "key") {
            meta.key = val;
        }
        if let Some(val) = extract_line_value(&stderr_str, "tkey") {
            meta.key = val;
        }
    }
    
    meta
}

fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[tauri::command]
pub fn select_audio_files() -> Vec<String> {
    rfd::FileDialog::new()
        .add_filter("Audio Files", &["mp3", "wav", "flac", "aif", "aiff", "m4a"])
        .pick_files()
        .map(|paths| paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

#[tauri::command]
pub fn select_save_xml_file(default_name: String) -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("Rekordbox XML", &["xml"])
        .set_file_name(&default_name)
        .save_file()
        .map(|p| p.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
pub(crate) struct ExpandedPathsResult {
    pub(crate) files: Vec<String>,
    pub(crate) suggested_playlist_name: String,
}

#[tauri::command]
pub fn expand_audio_paths(paths: Vec<String>) -> ExpandedPathsResult {
    let mut files = Vec::new();
    let extensions = ["mp3", "wav", "flac", "aif", "aiff", "m4a"];
    let mut suggested_playlist_name = String::new();
    
    if !paths.is_empty() {
        let first_path = std::path::Path::new(&paths[0]);
        if paths.len() == 1 && first_path.is_dir() {
            if let Some(name) = first_path.file_name() {
                suggested_playlist_name = name.to_string_lossy().into_owned();
            }
        } else {
            if let Some(parent) = first_path.parent() {
                if let Some(name) = parent.file_name() {
                    suggested_playlist_name = name.to_string_lossy().into_owned();
                }
            }
        }
    }
    
    for p in paths {
        let path = std::path::Path::new(&p);
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    let entry_path = entry.path();
                    if entry_path.is_file() {
                        if let Some(ext) = entry_path.extension().and_then(|s| s.to_str()) {
                            if extensions.contains(&ext.to_lowercase().as_str()) {
                                files.push(entry_path.to_string_lossy().into_owned());
                            }
                        }
                    }
                }
            }
        } else if path.is_file() {
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                if extensions.contains(&ext.to_lowercase().as_str()) {
                    files.push(p);
                }
            }
        }
    }
    
    ExpandedPathsResult {
        files,
        suggested_playlist_name,
    }
}

/// Staged file plus its probed metadata, shared by the ingestion passes.
struct StagedTrackInfo {
    source_path: std::path::PathBuf,
    metadata: AudioMetadata,
    file_size: u64,
    extension: String,
    is_missing: bool,
}

pub(crate) fn norm_song_key(s: &str) -> String {
    s.to_lowercase().trim().to_string()
}

pub(crate) fn norm_fs_path(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// Match one staged track against the live Rekordbox library. Returns the
/// existing library path to link when the song is already collected, so no
/// bytes are copied and the XML import creates no duplicate entry.
///
/// Tier rules mirror the staged dedup depths: exact path always links;
/// strict compares filename (+size); standard compares artist+title (both
/// required — an empty artist never merges); fuzzy confirms a metadata hit
/// acoustically at `threshold`. Stale db rows (file gone) never link, and
/// `strict` cross-format additionally requires the same extension.
#[allow(clippy::too_many_arguments)]
fn match_library_track(
    track: &StagedTrackInfo,
    by_path: &std::collections::HashMap<String, usize>,
    by_filename: &std::collections::HashMap<String, Vec<usize>>,
    by_song: &std::collections::HashMap<String, Vec<usize>>,
    by_title: &std::collections::HashMap<String, Vec<usize>>,
    entries: &[crate::rekordbox::LibraryEntry],
    dedup_depth: &str,
    cross_format: &str,
    threshold: f64,
    fuzzy_fp: Option<&Vec<u32>>,
    fp_cache: &mut FingerprintCache,
    fpcalc_path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let depth_is = |names: &[&str]| names.contains(&dedup_depth);
    let live = |li: usize| -> Option<&std::path::PathBuf> {
        let p = &entries[li].path;
        if p.exists() {
            Some(p)
        } else {
            None
        }
    };

    // 1. Exact path: ingesting from inside the library links trivially.
    if let Some(&li) = by_path.get(&norm_fs_path(&track.source_path)) {
        if let Some(p) = live(li) {
            return Some(p.clone());
        }
    }

    let title = norm_song_key(&track.metadata.title);
    if title.is_empty() {
        return None;
    }
    let artist = norm_song_key(&track.metadata.artist);

    // Fingerprint of a db candidate, persistent-cached (first run pays once).
    let mut candidate_fp = |li: usize| -> Option<Vec<u32>> {
        let db_path = &entries[li].path;
        if let Some((fp, _)) = fp_cache.get_full(db_path) {
            return Some(fp);
        }
        let fp = get_audio_fingerprint(fpcalc_path, db_path)?;
        fp_cache.insert_full(db_path, fp.clone(), None);
        Some(fp)
    };

    // Acoustic confirmation for one metadata-hit candidate.
    let mut confirm = |li: usize, staged_fp: Option<&Vec<u32>>| -> bool {
        match staged_fp {
            None => true, // fingerprint failed: metadata hit stands (standard-equivalent)
            Some(sfp) => match candidate_fp(li) {
                None => true, // candidate unreadable: metadata hit stands
                Some(dfp) => calculate_similarity(sfp, &dfp, threshold) > threshold,
            },
        }
    };

    if depth_is(&["strict", "tier1", "t1"]) {
        let stem = track
            .source_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string().to_lowercase())
            .unwrap_or_default();
        let key = if cross_format == "smart" {
            stem
        } else {
            format!("{}.{}", stem, track.extension)
        };
        if let Some(cands) = by_filename.get(&key) {
            for &li in cands {
                let db_path = match live(li) {
                    Some(p) => p,
                    None => continue,
                };
                let size_ok = std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(u64::MAX)
                    == track.file_size;
                if size_ok {
                    return Some(db_path.clone());
                }
            }
        }
        return None;
    }

    // Standard + fuzzy share the metadata gate; fuzzy confirms by sound.
    let fuzzy = depth_is(&["fuzzy", "tier3", "t3"]);
    let ext_ok = |li: usize| {
        cross_format == "smart"
            || entries[li]
                .path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase()
                == track.extension
    };
    if !artist.is_empty() {
        let key = format!("{}\x00{}", artist, title);
        if let Some(cands) = by_song.get(&key) {
            for &li in cands {
                if live(li).is_none() || !ext_ok(li) {
                    continue;
                }
                if !fuzzy || confirm(li, fuzzy_fp) {
                    return Some(entries[li].path.clone());
                }
            }
        }
        return None;
    }
    // No artist tag: fuzzy may still prove it by sound on title candidates.
    if fuzzy {
        if let Some(cands) = by_title.get(&title) {
            let staged_fp = fuzzy_fp?;
            for &li in cands {
                if live(li).is_none() || !ext_ok(li) {
                    continue;
                }
                if let Some(dfp) = candidate_fp(li) {
                    if calculate_similarity(staged_fp, &dfp, threshold) > threshold {
                        return Some(entries[li].path.clone());
                    }
                }
            }
        }
    }
    None
}

/// Cross-check every staged track against the live Rekordbox library.
/// Returns staged-index → existing library path for songs already
/// collected, so the playlist links them with zero file operations.
fn match_library_tracks(
    window: &tauri::Window,
    tracks: &[StagedTrackInfo],
    total: usize,
    dedup_depth: &str,
    cross_format: &str,
    threshold: f64,
    library_check: bool,
) -> std::collections::HashMap<usize, std::path::PathBuf> {
    let mut links = std::collections::HashMap::new();
    if !library_check {
        return links;
    }
    let entries = match list_library_entries() {
        Ok(e) => e,
        Err(err) => {
            eprintln!(
                "[ingest] Library check skipped ({}); staged-only dedup.",
                err
            );
            return links;
        }
    };
    let mut by_path: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut by_filename: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    let mut by_song: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    let mut by_title: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        by_path.insert(norm_fs_path(&e.path), i);
        let fname = if e.file_name.is_empty() {
            e.path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            e.file_name.clone()
        }
        .to_lowercase();
        by_filename.entry(fname).or_default().push(i);
        let title = norm_song_key(&e.title);
        if title.is_empty() {
            continue;
        }
        by_title.entry(title.clone()).or_default().push(i);
        let artist = norm_song_key(&e.artist);
        if !artist.is_empty() {
            by_song
                .entry(format!("{}\x00{}", artist, title))
                .or_default()
                .push(i);
        }
    }
    let fuzzy = ["fuzzy", "tier3", "t3"].contains(&dedup_depth);
    let mut fp_cache = FingerprintCache::load(window.app_handle());
    let fpcalc_path = get_fpcalc_path(window.app_handle());
    for (idx, track) in tracks.iter().enumerate().take(total) {
        if track.is_missing {
            continue;
        }
        let staged_fp: Option<Vec<u32>> = if fuzzy {
            fp_cache
                .get_full(&track.source_path)
                .map(|(fp, _)| fp)
        } else {
            None
        };
        if let Some(db_path) = match_library_track(
            track,
            &by_path,
            &by_filename,
            &by_song,
            &by_title,
            &entries,
            dedup_depth,
            cross_format,
            threshold,
            staged_fp.as_ref(),
            &mut fp_cache,
            &fpcalc_path,
        ) {
            links.insert(idx, db_path);
        }
    }
    fp_cache.save();
    if !links.is_empty() {
        eprintln!(
            "[ingest] Library check: {} staged track(s) already in master.db — linking, no copy.",
            links.len()
        );
    }
    links
}


#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn execute_playlist_ingestion(
    window: tauri::Window,
    staged_files: Vec<String>,
    playlist_name: String,
    destination_path: String,
    file_mode: String,
    cross_format: String,
    dedup_depth: String,
    renaming_rule: String,
    xml_save_path: String,
    threshold: Option<f64>,
    library_check: Option<bool>,
) -> Result<ResultPayload, String> {
    let threshold = sanitize_threshold(threshold);
    let library_check = library_check.unwrap_or(true);
    let dest_dir = std::path::Path::new(&destination_path);
    if !dest_dir.exists() {
        return Err(format!("Destination directory does not exist: {}", destination_path));
    }
    
    let ffmpeg_path = get_ffmpeg_path(window.app_handle());
    
    let total = staged_files.len();
    let mut processed = 0;
    let mut healthy_count = 0;
    let mut missing_count = 0;
    let mut duplicate_count = 0;
    let mut library_matched_count = 0;
    let mut missing_list = Vec::new();

    let mut tracks = Vec::new();
    
    for f in &staged_files {
        let src_path = std::path::PathBuf::from(f);
        let filename_str = src_path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown Track".to_string());
            
        if !src_path.exists() {
            missing_count += 1;
            missing_list.push(f.clone());
            processed += 1;
            
            tracks.push(StagedTrackInfo {
                source_path: src_path.clone(),
                metadata: AudioMetadata {
                    title: filename_str.clone(),
                    artist: "".to_string(),
                    duration: 0.0,
                    bpm: "".to_string(),
                    key: "".to_string(),
                },
                file_size: 0,
                extension: "".to_string(),
                is_missing: true,
            });
            
            let percentage = if total > 0 {
                (processed as f64 * 100.0) / total as f64
            } else {
                0.0
            };
            
            let _ = window.emit("ingest-consolidation-progress", ConsolidationProgressPayload {
                filename: format!("(Missing) {}", filename_str),
                processed,
                total,
                percentage,
            });
            if total < 20 {
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
        } else {
            healthy_count += 1;
            let file_size = std::fs::metadata(&src_path).map(|m| m.len()).unwrap_or(0);
            let ext = src_path.extension()
                .map(|e| e.to_string_lossy().to_string().to_lowercase())
                .unwrap_or_default();
            let metadata = get_audio_metadata(&ffmpeg_path, &src_path);
            
            tracks.push(StagedTrackInfo {
                source_path: src_path,
                metadata,
                file_size,
                extension: ext,
                is_missing: false,
            });
        }
    }
    
    let mut track_resolution = vec![(false, 0); total];

    // Songs already in master.db link to their library file (assigned per
    // branch below: fuzzy needs the pre-scan cache saved first).
    let library_links: std::collections::HashMap<usize, std::path::PathBuf>;

    if dedup_depth == "fuzzy" || dedup_depth == "tier3" || dedup_depth == "t3" {
        let fpcalc_path = get_fpcalc_path(window.app_handle());
        let ffmpeg_path = get_ffmpeg_path(window.app_handle());
        
        let _ = window.emit("ingest-consolidation-progress", ConsolidationProgressPayload {
            filename: "Pre-analyzing audio files...".to_string(),
            processed: 0,
            total,
            percentage: 0.0,
        });
        
        // Precompute raw MD5 and fingerprints in parallel.
        // Persistent cache first: unchanged files resolve instantly.
        let mut persistent_cache =
            FingerprintCache::load(window.app_handle());
        let mut tasks = Vec::new();
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));

        let healthy_indices: Vec<usize> = tracks
            .iter()
            .enumerate()
            .take(total)
            .filter(|(_, t)| !t.is_missing)
            .map(|(idx, _)| idx)
            .collect();

        let mut precomputed = std::collections::HashMap::new();
        let healthy_len = healthy_indices.len();
        let mut completed = 0;
        for &idx in &healthy_indices {
            let src = &tracks[idx].source_path;
            if let Some((fp, md5)) = persistent_cache.get_full(src) {
                precomputed.insert(idx, (md5, Some(fp)));
                completed += 1;
                let percentage = (completed as f64 * 100.0) / healthy_len as f64;
                let _ = window.emit("ingest-consolidation-progress", ConsolidationProgressPayload {
                    filename: format!("Acoustic Analysis: {}/{} files", completed, healthy_len),
                    processed: completed,
                    total: healthy_len,
                    percentage,
                });
                continue;
            }
            let src_path = tracks[idx].source_path.clone();
            let fpcalc_path_clone = fpcalc_path.clone();
            let ffmpeg_path_clone = ffmpeg_path.clone();
            let sem_clone = sem.clone();

            tasks.push(tokio::spawn(async move {
                let _permit = sem_clone.acquire().await.unwrap();
                let src_path_for_md5 = src_path.clone();
                let md5 = tokio::task::spawn_blocking(move || {
                    get_raw_audio_md5(&ffmpeg_path_clone, &src_path_for_md5)
                }).await.ok().flatten();

                let src_path_for_fp = src_path.clone();
                let fp = tokio::task::spawn_blocking(move || {
                    get_audio_fingerprint(&fpcalc_path_clone, &src_path_for_fp)
                }).await.ok().flatten();

                (idx, md5, fp)
            }));
        }

        for task in tasks {
            if let Ok((idx, md5, fp)) = task.await {
                if let Some(ref fp_val) = fp {
                    persistent_cache.insert_full(
                        &tracks[idx].source_path,
                        fp_val.clone(),
                        md5.clone(),
                    );
                }
                precomputed.insert(idx, (md5, fp));
            }
            completed += 1;
            let percentage = (completed as f64 * 100.0) / healthy_len as f64;
            let _ = window.emit("ingest-consolidation-progress", ConsolidationProgressPayload {
                filename: format!("Acoustic Analysis: {}/{} files", completed, healthy_len),
                processed: completed,
                total: healthy_len,
                percentage,
            });
        }
        persistent_cache.save();

        // Songs already in master.db link to their library file: no copy,
        // no new db entry on XML import. Linked tracks skip staged-dedup
        // below; their staged dupes converge onto the same path via match.
        library_links = match_library_tracks(
            &window,
            &tracks,
            total,
            &dedup_depth,
            &cross_format,
            threshold,
            library_check,
        );

        let mut processed_tracks: Vec<(usize, Option<String>, Option<Vec<u32>>)> = Vec::new();

        for idx in 0..total {
            if tracks[idx].is_missing || library_links.contains_key(&idx) {
                continue;
            }
            
            let (current_md5, current_fp) = precomputed.remove(&idx).unwrap_or((None, None));
            
            let mut duplicate_found = false;
            let mut target_idx = 0;
            
            for &(prev_idx, ref prev_md5, ref prev_fp) in &processed_tracks {
                if cross_format != "smart" && tracks[prev_idx].extension != tracks[idx].extension {
                    continue;
                }
                
                if let (Some(ref cm), Some(ref pm)) = (&current_md5, prev_md5) {
                    if cm == pm {
                        duplicate_found = true;
                        target_idx = prev_idx;
                        break;
                    }
                }
                
                if let (Some(ref cf), Some(ref pf)) = (&current_fp, prev_fp) {
                    let sim = calculate_similarity(cf, pf, threshold);
                    if sim > threshold {
                        duplicate_found = true;
                        target_idx = prev_idx;
                        break;
                    }
                }
            }
            
            if duplicate_found {
                let is_better = is_better_quality(
                    &tracks[idx].extension,
                    tracks[idx].file_size,
                    &tracks[target_idx].extension,
                    tracks[target_idx].file_size,
                );
                
                if is_better {
                    track_resolution[idx] = (false, idx);
                    track_resolution[target_idx] = (true, idx);
                    
                    if let Some(pos) = processed_tracks.iter().position(|&(p_idx, _, _)| p_idx == target_idx) {
                        processed_tracks[pos] = (idx, current_md5.clone(), current_fp.clone());
                    }
                } else {
                    track_resolution[idx] = (true, target_idx);
                }
            } else {
                track_resolution[idx] = (false, idx);
                processed_tracks.push((idx, current_md5, current_fp));
            }
        }
    } else {
        library_links = match_library_tracks(
            &window,
            &tracks,
            total,
            &dedup_depth,
            &cross_format,
            threshold,
            library_check,
        );
        let mut groups: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();

        for (idx, track) in tracks.iter().enumerate() {
            if track.is_missing || library_links.contains_key(&idx) {
                continue;
            }
            
            let filename_stem = track.source_path.file_stem()
                .map(|s| s.to_string_lossy().to_string().to_lowercase())
                .unwrap_or_default();
                
            let key = if dedup_depth == "t1" || dedup_depth == "strict" || dedup_depth == "tier1" {
                if cross_format == "smart" {
                    filename_stem
                } else {
                    format!("{}.{}", filename_stem, track.extension)
                }
            } else {
                let artist_norm = track.metadata.artist.to_lowercase().trim().to_string();
                let title_norm = track.metadata.title.to_lowercase().trim().to_string();
                if cross_format == "smart" {
                    format!("{} - {}", artist_norm, title_norm)
                } else {
                    format!("{} - {}.{}", artist_norm, title_norm, track.extension)
                }
            };
            
            groups.entry(key).or_default().push(idx);
        }
        
        for (_key, indices) in groups {
            if indices.is_empty() {
                continue;
            }
            
            let mut sorted_indices = indices.clone();
            sorted_indices.sort_by(|&a, &b| {
                let pri_a = format_priority(&tracks[a].extension);
                let pri_b = format_priority(&tracks[b].extension);
                if pri_a != pri_b {
                    pri_b.cmp(&pri_a)
                } else {
                    tracks[b].file_size.cmp(&tracks[a].file_size)
                }
            });
            
            let primary_idx = sorted_indices[0];
            track_resolution[primary_idx] = (false, primary_idx);
            
            for &idx in &sorted_indices[1..] {
                track_resolution[idx] = (true, primary_idx);
            }
        }
    }
    
    let mut resolved_dest_paths = vec![std::path::PathBuf::new(); total];
    let mut used_target_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    
    for idx in 0..total {
        if tracks[idx].is_missing {
            continue;
        }

        // Already collected: link the library file, zero file operations
        // (any copy/move/hardlink here would create a duplicate db entry
        // on XML import — including onto itself).
        if let Some(db_path) = library_links.get(&idx) {
            resolved_dest_paths[idx] = db_path.clone();
            library_matched_count += 1;
            processed += 1;

            let filename_str = tracks[idx]
                .source_path
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "Unknown Track".to_string());
            let percentage = if total > 0 {
                (processed as f64 * 100.0) / total as f64
            } else {
                0.0
            };

            let _ = window.emit("ingest-consolidation-progress", ConsolidationProgressPayload {
                filename: format!("(Already in Library) {}", filename_str),
                processed,
                total,
                percentage,
            });
            if total < 20 {
                tokio::time::sleep(std::time::Duration::from_millis(15)).await;
            }
            continue;
        }

        let (is_dup, _primary_idx) = track_resolution[idx];
        if is_dup {
            continue;
        }
        
        let track = &tracks[idx];
        let filename_str = track.source_path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown Track".to_string());
            
        let target_stem = match renaming_rule.as_str() {
            "clean" => {
                let artist_clean = sanitize_filename(&track.metadata.artist);
                let title_clean = sanitize_filename(&track.metadata.title);
                let artist_val = if artist_clean.is_empty() { "Unknown Artist".to_string() } else { artist_clean };
                let title_val = if title_clean.is_empty() { "Unknown Title".to_string() } else { title_clean };
                format!("{} - {}", artist_val, title_val)
            }
            "perf" | "performance" => {
                let artist_clean = sanitize_filename(&track.metadata.artist);
                let title_clean = sanitize_filename(&track.metadata.title);
                let artist_val = if artist_clean.is_empty() { "Unknown Artist".to_string() } else { artist_clean };
                let title_val = if title_clean.is_empty() { "Unknown Title".to_string() } else { title_clean };
                
                let bpm_clean = sanitize_filename(&track.metadata.bpm);
                let bpm_val = if bpm_clean.is_empty() { "0".to_string() } else { bpm_clean };
                let bpm_display = if let Some(dot_idx) = bpm_val.find('.') {
                    bpm_val[..dot_idx].to_string()
                } else {
                    bpm_val
                };
                
                let key_clean = sanitize_filename(&track.metadata.key);
                let key_val = if key_clean.is_empty() { "Unknown Key".to_string() } else { key_clean };
                
                format!("{} - {} - {} - {}", bpm_display, key_val, artist_val, title_val)
            }
            _ => {
                track.source_path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "Unknown Track".to_string())
            }
        };
        
        let ext_suffix = if !track.extension.is_empty() {
            format!(".{}", track.extension)
        } else {
            "".to_string()
        };
        
        let mut final_filename = format!("{}{}", target_stem, ext_suffix);
        let mut counter = 1;
        
        while dest_dir.join(&final_filename).exists() || used_target_names.contains(&final_filename.to_lowercase()) {
            final_filename = format!("{} ({}){}", target_stem, counter, ext_suffix);
            counter += 1;
        }
        
        used_target_names.insert(final_filename.to_lowercase());
        let target_file_path = dest_dir.join(&final_filename);

        // Resolving onto itself (ingesting from inside the destination):
        // any copy/move/link onto the same path is a no-op at best.
        if target_file_path == track.source_path {
            resolved_dest_paths[idx] = track.source_path.clone();
            processed += 1;
            continue;
        }

        let op_res = match file_mode.as_str() {
            "move" => {
                crate::safe_move_file(&track.source_path, &target_file_path)
            }
            "link" => {
                if std::fs::hard_link(&track.source_path, &target_file_path).is_err() {
                    std::fs::copy(&track.source_path, &target_file_path).map(|_| ())
                } else {
                    Ok(())
                }
            }
            _ => {
                std::fs::copy(&track.source_path, &target_file_path).map(|_| ())
            }
        };
        
        if let Err(e) = op_res {
            return Err(format!("Failed to copy/move file to target: {}. Error: {}", target_file_path.display(), e));
        }
        
        resolved_dest_paths[idx] = target_file_path;
        processed += 1;
        
        let percentage = if total > 0 {
            (processed as f64 * 100.0) / total as f64
        } else {
            0.0
        };
        
        let _ = window.emit("ingest-consolidation-progress", ConsolidationProgressPayload {
            filename: filename_str,
            processed,
            total,
            percentage,
        });
        if total < 20 {
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        }
    }
    
    for idx in 0..total {
        if tracks[idx].is_missing {
            continue;
        }
        
        let (is_dup, primary_idx) = track_resolution[idx];
        if !is_dup {
            continue;
        }
        
        let target_file_path = &resolved_dest_paths[primary_idx];
        resolved_dest_paths[idx] = target_file_path.clone();
        
        duplicate_count += 1;
        processed += 1;
        
        let filename_str = tracks[idx].source_path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "Unknown Track".to_string());
            
        let percentage = if total > 0 {
            (processed as f64 * 100.0) / total as f64
        } else {
            0.0
        };
        
        let _ = window.emit("ingest-consolidation-progress", ConsolidationProgressPayload {
            filename: format!("(Filtered Duplicate) {}", filename_str),
            processed,
            total,
            percentage,
        });
        if total < 20 {
            tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        }
    }
    
    let xml_path = std::path::PathBuf::from(&xml_save_path);
    
    let mut xml_content = String::new();
    xml_content.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml_content.push_str("<DJ_PLAYLISTS Version=\"1.0.0\">\n");
    xml_content.push_str("  <PRODUCT Name=\"rekordbox\" Version=\"6.0.0\" Company=\"Pioneer DJ\" />\n");
    
    let healthy_staged_count = tracks.iter().filter(|t| !t.is_missing).count();
    xml_content.push_str(&format!("  <COLLECTION Entries=\"{}\">\n", healthy_staged_count));
    
    let mut healthy_idx_map = std::collections::HashMap::new();
    let mut track_id = 1;
    
    for idx in 0..total {
        if tracks[idx].is_missing {
            continue;
        }
        
        let track = &tracks[idx];
        let final_path = &resolved_dest_paths[idx];
        let encoded_url = encode_location(final_path);
        
        let xml_title = escape_xml(&track.metadata.title);
        let xml_artist = escape_xml(&track.metadata.artist);
        let xml_key = escape_xml(&track.metadata.key);
        let xml_bpm = escape_xml(&track.metadata.bpm);
        
        xml_content.push_str(&format!(
            "    <TRACK TrackID=\"{}\" Name=\"{}\" Artist=\"{}\" Location=\"{}\" Kind=\"Audio File\" Size=\"{}\" TotalTime=\"{}\" AverageBpm=\"{}\" Tonality=\"{}\"/>\n",
            track_id, xml_title, xml_artist, encoded_url, track.file_size, track.metadata.duration as u32, xml_bpm, xml_key
        ));
        
        healthy_idx_map.insert(idx, track_id);
        track_id += 1;
    }
    
    xml_content.push_str("  </COLLECTION>\n");
    xml_content.push_str("  <PLAYLISTS>\n");
    xml_content.push_str("    <NODE Type=\"0\" Name=\"Root\">\n");
    xml_content.push_str(&format!("      <NODE Type=\"1\" Name=\"{}\" KeyType=\"0\" Entries=\"{}\">\n", escape_xml(&playlist_name), healthy_staged_count));
    
    for (idx, track) in tracks.iter().enumerate().take(total) {
        if track.is_missing {
            continue;
        }
        
        if let Some(&tid) = healthy_idx_map.get(&idx) {
            xml_content.push_str(&format!("        <TRACK Key=\"{}\"/>\n", tid));
        }
    }
    
    xml_content.push_str("      </NODE>\n");
    xml_content.push_str("    </NODE>\n");
    xml_content.push_str("  </PLAYLISTS>\n");
    xml_content.push_str("</DJ_PLAYLISTS>\n");
    
    if let Err(e) = std::fs::write(&xml_path, xml_content) {
        return Err(format!("Failed to write Rekordbox XML playlist: {}", e));
    }
    
    Ok(ResultPayload {
        success: true,
        healthy_count,
        missing_count,
        duplicate_count,
        missing_list,
        backup_filename: None,
        processed_list: None,
        duplicate_list: None,
        library_matched_count,
        superseded_paths: None,
    })
}

pub fn shift_xml_cues_and_tempo(xml_fragment: &str, offset_ms: i32) -> String {
    if offset_ms == 0 {
        return xml_fragment.to_string();
    }
    let offset_sec = offset_ms as f64 / 1000.0;
    let mut result = xml_fragment.to_string();

    if result.contains("<TEMPO ") {
        if let Some(start_idx) = result.find("Inizio=\"") {
            let val_start = start_idx + "Inizio=\"".len();
            if let Some(end_idx) = result[val_start..].find('"') {
                let orig_val_str = &result[val_start..val_start + end_idx];
                if let Ok(val) = orig_val_str.parse::<f64>() {
                    let new_val = (val + offset_sec).max(0.0);
                    let old_attr = format!("Inizio=\"{}\"", orig_val_str);
                    let new_attr = format!("Inizio=\"{:.3}\"", new_val);
                    result = result.replace(&old_attr, &new_attr);
                }
            }
        }
    }

    if result.contains("<POSITION_MARK ") {
        // Shift Start="..."
        if let Some(start_idx) = result.find("Start=\"") {
            let val_start = start_idx + "Start=\"".len();
            if let Some(end_idx) = result[val_start..].find('"') {
                let orig_val_str = &result[val_start..val_start + end_idx];
                if let Ok(val) = orig_val_str.parse::<f64>() {
                    let new_val = (val + offset_sec).max(0.0);
                    let old_attr = format!("Start=\"{}\"", orig_val_str);
                    let new_attr = format!("Start=\"{:.3}\"", new_val);
                    result = result.replace(&old_attr, &new_attr);
                }
            }
        }

        // Shift End="..." if present and not -1 / -1.000
        if let Some(start_idx) = result.find("End=\"") {
            let val_start = start_idx + "End=\"".len();
            if let Some(end_idx) = result[val_start..].find('"') {
                let orig_val_str = &result[val_start..val_start + end_idx];
                if orig_val_str != "-1" && orig_val_str != "-1.000" {
                    if let Ok(val) = orig_val_str.parse::<f64>() {
                        let new_val = (val + offset_sec).max(0.0);
                        let old_attr = format!("End=\"{}\"", orig_val_str);
                        let new_attr = format!("End=\"{:.3}\"", new_val);
                        result = result.replace(&old_attr, &new_attr);
                    }
                }
            }
        }
    }

    result
}

#[derive(Clone)]
struct RemapTarget {
    new_path: std::path::PathBuf,
    offset_ms: Option<i32>,
}

#[tauri::command]
pub async fn update_rekordbox_xml(
    xml_path: String,
    ledger_path: String,
    decisions: std::collections::HashMap<String, String>,
    auto_shift_cues: Option<bool>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let xml_p = std::path::Path::new(&xml_path);
        if !xml_p.exists() {
            return Err(format!("Rekordbox XML not found at {}", xml_path));
        }

        let ledger_content = std::fs::read_to_string(&ledger_path)
            .map_err(|e| format!("Failed to read ledger {}: {}", ledger_path, e))?;
        let ledger: serde_json::Value = serde_json::from_str(&ledger_content)
            .map_err(|e| format!("Failed to parse ledger JSON: {}", e))?;

        let root_path = ledger.get("root_path").and_then(|v| v.as_str()).unwrap_or("");
        let output_format = ledger.get("output_format").and_then(|v| v.as_str()).unwrap_or("flac");
        let files = ledger.get("files").and_then(|v| v.as_object())
            .ok_or_else(|| "Missing files object in ledger".to_string())?;

        // Build mapping: normalized original path -> RemapTarget
        let mut approved_remapping: std::collections::HashMap<String, RemapTarget> = std::collections::HashMap::new();

        for (rel_path, entry_val) in files {
            let decision = decisions.get(rel_path).map(|s| s.as_str()).unwrap_or("skipped");
            if decision != "approved" {
                continue;
            }

            let entry = match entry_val.as_object() {
                Some(e) => e,
                None => continue,
            };

            let orig_abs_str = if let Some(orig_saved) = entry.get("original_abs_path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                orig_saved.to_string()
            } else {
                std::path::Path::new(root_path).join(rel_path.trim_start_matches('/')).to_string_lossy().to_string()
            };

            let orig_p = std::path::Path::new(&orig_abs_str);

            let new_path_buf = if let Some(committed_out) = entry.get("output_path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
                std::path::PathBuf::from(committed_out)
            } else {
                let status = entry.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let staged_path = entry.get("staged_path").and_then(|v| v.as_str()).unwrap_or("");
                let ext = orig_p.extension().and_then(|e| e.to_str()).unwrap_or("");
                let new_ext = if status == "downloaded" && !staged_path.is_empty() {
                    let sp = std::path::Path::new(staged_path);
                    sp.extension().and_then(|e| e.to_str()).unwrap_or(output_format)
                } else {
                    ext
                };
                orig_p.with_extension(new_ext)
            };

            let offset_ms = entry.get("offset_ms").and_then(|v| v.as_i64()).map(|v| v as i32);
            let target = RemapTarget {
                new_path: new_path_buf,
                offset_ms,
            };

            approved_remapping.insert(norm_fs_path(orig_p), target.clone());
            approved_remapping.insert(orig_p.to_string_lossy().to_string(), target.clone());
            approved_remapping.insert(orig_p.to_string_lossy().to_lowercase(), target);
        }

        let file = std::fs::File::open(xml_p).map_err(|e| format!("Failed to open XML: {}", e))?;
        let mut reader = std::io::BufReader::new(file);

        let xml_dir = xml_p.parent().unwrap_or(std::path::Path::new("."));
        let date_str = if let Ok(out) = std::process::Command::new("/bin/date").arg("+%Y-%m-%d").output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() { s } else { "upgraded".to_string() }
        } else {
            "upgraded".to_string()
        };
        let out_filename = format!("rekordbox_upgraded_{}.xml", date_str);
        let out_path = xml_dir.join(&out_filename);

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let tmp_path = xml_dir.join(format!("{}.tmp.{}.{}", out_filename, std::process::id(), nanos));
        let tmp_file = std::fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temporary XML file: {}", e))?;
        let mut writer = std::io::BufWriter::new(tmp_file);

        let mut line_buf = String::new();
        let mut in_track = false;
        let mut track_buf = String::new();
        let mut active_track_offset: Option<i32> = None;

        while reader.read_line(&mut line_buf).map_err(|e| e.to_string())? > 0 {
            let trimmed = line_buf.trim();

            if !in_track {
                if trimmed.contains("<TRACK ") || trimmed.contains("<TRACK>") {
                    in_track = true;
                    track_buf.clear();
                    track_buf.push_str(&line_buf);
                } else {
                    let to_write = if let Some(offset) = active_track_offset {
                        if trimmed.contains("<TEMPO ") || trimmed.contains("<POSITION_MARK ") {
                            shift_xml_cues_and_tempo(&line_buf, offset)
                        } else {
                            line_buf.clone()
                        }
                    } else {
                        line_buf.clone()
                    };
                    if trimmed.contains("</TRACK>") {
                        active_track_offset = None;
                    }
                    writer.write_all(to_write.as_bytes()).map_err(|e| e.to_string())?;
                }
            } else {
                track_buf.push_str(&line_buf);
            }

            if in_track && line_buf.contains('>') {
                let trimmed_track = track_buf.trim();
                let mut line_written = false;
                let mut remapped_offset: Option<i32> = None;

                if let Some(location_str) = extract_attribute(trimmed_track, "Location") {
                    if let Some(decoded_path) = decode_location(&location_str) {
                        let decoded_p = std::path::Path::new(&decoded_path);
                        let norm = norm_fs_path(decoded_p);
                        let lower = decoded_p.to_string_lossy().to_lowercase();

                        let target_opt = approved_remapping.get(&norm)
                            .or_else(|| approved_remapping.get(&decoded_path))
                            .or_else(|| approved_remapping.get(&lower));

                        if let Some(target) = target_opt {
                            let old_location_attr = format!("Location=\"{}\"", location_str);
                            let new_location_attr = format!("Location=\"{}\"", encode_location(&target.new_path));
                            let updated_track = track_buf.replace(&old_location_attr, &new_location_attr);
                            writer.write_all(updated_track.as_bytes()).map_err(|e| e.to_string())?;
                            line_written = true;
                            remapped_offset = target.offset_ms;
                        }
                    }
                }

                if !line_written {
                    writer.write_all(track_buf.as_bytes()).map_err(|e| e.to_string())?;
                }

                if auto_shift_cues.unwrap_or(true) && !trimmed_track.ends_with("/>") {
                    active_track_offset = remapped_offset;
                } else {
                    active_track_offset = None;
                }

                in_track = false;
                track_buf.clear();
            }

            line_buf.clear();
        }

        if in_track && !track_buf.is_empty() {
            writer.write_all(track_buf.as_bytes()).map_err(|e| e.to_string())?;
        }

        writer.flush().map_err(|e| e.to_string())?;
        drop(writer);

        if let Err(e) = std::fs::rename(&tmp_path, &out_path) {
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Failed to rename updated XML into place: {}", e));
        }

        Ok(out_path.to_string_lossy().to_string())
    }).await.map_err(|e| format!("Task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_attribute() {
        let line = r#"<TRACK TrackID="1" Name="First Track" Location="file://localhost/Users/hugues/Music/First.mp3">"#;
        assert_eq!(extract_attribute(line, "TrackID"), Some("1".to_string()));
        assert_eq!(extract_attribute(line, "Location"), Some("file://localhost/Users/hugues/Music/First.mp3".to_string()));
    }

    #[test]
    fn test_unescape_xml() {
        assert_eq!(unescape_xml("Guns N&#39; Roses"), "Guns N' Roses");
        assert_eq!(unescape_xml("Rock &#x26; Roll"), "Rock & Roll");
        assert_eq!(unescape_xml("&quot;Hello &amp; World&#x27;s&quot;"), "\"Hello & World's\"");
    }

    #[test]
    fn test_decode_location() {
        assert_eq!(
            decode_location("file://localhost/Users/hugues/Music/First%20Track.mp3"),
            Some("/Users/hugues/Music/First Track.mp3".to_string())
        );
        assert_eq!(
            decode_location("file:///Users/hugues/Music/First%20Track.mp3"),
            Some("/Users/hugues/Music/First Track.mp3".to_string())
        );
    }

    #[test]
    fn test_multiline_track_parsing() {
        let temp_dir = std::env::temp_dir();
        let xml_path = temp_dir.join("test_multiline_collection.xml");
        let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="2">
    <TRACK TrackID="1" Name="Track One" Artist="Artist One"
           Location="file://localhost/Users/hugues/Music/Track1.mp3"
           Tonality="1A" />
    <TRACK TrackID="2" Name="Track Two"
           Artist="Artist Two"
           Location="file://localhost/Users/hugues/Music/Track2.mp3" />
  </COLLECTION>
</DJ_PLAYLISTS>
"#;
        std::fs::write(&xml_path, xml_content).unwrap();

        let res = tauri::async_runtime::block_on(parse_and_validate_xml_inner(None, xml_path.to_string_lossy().to_string())).unwrap();

        assert!(res.success);
        assert_eq!(res.healthy_count + res.missing_count, 2);
        assert_eq!(res.missing_count, 2);
        assert_eq!(res.missing_list.len(), 2);
        assert_eq!(res.missing_list[0], "/Users/hugues/Music/Track1.mp3");
        assert_eq!(res.missing_list[1], "/Users/hugues/Music/Track2.mp3");

        let _ = std::fs::remove_file(xml_path);
    }

    #[test]
    fn test_clean_fuzzy() {
        assert_eq!(clean_fuzzy("Destination Calabria (feat. Crystal Waters)"), "destinationcalabria");
        assert_eq!(clean_fuzzy("Destination Calabria (Original Mix)"), "destinationcalabria");
        assert_eq!(clean_fuzzy("Destination Calabria [Extended Mix]"), "destinationcalabria");
        assert_eq!(clean_fuzzy("Alex Gaudino"), "alexgaudino");
    }

    #[test]
    fn test_update_rekordbox_xml() {
        let temp_dir = std::env::temp_dir().join(format!("test_upg_xml_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&temp_dir);

        let orig_xml_path = temp_dir.join("collection.xml");
        let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="2">
    <TRACK TrackID="1" Name="Song One" Location="file://localhost/Music/OldSong1.mp3" />
    <TRACK TrackID="2" Name="Song Two" Location="file://localhost/Music/OldSong2.mp3" />
  </COLLECTION>
</DJ_PLAYLISTS>"#;
        std::fs::write(&orig_xml_path, xml_content).unwrap();

        let ledger_path = temp_dir.join(".crateup-progress.json");
        let ledger_content = r#"{
  "session_id": "test-session",
  "root_path": "/Music",
  "output_format": "flac",
  "files": {
    "/OldSong1.mp3": {
      "status": "downloaded",
      "original_abs_path": "/Music/OldSong1.mp3",
      "output_path": "/Music/NewSong1.flac"
    },
    "/OldSong2.mp3": {
      "status": "downloaded",
      "original_abs_path": "/Music/OldSong2.mp3",
      "output_path": "/Music/NewSong2.flac"
    }
  }
}"#;
        std::fs::write(&ledger_path, ledger_content).unwrap();

        let mut decisions = std::collections::HashMap::new();
        decisions.insert("/OldSong1.mp3".to_string(), "approved".to_string());
        decisions.insert("/OldSong2.mp3".to_string(), "skipped".to_string());

        let upgraded_path_str = tauri::async_runtime::block_on(update_rekordbox_xml(
            orig_xml_path.to_string_lossy().to_string(),
            ledger_path.to_string_lossy().to_string(),
            decisions,
            None,
        )).unwrap();

        let upgraded_xml = std::fs::read_to_string(&upgraded_path_str).unwrap();
        // Song 1 should have updated Location with flac
        assert!(upgraded_xml.contains("Location=\"file://localhost/Music/NewSong1.flac\""));
        // Song 2 was skipped, so Location remains OldSong2.mp3
        assert!(upgraded_xml.contains("Location=\"file://localhost/Music/OldSong2.mp3\""));

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn test_shift_xml_cues_and_tempo() {
        let tempo = r#"  <TEMPO Inizio="0.100" Bpm="128.00" Metro="4/4" Battito="1"/>"#;
        let shifted_tempo = shift_xml_cues_and_tempo(tempo, 45);
        assert!(shifted_tempo.contains("Inizio=\"0.145\""));

        // Clamping negative offset to 0.000
        let shifted_neg = shift_xml_cues_and_tempo(tempo, -200);
        assert!(shifted_neg.contains("Inizio=\"0.000\""));

        let cue = r#"  <POSITION_MARK Name="Drop" Type="0" Start="1.200" Num="1"/>"#;
        let shifted_cue = shift_xml_cues_and_tempo(cue, 50);
        assert!(shifted_cue.contains("Start=\"1.250\""));

        let loop_cue = r#"  <POSITION_MARK Name="Loop" Type="1" Start="10.000" End="20.000" Num="2"/>"#;
        let shifted_loop = shift_xml_cues_and_tempo(loop_cue, 35);
        assert!(shifted_loop.contains("Start=\"10.035\""));
        assert!(shifted_loop.contains("End=\"20.035\""));

        // End="-1" sentinel untouched
        let cue_sentinel = r#"  <POSITION_MARK Name="Cue" Type="0" Start="5.000" End="-1" Num="3"/>"#;
        let shifted_sentinel = shift_xml_cues_and_tempo(cue_sentinel, 40);
        assert!(shifted_sentinel.contains("Start=\"5.040\""));
        assert!(shifted_sentinel.contains("End=\"-1\""));
    }

    #[test]
    fn test_native_xml_playlists_parsing() {
        let temp_dir = std::env::temp_dir().join(format!(
            "crateup-xml-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let xml_path = temp_dir.join("collection.xml");
        let xml_content = r#"<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="3">
    <TRACK TrackID="10" Location="file://localhost/Users/test/Track%2010.mp3" />
    <TRACK TrackID="20" Location="file://localhost/Users/test/Track%2020.mp3" />
    <TRACK TrackID="30" Location="file://localhost/Users/test/Track%2030.mp3" />
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT">
      <NODE Type="0" Name="Parent Folder">
        <NODE Type="1" Name="Playlist A" Entries="2">
          <TRACK Key="10" />
          <TRACK Key="20" />
        </NODE>
        <NODE Type="0" Name="Subfolder">
          <NODE Type="1" Name="Playlist B" Entries="2">
            <TRACK Key="20" />
            <TRACK Key="30" />
          </NODE>
          <NODE Type="1" Name="Empty" Entries="0" />
        </NODE>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>"#;
        std::fs::write(&xml_path, xml_content).unwrap();

        // 1. Test streaming get_xml_track_count
        let count = get_xml_track_count(xml_path.to_string_lossy().to_string()).unwrap();
        assert_eq!(count, 3);

        // 2. Test parse_playlists_inner
        let json_tree = parse_playlists_inner(&xml_path.to_string_lossy()).unwrap();
        let nodes: Vec<PlaylistUiNode> = serde_json::from_str(&json_tree).unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].name, "Parent Folder");
        assert_eq!(nodes[0].node_type, "folder");
        assert_eq!(nodes[0].total_tracks, Some(4)); // Playlist A (2) + Playlist B (2) + Empty (0)

        // 3. Test get_playlist_tracks_inner
        let tracks_a = get_playlist_tracks_inner(&xml_path.to_string_lossy(), "Playlist A").unwrap();
        assert_eq!(tracks_a, vec!["/Users/test/Track 10.mp3", "/Users/test/Track 20.mp3"]);

        // 4. Test get_folder_tracks_inner (deduplicates Track 20 across subfolders)
        let folder_tracks = get_folder_tracks_inner(&xml_path.to_string_lossy(), "Parent Folder").unwrap();
        assert_eq!(folder_tracks, vec!["/Users/test/Track 10.mp3", "/Users/test/Track 20.mp3", "/Users/test/Track 30.mp3"]);

        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
