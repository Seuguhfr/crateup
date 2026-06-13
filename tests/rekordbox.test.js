const fs = require('fs');
const path = require('path');
const { updateXML } = require('../node-sidecar/rekordbox');

describe('Rekordbox XML Integration Module', () => {
  const testRoot = path.join(__dirname, 'temp-rekordbox-test');
  const xmlPath = path.join(testRoot, 'rekordbox_export.xml');

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

  test('correctly matches and rewrites Locations using direct and fuzzy matching', async () => {
    // 1. Create a mock Rekordbox XML file
    // Nodes:
    // - Track 1 (Direct match): original Location points to "Artist A - Track 1.mp3".
    // - Track 2 (Fuzzy match): Location is old/wrong, but Name, Artist, and TotalTime match "Artist B - Track 2.flac" (we mock TotalTime="2" to match duration=0 of dummy file).
    // - Track 3 (Unmatched): Location is wrong, and no matching Name/Artist.
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="6.0.0" Company="Pioneer DJ" />
  <COLLECTION Entries="3">
    <TRACK TrackID="101" Name="Track 1" Artist="Artist A" TotalTime="120" Location="file://localhost${testRoot.replace(/\\/g, '/')}/Artist%20A%20-%20Track%201.mp3" />
    <TRACK TrackID="102" Name="Track 2" Artist="Artist B" TotalTime="2" Location="file://localhost/Users/old_user/Music/old_path.mp3" />
    <TRACK TrackID="103" Name="Mystery Track" Artist="Artist C" TotalTime="300" Location="file://localhost/Users/old_user/Music/not_found.mp3" />
  </COLLECTION>
</DJ_PLAYLISTS>
`;
    fs.writeFileSync(xmlPath, mockXml, 'utf8');

    // 2. Setup mock committed files in ledger (and on disk)
    // We write the new upgraded files (flac) so getFileMetadata can parse them
    const newFlacPath1 = path.join(testRoot, 'Artist A - Track 1.flac');
    fs.writeFileSync(newFlacPath1, 'dummy flac 1');

    const newFlacPath2 = path.join(testRoot, 'Artist B - Track 2.flac');
    fs.writeFileSync(newFlacPath2, 'dummy flac 2');

    const ledger = {
      session_id: 'test-session-uuid-xml',
      output_format: 'flac',
      files: {
        '/Artist A - Track 1.mp3': {
          status: 'committed',
          deezer_id: 123,
          staged_path: 'crateup-staging/Artist A - Track 1.flac',
          proxy_path: null
        },
        '/Artist B - Track 2.mp3': {
          status: 'committed',
          deezer_id: 456,
          staged_path: 'crateup-staging/Artist B - Track 2.flac',
          proxy_path: null
        },
        '/Artist C - Track 3.mp3': {
          status: 'skipped', // Skipped, should NOT be matched/upgraded
          deezer_id: 789,
          staged_path: null,
          proxy_path: null
        }
      }
    };

    // 3. Run updateXML
    const result = await updateXML(xmlPath, ledger, testRoot);

    // 4. Verify results object
    expect(result.matched).toBe(2); // Track 1 (direct) + Track 2 (fuzzy)
    expect(result.unmatched).toBe(0); // Track 3 skipped, so no unmatched committed tracks
    expect(result.rewritten).toBe(2);

    // 5. Verify upgraded XML content
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const outputXmlPath = path.join(testRoot, `rekordbox_upgraded_${dateStr}.xml`);
    
    expect(fs.existsSync(outputXmlPath)).toBe(true);
    const upgradedXml = fs.readFileSync(outputXmlPath, 'utf8');

    // Track 1 should be rewritten to new flac path, URL-encoded
    const expectedLocation1 = `file://localhost${testRoot.replace(/\\/g, '/')}/Artist%20A%20-%20Track%201.flac`;
    expect(upgradedXml).toContain(`Location="${expectedLocation1}"`);

    // Track 2 should be rewritten via fuzzy match to new flac path, URL-encoded
    const expectedLocation2 = `file://localhost${testRoot.replace(/\\/g, '/')}/Artist%20B%20-%20Track%202.flac`;
    expect(upgradedXml).toContain(`Location="${expectedLocation2}"`);

    // Track 3 should remain untouched
    expect(upgradedXml).toContain('Location="file://localhost/Users/old_user/Music/not_found.mp3"');
  });

  test('logs unmatched tracks in session log', async () => {
    // XML has a track node that doesn't match the committed track at all
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="1">
    <TRACK TrackID="999" Name="Some Other Name" Artist="Some Other Artist" TotalTime="999" Location="file://localhost/Users/old_user/Music/not_found.mp3" />
  </COLLECTION>
</DJ_PLAYLISTS>
`;
    fs.writeFileSync(xmlPath, mockXml, 'utf8');

    // Committed track exists but has completely different details
    const committedFlacPath = path.join(testRoot, 'Artist X - Track X.flac');
    fs.writeFileSync(committedFlacPath, 'dummy flac x');

    const ledger = {
      session_id: 'test-session-uuid-xml-unmatched',
      output_format: 'flac',
      files: {
        '/Artist X - Track X.mp3': {
          status: 'committed',
          deezer_id: 99999,
          staged_path: 'crateup-staging/Artist X - Track X.flac',
          proxy_path: null
        }
      }
    };

    const result = await updateXML(xmlPath, ledger, testRoot);
    expect(result.matched).toBe(0);
    expect(result.unmatched).toBe(1);
    expect(result.rewritten).toBe(0);

    // Check unmatched log file
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const logPath = path.join(testRoot, `.crateup-log-${dateStr}.txt`);
    expect(fs.existsSync(logPath)).toBe(true);
    const logContent = fs.readFileSync(logPath, 'utf8');
    expect(logContent).toContain('[UNMATCHED XML]');
    expect(logContent).toContain('Artist X - Track X  →  no Rekordbox node found');
  });
});
