use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct FingerprintResult {
    #[serde(default)]
    pub deezer_id: Option<u64>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct DownloadResult {
    pub staged_path: String,
    #[serde(default)]
    pub proxy_path: Option<String>,
}

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<Result<serde_json::Value, String>>>>>;

#[derive(Clone)]
pub struct PythonBridge {
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: PendingMap,
    child: Arc<Mutex<Option<Child>>>,
}

pub fn find_python_executable(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("python-runtime").join("bin").join("python3");
        if p.exists() {
            return Some(p);
        }
        let p = resource_dir
            .join("_up_")
            .join("python-runtime")
            .join("bin")
            .join("python3");
        if p.exists() {
            return Some(p);
        }
    }

    let dev_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent();
    if let Some(parent) = dev_root {
        let p = parent.join("python-runtime").join("bin").join("python3");
        if p.exists() {
            return Some(p);
        }
        let p = parent.join(".venv").join("bin").join("python3");
        if p.exists() {
            return Some(p);
        }
    }

    if let Ok(out) = std::process::Command::new("python3").arg("--version").output() {
        if out.status.success() {
            return Some(PathBuf::from("python3"));
        }
    }
    None
}

pub fn find_python_script(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("python-sidecar").join("main.py");
        if p.exists() {
            return Some(p);
        }
        let p = resource_dir
            .join("_up_")
            .join("python-sidecar")
            .join("main.py");
        if p.exists() {
            return Some(p);
        }
    }

    let dev_root = Path::new(env!("CARGO_MANIFEST_DIR")).parent();
    if let Some(parent) = dev_root {
        let p = parent.join("python-sidecar").join("main.py");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

impl PythonBridge {
    pub async fn spawn(app: &tauri::AppHandle) -> Result<Self, String> {
        let py_exec = find_python_executable(app)
            .ok_or_else(|| "Could not locate python3 executable in runtime or PATH".to_string())?;
        let py_script = find_python_script(app)
            .ok_or_else(|| "Could not locate python-sidecar/main.py".to_string())?;

        let mut cmd = Command::new(&py_exec);
        cmd.arg("-u")
            .arg(&py_script)
            .env("PYTHONUNBUFFERED", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        // Setup PATH with bundled binaries
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(parent) = py_exec.parent() {
            dirs.push(parent.to_path_buf());
        }
        if let Ok(resource_dir) = app.path().resource_dir() {
            let bundled_bin = resource_dir.join("binaries");
            if bundled_bin.exists() {
                dirs.push(bundled_bin);
            }
        }
        if let Some(dev_parent) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            let dev_bin = dev_parent.join("src-tauri").join("binaries");
            if dev_bin.exists() {
                dirs.push(dev_bin);
            }
        }
        let current_path = std::env::var("PATH").unwrap_or_default();
        if !dirs.is_empty() {
            let prefix = dirs
                .iter()
                .map(|d| d.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(":");
            cmd.env("PATH", format!("{}:{}", prefix, current_path));
        }

        let mut child: Child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn Python sidecar: {}", e))?;

        let _pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture stdin for Python sidecar".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture stdout for Python sidecar".to_string())?;
        let stderr = child.stderr.take();

        if let Some(err_pipe) = stderr {
            tokio::spawn(async move {
                let mut reader = BufReader::new(err_pipe).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    if !line.trim().is_empty() {
                        eprintln!("[PYTHON STDERR] {}", line);
                    }
                }
            });
        }

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let pending_clone = pending.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                        let sender_opt = {
                            let mut guard = pending_clone.lock().await;
                            guard.remove(id)
                        };
                        if let Some(tx) = sender_opt {
                            if let Some(err) = val.get("error").and_then(|e| e.as_str()) {
                                let _ = tx.send(Err(err.to_string()));
                            } else if let Some(res) = val.get("result") {
                                let _ = tx.send(Ok(res.clone()));
                            } else {
                                let _ = tx.send(Ok(serde_json::Value::Null));
                            }
                        }
                    }
                }
            }
            // If stdout closes, fail remaining pending requests
            let mut guard = pending_clone.lock().await;
            for (_id, tx) in guard.drain() {
                let _ = tx.send(Err("Python sidecar stdout closed".to_string()));
            }
        });

        Ok(Self {
            stdin: Arc::new(Mutex::new(Some(stdin))),
            pending,
            child: Arc::new(Mutex::new(Some(child))),
        })
    }

    pub async fn call(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout_duration: Duration,
    ) -> Result<serde_json::Value, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let request = serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
        });
        let line = format!("{}\n", serde_json::to_string(&request).unwrap());

        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(id.clone(), tx);
        }

        {
            let mut stdin_guard = self.stdin.lock().await;
            if let Some(ref mut stdin) = *stdin_guard {
                if let Err(e) = stdin.write_all(line.as_bytes()).await {
                    let mut guard = self.pending.lock().await;
                    guard.remove(&id);
                    return Err(format!("Failed to write to Python sidecar stdin: {}", e));
                }
                if let Err(e) = stdin.flush().await {
                    let mut guard = self.pending.lock().await;
                    guard.remove(&id);
                    return Err(format!("Failed to flush Python sidecar stdin: {}", e));
                }
            } else {
                let mut guard = self.pending.lock().await;
                guard.remove(&id);
                return Err("Python sidecar stdin is not open".to_string());
            }
        }

        match timeout(timeout_duration, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Python sidecar response channel closed".to_string()),
            Err(_) => {
                let mut guard = self.pending.lock().await;
                guard.remove(&id);
                Err(format!(
                    "Python RPC call '{}' timed out after {:?}",
                    method, timeout_duration
                ))
            }
        }
    }

    #[allow(dead_code)]
    pub async fn ping(&self) -> Result<String, String> {
        let res = self
            .call("ping", serde_json::json!({}), Duration::from_secs(10))
            .await?;
        Ok(res.as_str().unwrap_or("pong").to_string())
    }

    pub async fn fingerprint(&self, path: &str) -> Result<FingerprintResult, String> {
        let res = self
            .call(
                "fingerprint",
                serde_json::json!({ "path": path }),
                Duration::from_secs(180),
            )
            .await?;
        serde_json::from_value(res).map_err(|e| format!("Failed to parse fingerprint result: {}", e))
    }

    pub async fn download(
        &self,
        deezer_id: u64,
        output_format: &str,
        staged_path: &str,
    ) -> Result<DownloadResult, String> {
        let res = self
            .call(
                "download",
                serde_json::json!({
                    "deezer_id": deezer_id,
                    "output_format": output_format,
                    "staged_path": staged_path,
                }),
                Duration::from_secs(180),
            )
            .await?;
        serde_json::from_value(res).map_err(|e| format!("Failed to parse download result: {}", e))
    }

    pub async fn stop(&self) {
        {
            let mut stdin_guard = self.stdin.lock().await;
            if let Some(mut stdin) = stdin_guard.take() {
                let _ = stdin.shutdown().await;
            }
        }
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            let _ = child.start_kill();
        }
        let mut guard = self.pending.lock().await;
        for (_id, tx) in guard.drain() {
            let _ = tx.send(Err("Python bridge stopped".to_string()));
        }
    }
}
