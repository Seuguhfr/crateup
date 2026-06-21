use tauri::Manager;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use std::fs::File;
use std::io::{BufRead, BufReader};
use rusqlite::OptionalExtension;

#[derive(serde::Serialize, serde::Deserialize)]
struct CommitResult {
    committed: u32,
    skipped: u32,
    failed: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct RekordboxResult {
    matched: u32,
    unmatched: u32,
    rewritten: u32,
}

async fn run_node_script(app: &tauri::AppHandle, script: &str) -> Result<String, String> {
    let node_sidecar_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("No parent for CARGO_MANIFEST_DIR")?
        .join("node-sidecar");
        
    let project_root = node_sidecar_dir.parent().ok_or("No parent for node-sidecar dir")?;
    let venv_bin = project_root.join(".venv/bin");
    let current_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", venv_bin.to_string_lossy(), current_path);

    let output = app.shell()
        .sidecar("node")
        .map_err(|e| e.to_string())?
        .args(&["-e", script])
        .current_dir(node_sidecar_dir)
        .env("PATH", new_path)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn select_directory() -> Option<String> {
    rfd::FileDialog::new()
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
fn get_xml_track_count(xml_path: String) -> Result<usize, String> {
    let content = std::fs::read_to_string(&xml_path).map_err(|e| e.to_string())?;
    Ok(content.matches("Location=\"").count())
}


#[tauri::command]
fn check_ledger_exists(root_path: String) -> bool {
    let p = std::path::Path::new(&root_path).join(".crateup-progress.json");
    p.exists()
}

#[tauri::command]
fn read_ledger_file(ledger_path: String) -> Result<String, String> {
    let content = std::fs::read_to_string(&ledger_path).map_err(|e| e.to_string())?;
    let mut val: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    
    let mut modified = false;
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
        std::fs::write(&ledger_path, &updated).map_err(|e| e.to_string())?;
        Ok(updated)
    } else {
        Ok(content)
    }
}

#[tauri::command]
fn write_ledger_file(ledger_path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&ledger_path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&ledger_path, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_node_path(_app: tauri::AppHandle) -> Result<String, String> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("No parent for CARGO_MANIFEST_DIR")?
        .join("node-sidecar/index.js");
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn start_pipeline(
    app: tauri::AppHandle,
    root_path: String,
    output_format: String,
    file_list: Option<Vec<String>>,
    skip_high_quality: Option<bool>,
) {
    tauri::async_runtime::spawn(async move {
        let pipeline_js = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("node-sidecar/pipeline.js");
            
        let node_sidecar_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("node-sidecar");

        if !pipeline_js.exists() {
            let err_msg = format!("pipeline.js does not exist at resolved path: {:?}", pipeline_js);
            eprintln!("[ERROR] {}", err_msg);
            let _ = app.emit("pipeline-log", serde_json::json!({ "line": format!("{}\n", err_msg) }));
            let _ = app.emit("pipeline-done", -1);
            return;
        }

        if !node_sidecar_dir.exists() {
            let err_msg = format!("node-sidecar directory does not exist at resolved path: {:?}", node_sidecar_dir);
            eprintln!("[ERROR] {}", err_msg);
            let _ = app.emit("pipeline-log", serde_json::json!({ "line": format!("{}\n", err_msg) }));
            let _ = app.emit("pipeline-done", -1);
            return;
        }

        let project_root = match node_sidecar_dir.parent() {
            Some(p) => p,
            None => {
                let err_msg = "Failed to find parent of node-sidecar directory".to_string();
                eprintln!("[ERROR] {}", err_msg);
                let _ = app.emit("pipeline-log", serde_json::json!({ "line": format!("{}\n", err_msg) }));
                let _ = app.emit("pipeline-done", -1);
                return;
            }
        };

        let venv_bin = project_root.join(".venv/bin");
        let current_path = std::env::var("PATH").unwrap_or_default();
        let new_path = format!("{}:{}", venv_bin.to_string_lossy(), current_path);

        let mut command_args = vec![
            pipeline_js.to_string_lossy().to_string(),
            root_path.clone(),
            output_format.clone(),
        ];

        if let Some(true) = skip_high_quality {
            command_args.push("--skip-high-quality".to_string());
        }

        if let Some(ref list) = file_list {
            let list_json = serde_json::to_string(list).unwrap_or_default();
            command_args.push(list_json);
        }

        eprintln!(
            "[DEBUG] Spawning sidecar: node\n  Args: {:?}\n  Cwd: {:?}\n  PATH: {}",
            command_args, node_sidecar_dir, new_path
        );

        let sidecar_cmd = match app.shell().sidecar("node") {
            Ok(cmd) => cmd,
            Err(e) => {
                let err_msg = format!("Failed to initialize sidecar 'node': {}", e);
                eprintln!("[ERROR] {}", err_msg);
                let _ = app.emit("pipeline-log", serde_json::json!({ "line": format!("{}\n", err_msg) }));
                let _ = app.emit("pipeline-done", -1);
                return;
            }
        };

        let spawn_res = sidecar_cmd
            .args(&command_args)
            .current_dir(&node_sidecar_dir)
            .env("PATH", &new_path)
            .spawn();

        let (mut rx, _child) = match spawn_res {
            Ok(res) => res,
            Err(e) => {
                let err_msg = format!("Failed to spawn sidecar: {} (Check if 'node' binary is on PATH. Current PATH: {})", e, new_path);
                eprintln!("[ERROR] {}", err_msg);
                let _ = app.emit("pipeline-log", serde_json::json!({ "line": format!("{}\n", err_msg) }));
                let _ = app.emit("pipeline-done", -1);
                return;
            }
        };

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    let _ = app.emit("pipeline-log", serde_json::json!({ "line": line }));
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    let _ = app.emit("pipeline-log", serde_json::json!({ "line": line }));
                }
                CommandEvent::Terminated(status) => {
                    let code = status.code.unwrap_or(-1);
                    let _ = app.emit("pipeline-done", code);
                    break;
                }
                _ => {}
            }
        }
    });
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
    std::fs::write(&ledger_path, updated).map_err(|e| e.to_string())?;
    
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
    let decisions_json = serde_json::to_string(&decisions).map_err(|e| e.to_string())?;
    
