const path = require('path');
const os = require('os');
const fs = require('fs');

require('./bin-setup');

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

  const candidateScripts = [
    path.join(__dirname, '..', 'python-sidecar', 'main.py'),
    path.join(__dirname, '..', 'Resources', 'python-sidecar', 'main.py'),
    path.join(path.dirname(process.execPath), '..', 'Resources', 'python-sidecar', 'main.py'),
    path.join(path.dirname(process.execPath), '..', 'Resources', '_up_', 'python-sidecar', 'main.py'),
  ];
  const pythonScript = candidateScripts.find(p => fs.existsSync(p)) || candidateScripts[0];

  const candidatePythons = [
    path.join(__dirname, '..', 'python-runtime', 'bin', 'python3'),
    path.join(__dirname, '..', 'Resources', 'python-runtime', 'bin', 'python3'),
    path.join(__dirname, '..', 'Resources', '_up_', 'python-runtime', 'bin', 'python3'),
    path.join(path.dirname(process.execPath), '..', 'Resources', 'python-runtime', 'bin', 'python3'),
    path.join(path.dirname(process.execPath), '..', 'Resources', '_up_', 'python-runtime', 'bin', 'python3'),
    path.join(__dirname, '..', 'python-runtime', 'bin', 'python'),
    path.join(__dirname, '..', '.venv', 'bin', 'python'),
    path.join(path.dirname(process.execPath), '..', '.venv', 'bin', 'python'),
  ];
  const resolvedPython = candidatePythons.find(p => fs.existsSync(p));
  const pythonExec = resolvedPython || 'python3';
  
  log(`Spawning Python sidecar: ${pythonExec} ${pythonScript}`);
  const pyProcess = spawn(pythonExec, [pythonScript]);

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
