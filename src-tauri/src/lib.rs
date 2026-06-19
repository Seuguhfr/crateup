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
    backup_filename: Option<String>,
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
        backup_filename: None,
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

fn get_audio_fingerprint(fpcalc_path: &std::path::Path, file_path: &std::path::Path) -> Option<Vec<i32>> {
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
            let fingerprint: Vec<i32> = fp_str
                .split(',')
                .filter_map(|s| s.trim().parse::<i32>().ok())
                .collect();
            if !fingerprint.is_empty() {
                return Some(fingerprint);
            }
        }
    }
    
    None
}

fn calculate_similarity(fp1: &[i32], fp2: &[i32]) -> f64 {
    if fp1.is_empty() || fp2.is_empty() {
        return 0.0;
    }
    
    let (a, b) = if fp1.len() <= fp2.len() {
        (fp1, fp2)
    } else {
        (fp2, fp1)
    };
    
    let n = a.len() as isize;
    let m = b.len() as isize;
    
    let min_overlap = std::cmp::min(60, n);
    let mut max_sim = 0.0;
    
    let start_offset = -n + min_overlap;
    let end_offset = m - min_overlap;
    
    for d in start_offset..=end_offset {
        let start_a = std::cmp::max(0, -d);
        let end_a = std::cmp::min(n, m - d);
        let k = end_a - start_a;
        
        if k < min_overlap {
            continue;
        }
        
        let mut matching_bits = 0;
        for i in start_a..end_a {
            let x = a[i as usize];
            let y = b[(i + d) as usize];
            matching_bits += 32 - (x ^ y).count_ones();
        }
        
        let sim = (matching_bits as f64) / ((k * 32) as f64);
        if sim > max_sim {
            max_sim = sim;
        }
    }
    
    max_sim
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
    
    let mut processed_strict_map: std::collections::HashMap<(u64, String), std::path::PathBuf> = std::collections::HashMap::new();
    let mut processed_standard_map: std::collections::HashMap<(String, String), std::path::PathBuf> = std::collections::HashMap::new();
    let mut processed_fingerprints: Vec<(Vec<i32>, std::path::PathBuf)> = Vec::new();
    
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
                        
                        let mut target_path = std::path::PathBuf::new();
                        let mut is_duplicate = false;
                        let mut duplicate_target_path = None;
                        let mut current_fp = None;

                        if dedup_depth == "strict" || dedup_depth == "tier1" {
                            let key = (file_size, filename_str.clone());
                            if let Some(prev_path) = processed_strict_map.get(&key) {
                                is_duplicate = true;
                                duplicate_target_path = Some(prev_path.clone());
                            }
                        } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                            let key = (artist.to_lowercase(), title.to_lowercase());
                            if let Some(prev_path) = processed_standard_map.get(&key) {
                                is_duplicate = true;
                                duplicate_target_path = Some(prev_path.clone());
                            }
                        } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                            let fpcalc_path = get_fpcalc_path(&window.app_handle());
                            let fp = get_audio_fingerprint(&fpcalc_path, &src_path);
                            if let Some(fp_val) = fp {
                                for (prev_fp, prev_path) in &processed_fingerprints {
                                    let sim = calculate_similarity(&fp_val, prev_fp);
                                    if sim > 0.90 {
                                        is_duplicate = true;
                                        duplicate_target_path = Some(prev_path.clone());
                                        break;
                                    }
                                }
                                current_fp = Some(fp_val);
                            }
                        }

                        let mut needs_write = true;
                        if is_duplicate {
                            target_path = duplicate_target_path.unwrap();
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
                                "hardlink" => std::fs::hard_link(&src_path, &target_path),
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
                            
                            if !is_duplicate {
                                if dedup_depth == "strict" || dedup_depth == "tier1" {
                                    let key = (file_size, filename_str.clone());
                                    processed_strict_map.insert(key, target_path.clone());
                                } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                                    let key = (artist.to_lowercase(), title.to_lowercase());
                                    processed_standard_map.insert(key, target_path.clone());
                                } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                                    if let Some(fp_val) = current_fp {
                                        processed_fingerprints.push((fp_val, target_path.clone()));
                                    }
                                }
                            }
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
        backup_filename: None,
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
    folder_arch: String,
    dedup_depth: String,
    renaming_rule: String,
) -> Result<ResultPayload, String> {
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
    
    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    
    let mut tracks = Vec::new();
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
    drop(rows);
    drop(stmt);
    
    let total = tracks.len();
    let mut processed = 0;
    let mut healthy_count = 0;
    let mut missing_count = 0;
    let mut duplicate_count = 0;
    let mut missing_list = Vec::new();
    
    let mut processed_strict_map: std::collections::HashMap<(u64, String), std::path::PathBuf> = std::collections::HashMap::new();
    let mut processed_standard_map: std::collections::HashMap<(String, String), std::path::PathBuf> = std::collections::HashMap::new();
    let mut processed_fingerprints: Vec<(Vec<i32>, std::path::PathBuf)> = Vec::new();
    
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
            healthy_count += 1;
            
            let file_size = std::fs::metadata(&src_path).map(|m| m.len()).unwrap_or(0);
            
            let mut target_path = std::path::PathBuf::new();
            let mut is_duplicate = false;
            let mut duplicate_target_path = None;
            let mut current_fp = None;

            if dedup_depth == "strict" || dedup_depth == "tier1" {
                let key = (file_size, filename_str.clone());
                if let Some(prev_path) = processed_strict_map.get(&key) {
                    is_duplicate = true;
                    duplicate_target_path = Some(prev_path.clone());
                }
            } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                let key = (track.artist.to_lowercase(), track.title.to_lowercase());
                if let Some(prev_path) = processed_standard_map.get(&key) {
                    is_duplicate = true;
                    duplicate_target_path = Some(prev_path.clone());
                }
            } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                let fpcalc_path = get_fpcalc_path(&window.app_handle());
                let fp = get_audio_fingerprint(&fpcalc_path, &src_path);
                if let Some(fp_val) = fp {
                    for (prev_fp, prev_path) in &processed_fingerprints {
                        let sim = calculate_similarity(&fp_val, prev_fp);
                        if sim > 0.90 {
                            is_duplicate = true;
                            duplicate_target_path = Some(prev_path.clone());
                            break;
                        }
                    }
                    current_fp = Some(fp_val);
                }
            }

            let mut needs_write = true;
            if is_duplicate {
                target_path = duplicate_target_path.unwrap();
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
                let bpm_folder = if bpm_num > 0 {
                    let start = (bpm_num / 10) * 10;
                    format!("{}-{}", start, start + 9)
                } else {
                    "Unknown BPM".to_string()
                };
                
                let sub_dir = match folder_arch.as_str() {
                    "key" => {
                        let key_val = sanitize_filename(&track.key);
                        if key_val.is_empty() { "Unknown Key".to_string() } else { key_val }
                    }
                    "bpm" => bpm_folder,
                    "year" => {
                        let year_val = if track.year_num > 0 { track.year_num.to_string() } else { "".to_string() };
                        let year_val_clean = sanitize_filename(&year_val);
                        if year_val_clean.is_empty() { "Unknown Year".to_string() } else { year_val_clean }
                    }
                    _ => "".to_string(),
                };
                
                let target_dir = if sub_dir.is_empty() {
                    dest_dir.to_path_buf()
                } else {
                    dest_dir.join(&sub_dir)
                };
                
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
                    "hardlink" => std::fs::hard_link(&src_path, &target_path),
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
                
                if !is_duplicate {
                    if dedup_depth == "strict" || dedup_depth == "tier1" {
                        let key = (file_size, filename_str.clone());
                        processed_strict_map.insert(key, target_path.clone());
                    } else if dedup_depth == "standard" || dedup_depth == "tier2" {
                        let key = (track.artist.to_lowercase(), track.title.to_lowercase());
                        processed_standard_map.insert(key, target_path.clone());
                    } else if dedup_depth == "fuzzy" || dedup_depth == "tier3" {
                        if let Some(fp_val) = current_fp {
                            processed_fingerprints.push((fp_val, target_path.clone()));
                        }
                    }
                }
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
    
    tx.commit().map_err(|e| format!("Failed to commit database changes: {}", e))?;
    
    Ok(ResultPayload {
        success: true,
        healthy_count,
        missing_count,
        duplicate_count,
        missing_list,
        backup_filename: Some(backup_filename),
    })
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
            open_directory,
            check_rekordbox_status,
            get_db_backups,
            execute_backup_cleanup,
            execute_db_consolidation,
            rollback_to_latest_backup
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
    }

}