    let script = format!(
        r#"
        const {{ commit }} = require("./commit.js");
        const decisionsJson = {};
        const decisions = new Map(Object.entries(decisionsJson));
        commit("{}", decisions, "{}", "{}", true).then(result => {{
            let committed = 0;
            let skipped = 0;
            const failed = result.failures.map(f => f.relPath);
            for (const [path, dec] of decisions) {{
                if (failed.includes(path)) continue;
                if (dec === "approved") committed++;
                else skipped++;
            }}
            console.log(JSON.stringify({{ committed, skipped, failed }}));
            process.exit(0);
        }}).catch(err => {{
            console.error(err);
            process.exit(1);
        }});
        "#,
        decisions_json,
        ledger_path.replace('\\', "\\\\").replace('"', "\\\""),
        output_path.replace('\\', "\\\\").replace('"', "\\\""),
        output_strategy.replace('\\', "\\\\").replace('"', "\\\"")
    );

    let output_str = run_node_script(&app, &script).await?;
    let result: CommitResult = serde_json::from_str(&output_str.trim()).map_err(|e| {
        format!("Failed to parse commit result JSON: {}. Output was: {}", e, output_str)
    })?;
    
    Ok(result)
}

#[tauri::command]
async fn update_rekordbox(
    app: tauri::AppHandle,
    xml_path: String,
    ledger_path: String,
    root_path: String,
    output_path: String,
) -> Result<RekordboxResult, String> {
    let script = format!(
        r#"
        const {{ updateXML }} = require("./rekordbox.js");
        const fs = require("fs");
        const ledger = JSON.parse(fs.readFileSync("{}", "utf8"));
        updateXML("{}", ledger, "{}", "{}").then(result => {{
            console.log(JSON.stringify(result));
            process.exit(0);
        }}).catch(err => {{
            console.error(err);
            process.exit(1);
        }});
        "#,
        ledger_path.replace('\\', "\\\\").replace('"', "\\\""),
        xml_path.replace('\\', "\\\\").replace('"', "\\\""),
        root_path.replace('\\', "\\\\").replace('"', "\\\""),
        output_path.replace('\\', "\\\\").replace('"', "\\\"")
    );

    let output_str = run_node_script(&app, &script).await?;
    let result: RekordboxResult = serde_json::from_str(&output_str.trim()).map_err(|e| {
        format!("Failed to parse rekordbox result JSON: {}. Output was: {}", e, output_str)
    })?;

    Ok(result)
}

#[tauri::command]
fn get_file_size(path: String) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

#[tauri::command]
fn check_file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
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
    let script = format!(
        r#"
        const {{ refetchTrack }} = require("./refetch.js");
        const rootPath = "{}";
        const outputFormat = "{}";
        const relPath = "{}";
        const deezerId = {};
        const artist = "{}";
        const title = "{}";
        
        const cp = require("child_process");
        const path = require("path");
        
        const child = cp.spawn(process.execPath, [
            "refetch.js",
            rootPath,
            outputFormat,
            relPath,
            deezerId.toString(),
            artist,
            title
        ]);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", data => stdout += data);
        child.stderr.on("data", data => stderr += data);
        child.on("close", code => {{
            if (code === 0) {{
                console.log(stdout.trim());
                process.exit(0);
            }} else {{
                console.error(stderr.trim());
                process.exit(1);
            }}
        }});
        "#,
        root_path.replace('\\', "\\\\").replace('"', "\\\""),
        output_format.replace('\\', "\\\\").replace('"', "\\\""),
        relative_path.replace('\\', "\\\\").replace('"', "\\\""),
        deezer_id,
        artist.replace('\\', "\\\\").replace('"', "\\\""),
        title.replace('\\', "\\\\").replace('"', "\\\"")
    );

    run_node_script(&app, &script).await
}

#[tauri::command]
async fn identify_track(
    app: tauri::AppHandle,
    root_path: String,
    relative_path: String,
) -> Result<String, String> {
    let script = format!(
        r#"
        const cp = require("child_process");
        
        const child = cp.spawn(process.execPath, [
            "identify.js",
            "{}",
            "{}"
        ]);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", data => stdout += data);
        child.stderr.on("data", data => stderr += data);
        child.on("close", code => {{
            if (code === 0) {{
                console.log(stdout.trim());
                process.exit(0);
            }} else {{
                console.error(stderr.trim());
                process.exit(1);
            }}
        }});
        "#,
        root_path.replace('\\', "\\\\").replace('"', "\\\""),
        relative_path.replace('\\', "\\\\").replace('"', "\\\"")
    );

    run_node_script(&app, &script).await
}

#[tauri::command]
fn reset_session(root_path: String, is_session_dir: bool) -> Result<(), String> {
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

fn get_project_arl_path() -> Result<std::path::PathBuf, String> {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let parent = manifest_dir.parent().ok_or("No parent for CARGO_MANIFEST_DIR")?;
    Ok(parent.join(".arl"))
}

#[tauri::command]
fn get_arl(app: tauri::AppHandle) -> String {
    // 1. Try reading project .arl file
    if let Ok(project_arl_path) = get_project_arl_path() {
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
    }

    "".to_string()
}

#[tauri::command]
fn save_arl(app: tauri::AppHandle, arl: String) -> Result<(), String> {
    let trimmed = arl.trim();

    // 1. Write to project .arl file
    if let Ok(project_arl_path) = get_project_arl_path() {
        std::fs::write(&project_arl_path, trimmed).map_err(|e| e.to_string())?;
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
        }

        // 3. Write to ~/Library/Application Support/deemix/.arl
        let app_support_deemix = home.join("Library/Application Support/deemix");
        if let Err(e) = std::fs::create_dir_all(&app_support_deemix) {
            eprintln!("[save_arl] Failed to create Library/Application Support/deemix: {}", e);
        }
        let arl_file_app_support = app_support_deemix.join(".arl");
        if let Err(e) = std::fs::write(&arl_file_app_support, trimmed) {
            eprintln!("[save_arl] Failed to write to {}: {}", arl_file_app_support.display(), e);
        }
    }

    Ok(())
}

