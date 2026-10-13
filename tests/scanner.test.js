const fs = require('fs');
const path = require('path');
const { scanDir, initLedger, scanFileList } = require('../node-sidecar/scanner');

describe('Directory Scanner and Ledger Init', () => {
  const testRoot = path.join(__dirname, 'temp-test-library');

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRoot);
    fs.mkdirSync(path.join(testRoot, 'subdir'));
    fs.mkdirSync(path.join(testRoot, '.hidden-dir'));

    fs.writeFileSync(path.join(testRoot, 'track1.mp3'), 'dummy');
    fs.writeFileSync(path.join(testRoot, 'track2.FLAC'), 'dummy');
    fs.writeFileSync(path.join(testRoot, 'subdir', 'track3.wav'), 'dummy');
    fs.writeFileSync(path.join(testRoot, '.hidden-dir', 'track4.mp3'), 'dummy');
    fs.writeFileSync(path.join(testRoot, '.ignored-file.mp3'), 'dummy');
    fs.writeFileSync(path.join(testRoot, 'text.txt'), 'dummy');
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('scanDir finds only supported audio files and ignores hidden files/directories', () => {
    const files = scanDir(testRoot, testRoot);
    expect(files).toHaveLength(3);
    // Sort to be order-independent
    const sorted = [...files].sort();
    expect(sorted[0]).toBe('/subdir/track3.wav');
    expect(sorted[1]).toBe('/track1.mp3');
    // Note: path extension matching is case-insensitive, but return value preserves original name case
    expect(sorted[2]).toBe('/track2.FLAC');
  });

  test('scanDir detects .aif and .aiff files', () => {
    fs.writeFileSync(path.join(testRoot, 'sample.aif'), 'dummy');
    fs.writeFileSync(path.join(testRoot, 'sample.aiff'), 'dummy');
    const files = scanDir(testRoot, testRoot);
    expect(files).toContain('/sample.aif');
    expect(files).toContain('/sample.aiff');
  });

  test('initLedger initializes a new ledger file', () => {
    const ledger = initLedger(testRoot, 'flac');
    expect(ledger.session_id).toBeDefined();
    expect(ledger.root_path).toBe(testRoot);
    expect(ledger.output_format).toBe('flac');
    expect(Object.keys(ledger.files)).toHaveLength(3);
    
    expect(ledger.files['/track1.mp3']).toEqual({
      status: 'pending',
      deezer_id: null,
      staged_path: null,
      proxy_path: null,
      original_bitrate: null,
      deezer_origin: false
    });

    const ledgerPath = path.join(testRoot, '.crateup-progress.json');
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const writtenLedger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    expect(writtenLedger.session_id).toBe(ledger.session_id);
  });

  test('initLedger merges with existing ledger file', () => {
    const initialLedgerPath = path.join(testRoot, '.crateup-progress.json');
    const existingSessionId = 'some-uuid-1234';
    const initialLedger = {
      session_id: existingSessionId,
      root_path: testRoot,
      output_format: 'mp3',
      files: {
        '/track1.mp3': {
          status: 'downloaded',
          deezer_id: 99999,
          staged_path: 'crateup-staging/track1.mp3',
          proxy_path: null
        }
      }
    };
    fs.writeFileSync(initialLedgerPath, JSON.stringify(initialLedger, null, 2), 'utf8');

    const mergedLedger = initLedger(testRoot, 'mp3');
    
    expect(mergedLedger.session_id).toBe(existingSessionId);
    expect(mergedLedger.files['/track1.mp3']).toEqual({
      status: 'downloaded',
      deezer_id: 99999,
      staged_path: 'crateup-staging/track1.mp3',
      proxy_path: null,
      original_bitrate: null,
      deezer_origin: false
    });

    expect(mergedLedger.files['/track2.FLAC']).toEqual({
      status: 'pending',
      deezer_id: null,
      staged_path: null,
      proxy_path: null,
      original_bitrate: null,
      deezer_origin: false
    });
  });

  test('initLedger resets fingerprinting and downloading status to pending', () => {
    const initialLedgerPath = path.join(testRoot, '.crateup-progress.json');
    const initialLedger = {
      session_id: 'test-session-uuid-3',
      root_path: testRoot,
      output_format: 'mp3',
      files: {
        '/track1.mp3': {
          status: 'fingerprinting',
          deezer_id: null,
          staged_path: null,
          proxy_path: null
        },
        '/track2.FLAC': {
          status: 'downloading',
          deezer_id: 12345,
          staged_path: null,
          proxy_path: null
        },
        '/subdir/track3.wav': {
          status: 'downloaded',
          deezer_id: 67890,
          staged_path: 'crateup-staging/track3.wav',
          proxy_path: null
        }
      }
    };
    fs.writeFileSync(initialLedgerPath, JSON.stringify(initialLedger, null, 2), 'utf8');

    const mergedLedger = initLedger(testRoot, 'mp3');
    expect(mergedLedger.files['/track1.mp3'].status).toBe('pending');
    expect(mergedLedger.files['/track2.FLAC'].status).toBe('pending');
    expect(mergedLedger.files['/subdir/track3.wav'].status).toBe('downloaded');
  });

  test('scanFileList processes explicit file list and derives relative paths correctly', () => {
    const filePaths = [
      path.join(testRoot, 'track1.mp3'),
      path.join(testRoot, 'subdir', 'track3.wav')
    ];
    
    const ledger = scanFileList(filePaths, testRoot);
    expect(ledger.session_id).toBeDefined();
    expect(ledger.root_path).toBe(testRoot);
    expect(Object.keys(ledger.files)).toHaveLength(2);
    expect(ledger.files['/track1.mp3']).toBeDefined();
    expect(ledger.files['/subdir/track3.wav']).toBeDefined();
    expect(ledger.files['/track1.mp3'].status).toBe('pending');
    expect(ledger.files['/track1.mp3'].original_abs_path).toBe(filePaths[0]);
    expect(ledger.files['/subdir/track3.wav'].original_abs_path).toBe(filePaths[1]);
  });

  test('getRelativePath matches node path.relative behavior', () => {
    function getRelativePath(from, to) {
      const fromParts = from.replace(/\\/g, '/').split('/').filter(Boolean);
      const toParts = to.replace(/\\/g, '/').split('/').filter(Boolean);
      
      let commonLength = 0;
      while (
        commonLength < fromParts.length &&
        commonLength < toParts.length &&
        fromParts[commonLength] === toParts[commonLength]
      ) {
        commonLength++;
      }
      
      const upCount = fromParts.length - commonLength;
      const upParts = Array(upCount).fill('..');
      const downParts = toParts.slice(commonLength);
      
      let rel = upParts.concat(downParts).join('/');
      if (!rel.startsWith('/')) {
        rel = '/' + rel;
      }
      return rel;
    }

    const testFrom = path.join(testRoot, 'sessions', 'playlist_123');
    const testTo = path.join(testRoot, 'Music', 'some_folder', 'track.mp3');

    let expectedRel = path.relative(testFrom, testTo);
    expectedRel = expectedRel.split(path.sep).join('/');
    if (!expectedRel.startsWith('/')) {
      expectedRel = '/' + expectedRel;
    }

    const actualRel = getRelativePath(testFrom, testTo);
    expect(actualRel).toBe(expectedRel);
  });

  test('shouldSkipDeezerMax handles quality skip rules correctly', () => {
    const { shouldSkipDeezerMax } = require('../node-sidecar/pipeline');

    // 1. Lossless target (FLAC): lossless original from Deezer -> SKIP
    expect(shouldSkipDeezerMax('/path/track.flac', 'flac', {
      deezer_origin: true,
      original_bitrate: 1411
    })).toBe(true);

    // 2. Lossless target (FLAC): lossy original from Deezer -> DO NOT SKIP
    expect(shouldSkipDeezerMax('/path/track.mp3', 'flac', {
      deezer_origin: true,
      original_bitrate: 320
    })).toBe(false);

    // 3. Lossy target (MP3): lossless original from Deezer -> SKIP (higher quality)
    expect(shouldSkipDeezerMax('/path/track.flac', 'mp3', {
      deezer_origin: true,
      original_bitrate: 1411
    })).toBe(true);

    // 4. Lossy target (MP3): 320kbps MP3 from Deezer -> SKIP (matches target quality)
    expect(shouldSkipDeezerMax('/path/track.mp3', 'mp3', {
      deezer_origin: true,
      original_bitrate: 320
    })).toBe(true);

    // 5. Lossy target (MP3): 192kbps MP3 from Deezer -> DO NOT SKIP (needs upgrade)
    expect(shouldSkipDeezerMax('/path/track.mp3', 'mp3', {
      deezer_origin: true,
      original_bitrate: 192
    })).toBe(false);

    // 6. Non-Deezer file: FLAC -> DO NOT SKIP (needs checking/identification)
    expect(shouldSkipDeezerMax('/path/track.flac', 'flac', {
      deezer_origin: false,
      original_bitrate: 1411
    })).toBe(false);
  });

  test('getFileDetails correctly identifies Deezer retail source using BARCODE and TSRC/ISRC', () => {
    const { getFileDetails } = require('../node-sidecar/scanner');
    const child_process = require('child_process');
    
    const originalExec = child_process.execSync;
    const originalExecFile = child_process.execFileSync;
    
    const mockData1 = JSON.stringify({
      streams: [{ codec_type: 'audio', bit_rate: '320000' }],
      format: {
        tags: {
          BARCODE: '1234567890',
          TSRC: 'USRC17607839'
        }
      }
    });
    child_process.execSync = jest.fn().mockReturnValue(mockData1);
    child_process.execFileSync = jest.fn().mockReturnValue(mockData1);
    
    const details = getFileDetails('mock-file.mp3');
    expect(details.bitrate).toBe(320);
    expect(details.deezerOrigin).toBe(true);
    
    const mockData2 = JSON.stringify({
      streams: [{ codec_type: 'audio', bit_rate: '320000' }],
      format: {
        tags: {
          BARCODE: '1234567890'
        }
      }
    });
    child_process.execSync = jest.fn().mockReturnValue(mockData2);
    child_process.execFileSync = jest.fn().mockReturnValue(mockData2);
    
    const detailsNoIsrc = getFileDetails('mock-file.mp3');
    expect(detailsNoIsrc.deezerOrigin).toBe(false);

    // Restore original exec functions
    child_process.execSync = originalExec;
    child_process.execFileSync = originalExecFile;
  });
});
