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
          const { resolve, reject, timer } = this.pendingRequests.get(id);
          if (timer) clearTimeout(timer);
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
    for (const [id, { reject, timer }] of this.pendingRequests.entries()) {
      if (timer) clearTimeout(timer);
      reject(err);
    }
    this.pendingRequests.clear();
  }

  async call(method, params = {}, timeoutMs = 180000) {
    if (!this.pyProcess) {
      throw new Error("Python bridge not started");
    }
    const id = crypto.randomUUID();
    const request = { id, method, params };
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Python RPC call '${method}' timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.pyProcess.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  stop() {
    this.cleanupPending(new Error("Python bridge stopped"));
    if (this.pyProcess) {
      try { this.pyProcess.stdin.end(); } catch (e) {}
      this.pyProcess = null;
    }
  }
}

module.exports = PythonBridge;