async fn run_pipeline_rpc(app: &tauri::AppHandle, request_json: String) -> Result<String, String> {
    let pipeline_js = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("No parent for CARGO_MANIFEST_DIR")?
        .join("node-sidecar/pipeline.js");
        
    let node_sidecar_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("No parent for CARGO_MANIFEST_DIR")?
        .join("node-sidecar");

    let project_root = node_sidecar_dir.parent().ok_or("No parent for node-sidecar dir")?;
    let venv_bin = project_root.join(".venv/bin");
    let current_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", venv_bin.to_string_lossy(), current_path);

    let sidecar_cmd = app.shell()
        .sidecar("node")
        .map_err(|e| e.to_string())?
        .args(&[pipeline_js.to_string_lossy().to_string()])
        .current_dir(node_sidecar_dir)
        .env("PATH", new_path);

    let (mut rx, mut child) = sidecar_cmd.spawn().map_err(|e| e.to_string())?;

    child.write(format!("{}\n", request_json).as_bytes()).map_err(|e| e.to_string())?;

    let mut response = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line_bytes) => {
                response = String::from_utf8_lossy(&line_bytes).to_string();
                break;
            }
            CommandEvent::Stderr(line_bytes) => {
                let err_msg = String::from_utf8_lossy(&line_bytes).to_string();
                eprintln!("[RPC Error] {}", err_msg);
            }
            CommandEvent::Terminated(_) => {
                break;
            }
            _ => {}
        }
    }

    Ok(response)
}

#[tauri::command]
async fn parse_playlists(app: tauri::AppHandle, xml_path: String) -> Result<String, String> {
    let req = serde_json::json!({
        "id": "parse_playlists_req",
        "method": "parse_playlists",
        "params": {
            "xml_path": xml_path
        }
    });
    let resp_str = run_pipeline_rpc(&app, req.to_string()).await?;
    let resp: serde_json::Value = serde_json::from_str(&resp_str).map_err(|e| e.to_string())?;
    if let Some(err) = resp.get("error") {
        return Err(err.as_str().unwrap_or("Unknown error").to_string());
    }
    let result = resp.get("result").ok_or("Missing result in JSON-RPC response")?;
    Ok(serde_json::to_string(result).map_err(|e| e.to_string())?)
}

#[tauri::command]
async fn get_playlist_tracks(app: tauri::AppHandle, xml_path: String, playlist_name: String) -> Result<Vec<String>, String> {
    let req = serde_json::json!({
        "id": "get_playlist_tracks_req",
        "method": "get_playlist_tracks",
        "params": {
            "xml_path": xml_path,
            "playlist_name": playlist_name
        }
    });
    let resp_str = run_pipeline_rpc(&app, req.to_string()).await?;
    let resp: serde_json::Value = serde_json::from_str(&resp_str).map_err(|e| e.to_string())?;
    if let Some(err) = resp.get("error") {
        return Err(err.as_str().unwrap_or("Unknown error").to_string());
    }
    let result = resp.get("result").ok_or("Missing result in JSON-RPC response")?;
    let paths: Vec<String> = serde_json::from_value(result.clone()).map_err(|e| e.to_string())?;
    Ok(paths)
}

#[tauri::command]
async fn get_folder_tracks(app: tauri::AppHandle, xml_path: String, folder_name: String) -> Result<Vec<String>, String> {
    let req = serde_json::json!({
        "id": "get_folder_tracks_req",
        "method": "get_folder_tracks",
        "params": {
            "xml_path": xml_path,
            "folder_name": folder_name
        }
    });
    let resp_str = run_pipeline_rpc(&app, req.to_string()).await?;
    let resp: serde_json::Value = serde_json::from_str(&resp_str).map_err(|e| e.to_string())?;
    if let Some(err) = resp.get("error") {
        return Err(err.as_str().unwrap_or("Unknown error").to_string());
    }
    let result = resp.get("result").ok_or("Missing result in JSON-RPC response")?;
    let paths: Vec<String> = serde_json::from_value(result.clone()).map_err(|e| e.to_string())?;
    Ok(paths)
}

#[derive(serde::Serialize, Clone)]
struct ResultPayload {
    success: bool,
    healthy_count: usize,
    missing_count: usize,
    duplicate_count: usize,
    missing_list: Vec<String>,
    backup_filename: Option<String>,
    processed_list: Option<Vec<String>>,
    duplicate_list: Option<Vec<Vec<String>>>, // Vec of [kept_file, skipped_file] pairs
}

#[derive(serde::Serialize, Clone)]
struct ProgressPayload {
    track_name: String,
    processed: usize,
    total: usize,
    percentage: f64,
}

fn extract_attribute(line: &str, attr: &str) -> Option<String> {
    let search_str = format!("{}=\"", attr);
    if let Some(start_idx) = line.find(&search_str) {
        let val_start = start_idx + search_str.len();
        if let Some(end_idx) = line[val_start..].find('"') {
            return Some(line[val_start..(val_start + end_idx)].to_string());
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
    
    if cfg!(target_os = "windows") {
        if final_path.starts_with('/') && final_path.len() >= 3 && final_path.as_bytes()[2] == b':' {
            final_path.remove(0);
        }
    }
    
    Some(final_path)
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
    })
}

#[tauri::command]
async fn parse_and_validate_xml(
    window: tauri::Window,
    xml_path: String,
) -> Result<ResultPayload, String> {
    parse_and_validate_xml_inner(Some(&window), xml_path).await
}

fn get_fpcalc_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let temp_path = std::env::temp_dir().join("crateup-bin").join("fpcalc");
    if temp_path.exists() {
        return temp_path;
    }
    
    if let Ok(resource_dir) = app.path().resource_dir() {
        let arch = if cfg!(target_arch = "x86_64") {
            "x86_64"
        } else if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            ""
        };
        let platform = if cfg!(target_os = "macos") {
            "apple-darwin"
        } else if cfg!(target_os = "windows") {
            "pc-windows-msvc"
        } else if cfg!(target_os = "linux") {
            "unknown-linux-gnu"
        } else {
            ""
        };
        
        if !arch.is_empty() && !platform.is_empty() {
            let bin_name = format!("fpcalc-{}-{}", arch, platform);
            let resource_path = resource_dir.join("binaries").join(&bin_name);
            if resource_path.exists() {
                return resource_path;
            }
        }
    }
    
    std::path::PathBuf::from("fpcalc")
}

