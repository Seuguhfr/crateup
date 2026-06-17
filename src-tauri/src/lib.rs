use tauri::Manager;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;
use std::fs::File;
use std::io::{BufRead, BufReader};

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
) -> Result<CommitResult, String> {
    let decisions_json = serde_json::to_string(&decisions).map_err(|e| e.to_string())?;
    
    let script = format!(
        r#"
        const {{ commit }} = require("./commit.js");
        const decisionsJson = {};
        const decisions = new Map(Object.entries(decisionsJson));
        commit("{}", decisions, "{}").then(result => {{
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
        output_path.replace('\\', "\\\\").replace('"', "\\\"")
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
}

#[derive(serde::Serialize, Clone)]
struct ProgressPayload {
    track_name: String,
    processed: usize,
    total: usize,
    percentage: u32,
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
                        ((processed * 100) / total) as u32
                    } else {
                        0
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
    })
}

#[tauri::command]
async fn parse_and_validate_xml(
    window: tauri::Window,
    xml_path: String,
) -> Result<ResultPayload, String> {
    parse_and_validate_xml_inner(Some(&window), xml_path).await
}

#[derive(serde::Serialize, Clone)]
struct ConsolidationProgressPayload {
    filename: String,
    processed: usize,
    total: usize,
    percentage: u32,
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

#[tauri::command]
async fn execute_safe_clone(
    window: tauri::Window,
    xml_path: String,
    destination_path: String,
    file_mode: String,
    folder_arch: String,
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
    let mut missing_list = Vec::new();
    let mut missing_track_ids: Vec<String> = Vec::new();
    let mut line_buf = String::new();
    
    let mut processed_files = std::collections::HashSet::new();
    let mut processed_metadata = std::collections::HashSet::new();
    
    let mut xml_out = String::new();
    
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
                            ((processed * 100) / total) as u32
                        } else {
                            0
                        };
                        
                        let progress = ConsolidationProgressPayload {
                            filename: format!("(Missing) {}", filename_str),
                            processed,
                            total,
                            percentage,
                        };
                        
                        let _ = window.emit("consolidation-progress", progress);
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
                        
                        let is_duplicate = if dedup_depth == "strict" || dedup_depth == "tier1" {
                            let key = (file_size, filename_str.clone());
                            !processed_files.insert(key)
                        } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                            let key = (artist.to_lowercase(), title.to_lowercase());
                            !processed_metadata.insert(key)
                        } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                            let key = (clean_fuzzy(&artist), clean_fuzzy(&title));
                            !processed_metadata.insert(key)
                        } else {
                            false
                        };
                        
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
                            let max_stem_len = 120; // Truncate stem to 120 chars so stem + ext + directory never exceeds segment limits (255)
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
                        
                        let sub_dir = match folder_arch.as_str() {
                            "key" => {
                                let key_val = sanitize_filename(&decode_xml_entities(&key));
                                if key_val.is_empty() { "Unknown Key".to_string() } else { key_val }
                            }
                            "bpm" => bpm_folder,
                            "year" => {
                                let year_val = sanitize_filename(&decode_xml_entities(&year));
                                if year_val.is_empty() { "Unknown Year".to_string() } else { year_val }
                            }
                            _ => "".to_string(),
                        };
                        
                        let target_dir = if sub_dir.is_empty() {
                            dest_dir.to_path_buf()
                        } else {
                            dest_dir.join(&sub_dir)
                        };
                        
                        // Force Directory Creation
                        if let Err(e) = std::fs::create_dir_all(&target_dir) {
                            eprintln!("[Consolidation Error] Failed to create directories {:?}: {}", target_dir, e);
                        }
                        
                        let mut target_path = target_dir.join(&new_filename);
                        let mut counter = 1;
                        let mut needs_write = true;
                        
                        let src_size = std::fs::metadata(&src_path).map(|m| m.len()).unwrap_or(0);
                        
                        while target_path.exists() {
                            if let Ok(target_meta) = std::fs::metadata(&target_path) {
                                if target_meta.len() == src_size {
                                    // File exists with the exact same size, assume it's already copied (resume/collision success)
                                    needs_write = false;
                                    break;
                                }
                            }
                            // Name conflict with a different file size, generate unique name
                            let final_filename = format!("{} ({}).{}", truncated_stem, counter, ext);
                            target_path = target_dir.join(&final_filename);
                            counter += 1;
                        }
                        
                        let mut copy_success = true;
                        if is_duplicate {
                            // Duplicate skipped
                            duplicate_count += 1;
                        } else if needs_write {
                            // Execute Physical I/O
                            let op_result = match file_mode.as_str() {
                                "move" => std::fs::rename(&src_path, &target_path),
                                "hardlink" => std::fs::hard_link(&src_path, &target_path),
                                _ => std::fs::copy(&src_path, &target_path).map(|_| ()),
                            };
                            
                            if let Err(e) = op_result {
                                eprintln!("[Consolidation Error] Failed operation for {:?} -> {:?}: {}", src_path, target_path, e);
                                copy_success = false;
                                
                                // Revert healthy_count increment and count as missing/failed instead
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
                        }
                        
                        let percentage = if total > 0 {
                            ((processed * 100) / total) as u32
                        } else {
                            0
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
                        
                        let _ = window.emit("consolidation-progress", progress);
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            select_directory,
            select_output_directory,
            select_xml_file,
            get_xml_track_count,
            check_ledger_exists,
            read_ledger_file,
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
            open_directory
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
}
