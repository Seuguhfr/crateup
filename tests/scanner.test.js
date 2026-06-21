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
      original_bitrate: null
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
      original_bitrate: null
    });

    expect(mergedLedger.files['/track2.FLAC']).toEqual({
      status: 'pending',
      deezer_id: null,
      staged_path: null,
      proxy_path: null,
      original_bitrate: null
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
});