fn get_audio_fingerprint(fpcalc_path: &std::path::Path, file_path: &std::path::Path) -> Option<Vec<u32>> {
    let output = std::process::Command::new(fpcalc_path)
        .arg("-raw")
        .arg(file_path)
        .output()
        .ok()?;
        
    if !output.status.success() {
        return None;
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.starts_with("FINGERPRINT=") {
            let fp_str = &line["FINGERPRINT=".len()..];
            let fingerprint: Vec<u32> = fp_str
                .split(',')
                .filter_map(|s| s.trim().parse::<u32>().ok())
                .collect();
            if !fingerprint.is_empty() {
                return Some(fingerprint);
            }
        }
    }
    
    None
}

fn calculate_similarity(fp1: &[u32], fp2: &[u32]) -> f64 {
    if fp1.is_empty() || fp2.is_empty() {
        return 0.0;
    }
    
    let len1 = fp1.len();
    let len2 = fp2.len();
    let max_len = std::cmp::max(len1, len2);
    let min_len = std::cmp::min(len1, len2);
    // If lengths differ by more than 20%, skip comparing (only for files of substantial length)
    if max_len > 10 && max_len - min_len > (max_len * 20) / 100 {
        return 0.0;
    }
    
    let (a, b) = if len1 <= len2 {
        (fp1, fp2)
    } else {
        (fp2, fp1)
    };
    
    // Trick 1: Global Bit-Weight (Hamming Weight) Density Filter with safe/loose 25% margin
    let ones_a: usize = a.iter().map(|&x| x.count_ones() as usize).sum();
    let ones_b: usize = b.iter().map(|&x| x.count_ones() as usize).sum();
    let da = ones_a as f64 / (a.len() * 32) as f64;
    let db = ones_b as f64 / (b.len() * 32) as f64;
    let density_diff = (da - db).abs();
    if density_diff > 0.25 {
        return 0.0;
    }

    // Trick 2: Middle-Subsegment Fast-Scan (Acoustic Anchoring) with loose 60% match margin
    let anchor_len = std::cmp::min(40, a.len());
    if anchor_len > 10 {
        let start_idx = (a.len() - anchor_len) / 2;
        let anchor = &a[start_idx..start_idx + anchor_len];
        let mut anchor_matched = false;
        
        for d in (0..=(b.len() - anchor_len)).step_by(2) {
            let mut match_bits = 0;
            for i in 0..anchor_len {
                let x = anchor[i];
                let y = b[d + i];
                match_bits += 32 - (x ^ y).count_ones() as usize;
            }
            let sim = (match_bits as f64) / (anchor_len * 32) as f64;
            if sim > 0.60 {
                anchor_matched = true;
                break;
            }
        }
        if !anchor_matched {
            return 0.0;
        }
    }

    let n = a.len() as isize;
    let m = b.len() as isize;
    let min_overlap = std::cmp::min(60, n);
    
    let start_offset = -n + min_overlap;
    let end_offset = m - min_overlap;
    let total_offsets = end_offset - start_offset;

    let mut candidates = Vec::new();
    let use_coarse = total_offsets > 16;

    // Trick 3: Coarse Grid Sub-sampling (Offset skipping with 65% screening filter)
    if use_coarse {
        let coarse_step = 8;
        for d in (start_offset..=end_offset).step_by(coarse_step) {
            let start_a = std::cmp::max(0, -d);
            let end_a = std::cmp::min(n, m - d);
            let k = end_a - start_a;
            if k < min_overlap {
                continue;
            }
            
            let mut match_bits = 0;
            let mut sample_count = 0;
            for i in (start_a..end_a).step_by(4) {
                let x = a[i as usize];
                let y = b[(i + d) as usize];
                match_bits += 32 - (x ^ y).count_ones() as usize;
                sample_count += 1;
            }
            if sample_count > 0 {
                let est = (match_bits as f64) / (sample_count * 32) as f64;
                if est > 0.65 {
                    candidates.push(d);
                }
            }
        }
        if candidates.is_empty() {
            return 0.0;
        }
    }

    let mut offsets_to_check = Vec::new();
    if use_coarse {
        for &coarse_d in &candidates {
            let start_range = std::cmp::max(start_offset, coarse_d - 4);
            let end_range = std::cmp::min(end_offset, coarse_d + 4);
            for d in start_range..=end_range {
                offsets_to_check.push(d);
            }
        }
        offsets_to_check.sort_unstable();
        offsets_to_check.dedup();
    } else {
        offsets_to_check.extend(start_offset..=end_offset);
    }
    
    println!("DEBUG similarity - candidates: {:?}", candidates);
    println!("DEBUG similarity - offsets_to_check: {:?}", offsets_to_check);

    let mut max_sim = 0.0;
    for &d in &offsets_to_check {
        let start_a = std::cmp::max(0, -d);
        let end_a = std::cmp::min(n, m - d);
        let k = end_a - start_a;
        if k < min_overlap {
            continue;
        }
        
        let k_u = k as usize;
        let threshold_bits = (k_u * 288) / 10;
        let mut matching_bits = 0;
        let mut possible_failed = false;
        let mut count = 0;
        
        for i in start_a..end_a {
            let x = a[i as usize];
            let y = b[(i + d) as usize];
            matching_bits += 32 - (x ^ y).count_ones() as usize;
            
            if count % 16 == 0 {
                let remaining_max = (k_u - 1 - count) * 32;
                if matching_bits + remaining_max < threshold_bits {
                    possible_failed = true;
                    break;
                }
            }
            count += 1;
        }
        
        if !possible_failed {
            let sim = (matching_bits as f64) / ((k * 32) as f64);
            if sim > max_sim {
                max_sim = sim;
                // Trick 4: Early Exit on Match
                if max_sim >= 0.90 {
                    return max_sim;
                }
            }
        }
    }
    
    max_sim
}

