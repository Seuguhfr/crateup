const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class PythonBridge {
  constructor() {
    this.pyProcess = null;
    this.pendingRequests = new Map();
    this.rl = null;
  }

  start() {
    const pythonScript = path.join(__dirname, '..', 'python-sidecar', 'main.py');
    const venvPython = path.join(__dirname, '..', '.venv', 'bin', 'python');
    const pythonExec = fs.existsSync(venvPython) ? venvPython : 'python3';
    
    this.pyProcess = spawn(pythonExec, [pythonScript]);

    this.pyProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          console.error(line.trim());
        }
      }
    });

    this.rl = readline.createInterface({
      input: this.pyProcess.stdout,
      terminal: false
    });

    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const response = JSON.parse(line);
        const id = response.id;
        if (id && this.pendingRequests.has(id)) {
          const { resolve, reject } = this.pendingRequests.get(id);
          this.pendingRequests.delete(id);
          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response.result);
          }
        }
      } catch (err) {
        console.error(`[NODE] [RPC] JSON parse error for line: ${line}`, err);
      }
    });

    this.pyProcess.on('close', (code) => {
      this.cleanupPending(new Error("Python sidecar process exited"));
    });

    this.pyProcess.on('error', (err) => {
      this.cleanupPending(err);
    });
  }

  cleanupPending(err) {
    for (const [id, { reject }] of this.pendingRequests.entries()) {
      reject(err);
    }
    this.pendingRequests.clear();
  }

  async call(method, params = {}) {
    if (!this.pyProcess) {
      throw new Error("Python bridge not started");
    }
    const id = crypto.randomUUID();
    const request = { id, method, params };
    
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.pyProcess.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  stop() {
    if (this.pyProcess) {
      this.pyProcess.stdin.end();
      this.pyProcess = null;
    }
  }
}

module.exports = PythonBridge;
