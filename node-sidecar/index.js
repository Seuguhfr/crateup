const path = require('path');
const os = require('os');
const fs = require('fs');

const resourcesPath = path.join(path.dirname(process.execPath), '../Resources');
process.env.PATH = `${resourcesPath}:${process.env.PATH}`;

function setupBinaries() {
  try {
    const arch = process.arch === 'x64' ? 'x86_64' : (process.arch === 'arm64' ? 'aarch64' : process.arch);
    let platformStr = '';
    if (process.platform === 'darwin') platformStr = 'apple-darwin';
    else if (process.platform === 'win32') platformStr = 'pc-windows-msvc';
    else if (process.platform === 'linux') platformStr = 'unknown-linux-gnu';

    const suffix = `-${arch}-${platformStr}`;
    const binDir = path.join(os.tmpdir(), 'crateup-bin');
    
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    const prodBinDir = path.join(resourcesPath, 'binaries');
    const devBinDir = path.join(__dirname, '..', 'src-tauri', 'binaries');
    
    let activeBinDir = fs.existsSync(prodBinDir) ? prodBinDir : devBinDir;

    const binaries = ['ffmpeg', 'ffprobe'];
    for (const bin of binaries) {
      const targetLinkPath = path.join(binDir, bin);
      const sourceFilePath = path.join(activeBinDir, `${bin}${suffix}`);
      
      if (!fs.existsSync(targetLinkPath)) {
        if (fs.existsSync(sourceFilePath)) {
          try {
            fs.symlinkSync(sourceFilePath, targetLinkPath);
            fs.chmodSync(targetLinkPath, 0o755);
            console.log(`[NODE] Created symlink: ${targetLinkPath} -> ${sourceFilePath}`);
          } catch (e) {
            try {
              fs.copyFileSync(sourceFilePath, targetLinkPath);
              fs.chmodSync(targetLinkPath, 0o755);
              console.log(`[NODE] Copied fallback: ${targetLinkPath} -> ${sourceFilePath}`);
            } catch (copyErr) {
              console.error(`[NODE] Failed to copy fallback for ${bin}: ${copyErr.message}`);
            }
          }
        } else {
          console.error(`[NODE] Source binary not found: ${sourceFilePath}`);
        }
      } else if (activeBinDir === prodBinDir) {
        try {
          fs.chmodSync(targetLinkPath, 0o755);
        } catch (e) {}
      }
    }

    process.env.PATH = `${binDir}:${process.env.PATH}`;
  } catch (err) {
    console.error(`[NODE] Error setting up binaries: ${err.message}`);
  }
}
setupBinaries();

const { spawn } = require('child_process');
const readline = require('readline');

function log(msg) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${now}] [NODE] ${msg}`);
}

function logError(msg) {
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.error(`[${now}] [NODE] ERROR: ${msg}`);
}

async function main() {
  log("Starting Node orchestrator...");

  // Path to main.py
  const pythonScript = path.join(__dirname, '..', 'python-sidecar', 'main.py');
  
  log(`Spawning Python sidecar: python3 ${pythonScript}`);
  const pyProcess = spawn('python3', [pythonScript]);

  // Read Python's stderr and log it to stderr
  pyProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (line.trim()) {
        console.error(line.trim());
      }
    }
  });

  // Read Python's stdout line-by-line using readline
  const rl = readline.createInterface({
    input: pyProcess.stdout,
    terminal: false
  });

  // Setup promise to wait for the expected response
  const responsePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timeout waiting for response from Python sidecar"));
    }, 5000);

    rl.on('line', (line) => {
      log(`Received from Python stdout: ${line}`);
      try {
        const response = JSON.parse(line);
        if (response.id === "1" && response.result === "pong") {
          clearTimeout(timeout);
          resolve(response);
        } else {
          log(`Received unexpected JSON-RPC message: ${line}`);
        }
      } catch (err) {
        logError(`Failed to parse line from Python stdout: ${line}`);
      }
    });

    pyProcess.on('close', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Python process closed prematurely with code ${code}`));
    });

    pyProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Send ping request
  const pingRequest = {
    id: "1",
    method: "ping",
    params: {}
  };
  
  const pingMsg = JSON.stringify(pingRequest) + "\n";
  log(`Sending ping: ${pingMsg.trim()}`);
  pyProcess.stdin.write(pingMsg);

  try {
    const response = await responsePromise;
    log(`Success! Ping/pong test passed. Response: ${JSON.stringify(response)}`);
    pyProcess.stdin.end();
    // Allow process to exit naturally or force exit on success
    setTimeout(() => process.exit(0), 100);
  } catch (err) {
    logError(`Ping/pong test failed: ${err.message}`);
    pyProcess.kill();
    process.exit(1);
  }
}

main();