#[derive(serde::Serialize, Clone)]
struct ConsolidationProgressPayload {
    filename: String,
    processed: usize,
    total: usize,
    percentage: f64,
}

fn decode_xml_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

fn sanitize_filename(name: &str) -> String {
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
        } else if in_parentheses == 0 {
            if c.is_alphanumeric() {
                cleaned.push(c.to_ascii_lowercase());
            }
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

fn encode_location(path: &std::path::Path) -> String {
    let path_str = path.to_string_lossy();
    let normalized = path_str.replace('\\', "/");
    let segments: Vec<String> = normalized
        .split('/')
        .map(|seg| {
            if seg.is_empty() {
                String::new()
            } else {
                percent_encoding::utf8_percent_encode(seg, percent_encoding::NON_ALPHANUMERIC).to_string()
            }
        })
        .collect();
    let mut encoded = segments.join("/");
    if !encoded.starts_with('/') {
        encoded = format!("/{}", encoded);
    }
    format!("file://localhost{}", encoded)
}

fn format_priority(ext: &str) -> u8 {
    match ext {
        "flac" | "wav" | "aiff" | "aif" => 2,
        "mp3" | "m4a" => 1,
        _ => 0,
    }
}

fn is_better_quality(ext_a: &str, size_a: u64, ext_b: &str, size_b: u64) -> bool {
    let pri_a = format_priority(ext_a);
    let pri_b = format_priority(ext_b);
    if pri_a != pri_b {
        pri_a > pri_b
    } else {
        size_a > size_b
    }
}

#[tauri::command]
async fn execute_safe_clone(
    window: tauri::Window,
    xml_path: String,
    destination_path: String,
    file_mode: String,
    cross_format: String,
    dedup_depth: String,
    renaming_rule: String,
) -> Result<ResultPayload, String> {
    let file = File::open(&xml_path).map_err(|e| format!("Failed to open XML file: {}", e))?;
    let mut reader = BufReader::new(file);
    
    let mut total = 0;
    let mut processed = 0;
    let mut healthy_count = 0;
    let mut missing_count = 0;
    let mut duplicate_count = 0;
    let mut processed_list = Vec::new();
    let mut duplicate_list = Vec::new();
    let mut missing_list = Vec::new();
    let mut missing_track_ids: Vec<String> = Vec::new();
    let mut line_buf = String::new();
    
    let mut processed_strict_map: std::collections::HashMap<(u64, String), std::path::PathBuf> = std::collections::HashMap::new();
    let mut processed_standard_map: std::collections::HashMap<(String, String), (std::path::PathBuf, String, u64)> = std::collections::HashMap::new();
    let mut processed_fingerprints: Vec<(Vec<u32>, std::path::PathBuf, String, u64)> = Vec::new();
    
    let mut xml_out = String::new();
    
    let mut fingerprint_cache: std::collections::HashMap<std::path::PathBuf, Vec<u32>> = std::collections::HashMap::new();
    if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
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
            let fpcalc_path = get_fpcalc_path(&window.app_handle());
            let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
            let mut tasks = Vec::new();
            
            for path in track_paths {
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
            
            let mut completed = 0;
            for task in tasks {
                if let Ok((path, Some(fp))) = task.await {
                    fingerprint_cache.insert(path, fp);
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
                        
                        let progress = ConsolidationProgressPayload {
                            filename: format!("(Missing) {}", filename_str),
                            processed,
                            total,
                            percentage,
                        };
                        
                        let _ = window.emit("rebuilder-consolidation-progress", progress);
                    } else {
                        // Increment healthy_count since exists is true
                        healthy_count += 1;
                        
                        let artist = extract_attribute(trimmed_track, "Artist").unwrap_or_default();
                        let title = extract_attribute(trimmed_track, "Name").unwrap_or_default();
                        let key = extract_attribute(trimmed_track, "Tonality").unwrap_or_default();
                        let bpm = extract_attribute(trimmed_track, "AverageBpm").unwrap_or_default();
                        let year = extract_attribute(trimmed_track, "Year").unwrap_or_default();
                        
                        let file_size = std::fs::metadata(&src_path)
                            .map(|m| m.len())
                            .unwrap_or(0);
                        
                        let mut target_path = std::path::PathBuf::new();
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
                                    if is_better_quality(&current_ext, file_size, prev_ext, prev_size) {
                                        should_swap_duplicate = true;
                                        swap_prev_path = Some(prev_path.clone());
                                    }
                                }
                            }
                        } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                            let fp = fingerprint_cache.get(src_path).cloned().or_else(|| {
                                let fpcalc_path = get_fpcalc_path(&window.app_handle());
                                get_audio_fingerprint(&fpcalc_path, src_path)
                            });
                            if let Some(fp_val) = fp {
                                for (prev_fp, prev_path, prev_ext, prev_size) in &processed_fingerprints {
                                    let sim = calculate_similarity(&fp_val, prev_fp);
                                    if sim > 0.90 {
                                        let current_ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                                        if cross_format == "smart" || prev_ext == &current_ext {
                                            is_duplicate = true;
                                            duplicate_target_path = Some(prev_path.clone());
                                            if is_better_quality(&current_ext, file_size, prev_ext, *prev_size) {
                                                should_swap_duplicate = true;
                                                swap_prev_path = Some(prev_path.clone());
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
                            
                            let bpm_val = if let Some(dot_idx) = bpm.find('.') {
                                bpm[..dot_idx].to_string()
                            } else {
                                bpm.clone()
                            };
                            let bpm_num: u32 = bpm_val.parse().unwrap_or(0);
                            let bpm_folder = if bpm_num > 0 {
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
                                "move" => std::fs::rename(&src_path, &target_path),
                                "hardlink" | "link" => std::fs::hard_link(&src_path, &target_path),
                                _ => std::fs::copy(&src_path, &target_path).map(|_| ()),
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
                            } else {
                                processed_list.push(target_path.to_string_lossy().to_string());
                                
                                if should_swap_duplicate {
                                    duplicate_count += 1;
                                    
                                    if let Some(ref p_path) = swap_prev_path {
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
                                    if let Some(fp_val) = current_fp {
                                        let mut updated = false;
                                        if let Some(ref p_path) = swap_prev_path {
                                            for entry in &mut processed_fingerprints {
                                                if &entry.1 == p_path {
                                                    entry.0 = fp_val.clone();
                                                    entry.1 = target_path.clone();
                                                    entry.2 = current_ext.clone();
                                                    entry.3 = file_size;
                                                    updated = true;
                                                    break;
                                                }
                                            }
                                        }
                                        if !updated {
                                            processed_fingerprints.push((fp_val, target_path.clone(), current_ext, file_size));
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
    
    Ok(ResultPayload {
        success: true,
        healthy_count,
        missing_count,
        duplicate_count,
        missing_list,
        backup_filename: None,
        processed_list: Some(processed_list),
        duplicate_list: Some(duplicate_list),
    })
}

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

#[derive(serde::Serialize)]
struct RekordboxStatus {
    running: bool,
    db_exists: bool,
    db_path: String,
}

#[tauri::command]
async fn check_rekordbox_status() -> Result<RekordboxStatus, String> {
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
async fn get_db_backups() -> Result<Vec<String>, String> {
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
struct CleanupReport {
    results: Vec<CleanupResult>,
}

#[tauri::command]
async fn execute_backup_cleanup(backup_filename: String) -> Result<CleanupReport, String> {
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
    
    let conn_live = open_rekordbox_db(&db_path)?;
    let mut stmt_live = conn_live.prepare("SELECT FolderPath FROM djmdContent").map_err(|e| e.to_string())?;
    let mut rows_live = stmt_live.query([]).map_err(|e| e.to_string())?;
    let mut live_paths = std::collections::HashSet::new();
    while let Some(row) = rows_live.next().map_err(|e| e.to_string())? {
        let path: String = row.get(0).map_err(|e| e.to_string())?;
        if !path.trim().is_empty() {
            live_paths.insert(path);
        }
    }
    drop(rows_live);
    drop(stmt_live);
    
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
        
        match std::fs::remove_file(file_path) {
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

#[tauri::command]
async fn execute_db_consolidation(
    window: tauri::Window,
    destination_path: String,
    file_mode: String,
    cross_format: String,
    dedup_depth: String,
    renaming_rule: String,
) -> Result<ResultPayload, String> {
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
            
            let mut paths_to_fingerprint = Vec::new();
            for track in &tracks {
                let src_path = std::path::PathBuf::from(&track.folder_path);
                if src_path.exists() {
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
                        fingerprint_cache.insert(path, fp);
                    }
                }
            }
        }
        
        let mut processed_strict_map: std::collections::HashMap<(u64, String), std::path::PathBuf> = std::collections::HashMap::new();
        let mut processed_standard_map: std::collections::HashMap<(String, String), (std::path::PathBuf, String, u64)> = std::collections::HashMap::new();
        let mut processed_fingerprints: Vec<(Vec<u32>, std::path::PathBuf, String, u64)> = Vec::new();
        
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
                
                let mut target_path = std::path::PathBuf::new();
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
                    let key = (track.artist.to_lowercase(), track.title.to_lowercase());
                    if let Some(&(ref prev_path, ref prev_ext, prev_size)) = processed_standard_map.get(&key) {
                        let current_ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                        if cross_format == "smart" || prev_ext == &current_ext {
                            is_duplicate = true;
                            duplicate_target_path = Some(prev_path.clone());
                            if is_better_quality(&current_ext, file_size, prev_ext, prev_size) {
                                should_swap_duplicate = true;
                                swap_prev_path = Some(prev_path.clone());
                            }
                        }
                    }
                } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                    let fp = fingerprint_cache.get(src_path).cloned().or_else(|| {
                        let fpcalc_path = get_fpcalc_path(&window.app_handle());
                        get_audio_fingerprint(&fpcalc_path, src_path)
                    });
                    if let Some(fp_val) = fp {
                        for (prev_fp, prev_path, prev_ext, prev_size) in &processed_fingerprints {
                            let sim = calculate_similarity(&fp_val, prev_fp);
                            if sim > 0.90 {
                                let current_ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                                if cross_format == "smart" || prev_ext == &current_ext {
                                    is_duplicate = true;
                                    duplicate_target_path = Some(prev_path.clone());
                                    if is_better_quality(&current_ext, file_size, prev_ext, *prev_size) {
                                        should_swap_duplicate = true;
                                        swap_prev_path = Some(prev_path.clone());
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
                    let update_res = tx.execute(
                        "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE ID = ?",
                        rusqlite::params![new_folder_path, new_file_name, track.id],
                    );
                    if let Err(e) = update_res {
                        eprintln!("[Consolidation Error] Failed to update DB for track {}: {}", track.id, e);
                    }
                    
                    if is_duplicate && !should_swap_duplicate {
                        // Add details: [kept_file, skipped_file]
                        duplicate_list.push(vec![
                            target_path.to_string_lossy().to_string(),
                            src_path.to_string_lossy().to_string()
                        ]);
                    } else {
                        processed_list.push(target_path.to_string_lossy().to_string());
                        
                        if should_swap_duplicate {
                            duplicate_count += 1;
                            
                            if let Some(ref p_path) = swap_prev_path {
                                let p_path_str = p_path.to_string_lossy().to_string();
                                if let Some(pos) = processed_list.iter().position(|x| x == &p_path_str) {
                                    processed_list.remove(pos);
                                }
                                
                                let update_prev_res = tx.execute(
                                    "UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE FolderPath = ?",
                                    rusqlite::params![new_folder_path, new_file_name, p_path_str],
                                );
                                if let Err(e) = update_prev_res {
                                    eprintln!("[Consolidation Error] Failed to update previous DB records for {}: {}", p_path_str, e);
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
                            processed_strict_map.insert(key, target_path.clone());
                        } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                            let key = (track.artist.to_lowercase(), track.title.to_lowercase());
                            processed_standard_map.insert(key, (target_path.clone(), current_ext, file_size));
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
                                            updated = true;
                                            break;
                                        }
                                    }
                                }
                                if !updated {
                                    processed_fingerprints.push((fp_val, target_path.clone(), current_ext, file_size));
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
        })
    }).await.map_err(|e| format!("Blocking task failed to join: {}", e))?
}

#[tauri::command]
async fn rollback_to_latest_backup() -> Result<String, String> {
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
        
    std::fs::remove_file(&backup_path)
        .map_err(|e| format!("Successfully restored database, but failed to delete backup file: {}", e))?;
        
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

#[tauri::command]
async fn parse_playlists_from_db() -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let db_path = get_rekordbox_db_path()?;
        if !db_path.exists() {
            return Err("Rekordbox master.db database not found".to_string());
        }

        let temp_dir = std::env::temp_dir();
        let temp_db_path = temp_dir.join("crateup_upgrader_master.db");
        std::fs::copy(&db_path, &temp_db_path).map_err(|e| format!("Failed to create temporary database copy: {}", e))?;

        let conn = open_rekordbox_db(&temp_db_path)?;

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
                root_nodes.push(build_node(&conn, item, &raw_playlists));
            }
        }

        let _ = std::fs::remove_file(temp_db_path);

        serde_json::to_string(&root_nodes).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_playlist_tracks_from_db(playlist_name: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let db_path = get_rekordbox_db_path()?;
        if !db_path.exists() {
            return Err("Rekordbox master.db database not found".to_string());
        }

        let temp_dir = std::env::temp_dir();
        let temp_db_path = temp_dir.join("crateup_tracks_master.db");
        std::fs::copy(&db_path, &temp_db_path).map_err(|e| format!("Failed to create temporary database copy: {}", e))?;

        let conn = open_rekordbox_db(&temp_db_path)?;

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

        let _ = std::fs::remove_file(temp_db_path);

        Ok(paths)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_folder_tracks_from_db(folder_name: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let db_path = get_rekordbox_db_path()?;
        if !db_path.exists() {
            return Err("Rekordbox master.db database not found".to_string());
        }

        let temp_dir = std::env::temp_dir();
        let temp_db_path = temp_dir.join("crateup_folder_tracks_master.db");
        std::fs::copy(&db_path, &temp_db_path).map_err(|e| format!("Failed to create temporary database copy: {}", e))?;

        let conn = open_rekordbox_db(&temp_db_path)?;

        let mut paths = Vec::new();

        let folder_query = "SELECT ID FROM djmdPlaylist WHERE Name = ? AND Attribute = 1 LIMIT 1";
        let folder_id: Option<String> = conn.query_row(folder_query, [&folder_name], |row| row.get(0)).optional().map_err(|e| e.to_string())?;

        if let Some(fid) = folder_id {
            let mut playlist_ids = Vec::new();
            get_all_child_playlist_ids(&conn, &fid, &mut playlist_ids)?;

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

        let _ = std::fs::remove_file(temp_db_path);

        Ok(paths)
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn update_rekordbox_db_directly(
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

        tx.commit().map_err(|e| format!("Failed to commit database changes: {}", e))?;

        Ok(())
    }).await.map_err(|e| e.to_string())?
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

#[derive(Debug, Clone)]
struct AudioMetadata {
    title: String,
    artist: String,
    duration: f64,
    bpm: String,
    key: String,
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

fn get_ffmpeg_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let temp_path = std::env::temp_dir().join("crateup-bin").join("ffmpeg");
    if temp_path.exists() {
        return temp_path;
    }
    
    if let Ok(resource_dir) = app.path().resource_dir() {
        let arch = if cfg!(target_arch = "x86_64") {
            "x86_64"
        } else if cfg!(target_arch = "aarch64") {
            "aarch64"
        } else {
            ""
        };
        let platform = if cfg!(target_os = "macos") {
            "apple-darwin"
        } else if cfg!(target_os = "windows") {
            "pc-windows-msvc"
        } else if cfg!(target_os = "linux") {
            "unknown-linux-gnu"
        } else {
            ""
        };
        
        if !arch.is_empty() && !platform.is_empty() {
            let bin_name = format!("ffmpeg-{}-{}", arch, platform);
            let resource_path = resource_dir.join("binaries").join(&bin_name);
            if resource_path.exists() {
                return resource_path;
            }
        }
    }
    
    std::path::PathBuf::from("ffmpeg")
}

fn get_audio_metadata(ffmpeg_path: &std::path::Path, file_path: &std::path::Path) -> AudioMetadata {
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
fn select_audio_files() -> Vec<String> {
    rfd::FileDialog::new()
        .add_filter("Audio Files", &["mp3", "wav", "flac", "aif", "aiff", "m4a"])
        .pick_files()
        .map(|paths| paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

#[tauri::command]
fn select_save_xml_file(default_name: String) -> Option<String> {
    rfd::FileDialog::new()
        .add_filter("Rekordbox XML", &["xml"])
        .set_file_name(&default_name)
        .save_file()
        .map(|p| p.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
struct ExpandedPathsResult {
    files: Vec<String>,
    suggested_playlist_name: String,
}

#[tauri::command]
fn expand_audio_paths(paths: Vec<String>) -> ExpandedPathsResult {
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

fn get_raw_audio_md5(ffmpeg_path: &std::path::Path, file_path: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new(ffmpeg_path)
        .arg("-i")
        .arg(file_path)
        .arg("-map")
        .arg("0:a")
        .arg("-f")
        .arg("md5")
        .arg("-")
        .output()
        .ok()?;
        
    if !output.status.success() {
        return None;
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.starts_with("MD5=") {
            let md5_str = &line["MD5=".len()..];
            return Some(md5_str.trim().to_lowercase());
        }
    }
    
    None
}

#[tauri::command]
async fn execute_playlist_ingestion(
    window: tauri::Window,
    staged_files: Vec<String>,
    playlist_name: String,
    destination_path: String,
    file_mode: String,
    cross_format: String,
    dedup_depth: String,
    renaming_rule: String,
    xml_save_path: String,
) -> Result<ResultPayload, String> {
    let dest_dir = std::path::Path::new(&destination_path);
    if !dest_dir.exists() {
        return Err(format!("Destination directory does not exist: {}", destination_path));
    }
    
    let ffmpeg_path = get_ffmpeg_path(&window.app_handle());
    
    let total = staged_files.len();
    let mut processed = 0;
    let mut healthy_count = 0;
    let mut missing_count = 0;
    let mut duplicate_count = 0;
    let mut missing_list = Vec::new();
    
    struct StagedTrackInfo {
        source_path: std::path::PathBuf,
        metadata: AudioMetadata,
        file_size: u64,
        extension: String,
        is_missing: bool,
    }
    
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
    
    if dedup_depth == "fuzzy" || dedup_depth == "tier3" || dedup_depth == "t3" {
        let fpcalc_path = get_fpcalc_path(&window.app_handle());
        let ffmpeg_path = get_ffmpeg_path(&window.app_handle());
        
        let _ = window.emit("ingest-consolidation-progress", ConsolidationProgressPayload {
            filename: "Pre-analyzing audio files...".to_string(),
            processed: 0,
            total,
            percentage: 0.0,
        });
        
        // Precompute raw MD5 and fingerprints in parallel
        let mut tasks = Vec::new();
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        
        let mut healthy_indices = Vec::new();
        for idx in 0..total {
            if tracks[idx].is_missing {
                continue;
            }
            healthy_indices.push(idx);
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
        
        let mut precomputed = std::collections::HashMap::new();
        let healthy_len = healthy_indices.len();
        let mut completed = 0;
        for task in tasks {
            if let Ok((idx, md5, fp)) = task.await {
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
        
        let mut processed_tracks: Vec<(usize, Option<String>, Option<Vec<u32>>)> = Vec::new();
        
        for idx in 0..total {
            if tracks[idx].is_missing {
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
                    let sim = calculate_similarity(cf, pf);
                    if sim > 0.90 {
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
        let mut groups: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
        
        for (idx, track) in tracks.iter().enumerate() {
            if track.is_missing {
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
        
        let op_res = match file_mode.as_str() {
            "move" => {
                std::fs::rename(&track.source_path, &target_file_path)
            }
            "link" => {
                if let Err(_) = std::fs::hard_link(&track.source_path, &target_file_path) {
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
    
    for idx in 0..total {
        if tracks[idx].is_missing {
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
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            select_directory,
            select_output_directory,
            select_xml_file,
            get_xml_track_count,
            check_ledger_exists,
            read_ledger_file,
            write_ledger_file,
            get_node_path,
            start_pipeline,
            save_ledger_decision,
            commit_changes,
            update_rekordbox,
            get_file_size,
            check_file_exists,
            parse_playlists,
            get_playlist_tracks,
            get_folder_tracks,
            show_confirm_dialog,
            reset_session,
            get_app_data_dir,
            download_track_by_id,
            identify_track,
            get_arl,
            save_arl,
            parse_and_validate_xml,
            execute_safe_clone,
            open_directory,
            check_rekordbox_status,
            get_db_backups,
            execute_backup_cleanup,
            execute_db_consolidation,
            rollback_to_latest_backup,
            select_audio_files,
            select_save_xml_file,
            expand_audio_paths,
            execute_playlist_ingestion,
            parse_playlists_from_db,
            get_playlist_tracks_from_db,
            get_folder_tracks_from_db,
            update_rekordbox_db_directly
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
    fn test_calculate_similarity() {
        let fp1 = vec![0x11111111, 0x22222222, 0x33333333];
        let fp2 = vec![0x11111111, 0x22222222, 0x33333333];
        assert!((calculate_similarity(&fp1, &fp2) - 1.0).abs() < 1e-9);

        let fp3 = vec![0x11111111, 0x22222222, 0x33333333, 0x44444444];
        let fp4 = vec![0x22222222, 0x33333333, 0x44444444]; // offset by 1
        let sim = calculate_similarity(&fp3, &fp4);
        assert!((sim - 1.0).abs() < 1e-9);

        // Dynamic test for user's files
        let path_abba1 = "/Users/hugues/Music/PioneerDJ/test/ABBA - Money, Money, Money (1).mp3";
        let path_abba2 = "/Users/hugues/Music/PioneerDJ/test/ABBA - Money, Money, Money.mp3";
        if std::path::Path::new(path_abba1).exists() && std::path::Path::new(path_abba2).exists() {
            let fpcalc = std::path::PathBuf::from("binaries/fpcalc-aarch64-apple-darwin");
            let f_abba1 = get_audio_fingerprint(&fpcalc, &std::path::PathBuf::from(path_abba1)).unwrap();
            let f_abba2 = get_audio_fingerprint(&fpcalc, &std::path::PathBuf::from(path_abba2)).unwrap();
            let sim_abba = calculate_similarity(&f_abba1, &f_abba2);
            assert!(sim_abba > 0.90, "ABBA similarity should be > 0.90, got {}", sim_abba);
        }

        let path_amel1 = "/Users/hugues/Music/PioneerDJ/test/Amel Bent - Ma philosophie (1).mp3";
        let path_amel2 = "/Users/hugues/Music/PioneerDJ/test/Amel Bent - Ma philosophie.mp3";
        if std::path::Path::new(path_amel1).exists() && std::path::Path::new(path_amel2).exists() {
            let fpcalc = std::path::PathBuf::from("binaries/fpcalc-aarch64-apple-darwin");
            let f_amel1 = get_audio_fingerprint(&fpcalc, &std::path::PathBuf::from(path_amel1)).unwrap();
            let f_amel2 = get_audio_fingerprint(&fpcalc, &std::path::PathBuf::from(path_amel2)).unwrap();
            let sim_amel = calculate_similarity(&f_amel1, &f_amel2);
            assert!(sim_amel > 0.90, "Amel Bent similarity should be > 0.90, got {}", sim_amel);
        }
    }

    #[test]
    fn test_is_better_quality() {
        // Different formats (lossless vs lossy)
        assert!(is_better_quality("flac", 1000, "mp3", 5000));
        assert!(is_better_quality("wav", 1000, "m4a", 5000));
        assert!(is_better_quality("aiff", 1000, "mp3", 5000));
        assert!(!is_better_quality("mp3", 5000, "flac", 1000));

        // Same formats, different sizes
        assert!(is_better_quality("mp3", 5000, "mp3", 1000));
        assert!(!is_better_quality("mp3", 1000, "mp3", 5000));
        assert!(!is_better_quality("mp3", 1000, "mp3", 1000));
    }

}
