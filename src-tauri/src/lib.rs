use tauri::Manager;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandEvent;

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
        
        // 2. Delete root_path/.crateup-progress.json if it exists
        let progress_file = root.join(".crateup-progress.json");
        if progress_file.exists() {
            std::fs::remove_file(&progress_file).map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            select_directory,
            select_output_directory,
            select_xml_file,
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
            save_arl
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
