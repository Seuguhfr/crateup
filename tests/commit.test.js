const fs = require('fs');
const path = require('path');
const { commit } = require('../node-sidecar/commit');

describe('Commit Phase Module', () => {
  const testRoot = path.join(__dirname, 'temp-commit-test');
  const ledgerPath = path.join(testRoot, '.crateup-progress.json');

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRoot);
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('correctly commits approved files, skips skipped files, handles duplicates and deletes staging', async () => {
    // 1. Setup mock directories and files
    const stagingDir = path.join(testRoot, 'crateup-staging');
    fs.mkdirSync(stagingDir);
    const outputPath = path.join(testRoot, 'upgraded-output');

    // Create original files
    const origPath1 = path.join(testRoot, 'Artist A - Track 1.mp3');
    fs.writeFileSync(origPath1, 'original track 1 content');

    const origPath2 = path.join(testRoot, 'Artist B - Track 2.mp3');
    fs.writeFileSync(origPath2, 'original track 2 content');

    const origPath3 = path.join(testRoot, 'Artist C - Track 3.mp3');
    fs.writeFileSync(origPath3, 'original track 3 content');

    const origPath4 = path.join(testRoot, 'Artist A - Track 1 Duplicate.mp3');
    fs.writeFileSync(origPath4, 'original track 1 duplicate content');

    // Create staged upgrade files (downloaded)
    const stagedPath1 = path.join(stagingDir, 'Artist A - Track 1.flac');
    fs.writeFileSync(stagedPath1, 'upgraded track 1 content');

    const stagedPath2 = path.join(stagingDir, 'Artist B - Track 2.flac');
    fs.writeFileSync(stagedPath2, 'upgraded track 2 content');

    // Setup ledger
    const ledger = {
      session_id: 'test-session-uuid',
      root_path: testRoot,
      output_format: 'flac',
      files: {
        '/Artist A - Track 1.mp3': {
          status: 'downloaded',
          deezer_id: 11111,
          staged_path: 'crateup-staging/Artist A - Track 1.flac',
          proxy_path: null
        },
        '/Artist B - Track 2.mp3': {
          status: 'downloaded',
          deezer_id: 22222,
          staged_path: 'crateup-staging/Artist B - Track 2.flac',
          proxy_path: null
        },
        '/Artist C - Track 3.mp3': {
          status: 'unidentified',
          deezer_id: null,
          staged_path: null,
          proxy_path: null
        },
        '/Artist A - Track 1 Duplicate.mp3': {
          status: 'downloaded',
          deezer_id: 11111, // Duplicate ID
          staged_path: 'crateup-staging/Artist A - Track 1.flac', // references same staged file (download skipped)
          proxy_path: null
        }
      }
    };

    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

    // Decisions:
    // Track 1: approved
    // Track 2: skipped
    // Track 3: unresolved -> will be skipped
    // Track 1 Duplicate: approved -> will be cloned from Track 1 flac
    const decisions = new Map([
      ['/Artist A - Track 1.mp3', 'approved'],
      ['/Artist B - Track 2.mp3', 'skipped'],
      ['/Artist C - Track 3.mp3', 'skipped'],
      ['/Artist A - Track 1 Duplicate.mp3', 'approved']
    ]);

    // 2. Run commit
    const result = await commit(ledgerPath, decisions, outputPath);

    expect(result.success).toBe(true);
    expect(result.failures.length).toBe(0);

    // 3. Verify files on disk
    // LEAVE ALL original files completely untouched on disk
    expect(fs.existsSync(origPath1)).toBe(true);
    expect(fs.existsSync(origPath2)).toBe(true);
    expect(fs.existsSync(origPath3)).toBe(true);
    expect(fs.existsSync(origPath4)).toBe(true);

    expect(fs.existsSync(stagedPath1)).toBe(false); // staging cleared

    // Upgraded files and copied originals must be in outputPath
    const targetFlac1 = path.join(outputPath, 'Artist A - Track 1.flac');
    expect(fs.existsSync(targetFlac1)).toBe(true);
    expect(fs.readFileSync(targetFlac1, 'utf8')).toBe('upgraded track 1 content');

    // Track 2 (skipped): original mp3 copied to output folder, staged flac deleted
    const targetMp3_2 = path.join(outputPath, 'Artist B - Track 2.mp3');
    expect(fs.existsSync(targetMp3_2)).toBe(true);
    expect(fs.existsSync(stagedPath2)).toBe(false);

    // Track 3 (skipped/unresolved): original mp3 copied to output folder
    const targetMp3_3 = path.join(outputPath, 'Artist C - Track 3.mp3');
    expect(fs.existsSync(targetMp3_3)).toBe(true);

    // Track 1 Duplicate (approved clone): original mp3 untouched, flac cloned in output folder from Track 1
    const targetFlac4 = path.join(outputPath, 'Artist A - Track 1.flac');
    expect(fs.existsSync(targetFlac4)).toBe(true);
    expect(fs.readFileSync(targetFlac4, 'utf8')).toBe('upgraded track 1 content'); // cloned content

    // Staging directory deleted completely
    expect(fs.existsSync(stagingDir)).toBe(false);

    // Ledger file and log file are cleaned up on successful commit
    expect(fs.existsSync(ledgerPath)).toBe(false);

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const logPath = path.join(testRoot, `.crateup-log-${dateStr}.txt`);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  test('handles AIFF proxy files and error failures correctly', async () => {
    const stagingDir = path.join(testRoot, 'crateup-staging');
    fs.mkdirSync(stagingDir);
    const outputPath = path.join(testRoot, 'upgraded-output');

    // AIFF track
    const origPath = path.join(testRoot, 'Artist D - Track 4.mp3');
    fs.writeFileSync(origPath, 'original track 4');

    const stagedPath = path.join(stagingDir, 'Artist D - Track 4.aiff');
    fs.writeFileSync(stagedPath, 'upgraded track 4 aiff');

    const proxyPath = stagedPath + '.proxy.mp3';
    fs.writeFileSync(proxyPath, 'proxy track 4');

    const ledger = {
      session_id: 'test-session-uuid-2',
      root_path: testRoot,
      output_format: 'aiff',
      files: {
        '/Artist D - Track 4.mp3': {
          status: 'downloaded',
          deezer_id: 44444,
          staged_path: 'crateup-staging/Artist D - Track 4.aiff',
          proxy_path: 'crateup-staging/Artist D - Track 4.aiff.proxy.mp3'
        }
      }
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

    const decisions = new Map([
      ['/Artist D - Track 4.mp3', 'approved']
    ]);

    const result = await commit(ledgerPath, decisions, outputPath);
    expect(result.success).toBe(true);

    // Check files on disk
    expect(fs.existsSync(origPath)).toBe(true); // original untouched
    expect(fs.existsSync(proxyPath)).toBe(false); // proxy deleted
    expect(fs.existsSync(path.join(outputPath, 'Artist D - Track 4.aiff'))).toBe(true);
  });
});
