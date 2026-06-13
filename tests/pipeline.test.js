const fs = require('fs');
const path = require('path');

// Set node environment to test to bypass throttle delays
process.env.NODE_ENV = 'test';

const { runPipeline } = require('../node-sidecar/pipeline');

// Mock PythonBridge
jest.mock('../node-sidecar/rpc', () => {
  return jest.fn().mockImplementation(() => {
    return {
      start: jest.fn(),
      stop: jest.fn(),
      call: jest.fn().mockImplementation((method, params) => {
        const mockFs = require('fs');
        const mockPath = require('path');
        if (method === 'fingerprint') {
          if (params.path.includes('unidentified')) {
            throw new Error('unidentified');
          }
          if (params.path.includes('notondeezer')) {
            return { deezer_id: null, title: 'Not on Deezer', artist: 'Artist' };
          }
          if (params.path.includes('downloadfailed')) {
            return { deezer_id: 99999, title: 'Download Failed Track', artist: 'Artist' };
          }
          return { deezer_id: 12345, title: 'Mock Song', artist: 'Mock Artist' };
        }
        if (method === 'download') {
          if (params.deezer_id === 99999) {
            throw new Error('download_failed');
          }
          // Simulate creating the output file in mock download
          mockFs.mkdirSync(mockPath.dirname(params.staged_path), { recursive: true });
          mockFs.writeFileSync(params.staged_path, 'dummy audio');
          if (params.output_format === 'aiff') {
            const proxyPath = params.staged_path.replace('.aiff', '.proxy.mp3');
            mockFs.writeFileSync(proxyPath, 'dummy proxy');
            return { staged_path: params.staged_path, proxy_path: proxyPath };
          }
          return { staged_path: params.staged_path };
        }
      })
    };
  });
});

describe('Pipeline Loop Orchestrator', () => {
  const testRoot = path.join(__dirname, 'temp-pipeline-test');

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRoot);

    fs.writeFileSync(path.join(testRoot, 'normal.mp3'), 'dummy');
    fs.writeFileSync(path.join(testRoot, 'unidentified.mp3'), 'dummy');
    fs.writeFileSync(path.join(testRoot, 'notondeezer.mp3'), 'dummy');
    fs.writeFileSync(path.join(testRoot, 'downloadfailed.mp3'), 'dummy');
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('successfully processes files and updates ledger', async () => {
    const ledger = await runPipeline(testRoot, 'flac');
    
    expect(ledger.files['/normal.mp3'].status).toBe('downloaded');
    expect(ledger.files['/normal.mp3'].deezer_id).toBe(12345);
    const expectedStagedPath = path.join(testRoot, 'crateup-staging', 'Mock Artist - Mock Song.flac').split(path.sep).join('/');
    expect(ledger.files['/normal.mp3'].staged_path).toBe(expectedStagedPath);

    expect(ledger.files['/unidentified.mp3'].status).toBe('unidentified');
    expect(ledger.files['/notondeezer.mp3'].status).toBe('not_on_deezer');
    expect(ledger.files['/downloadfailed.mp3'].status).toBe('download_failed');

    const ledgerPath = path.join(testRoot, '.crateup-progress.json');
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const diskLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    expect(diskLedger.files['/normal.mp3'].status).toBe('downloaded');
  });
});
