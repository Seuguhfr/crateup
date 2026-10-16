const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UTILS_URL = `file://${path.join(ROOT, 'ui', 'out', 'upgrader', 'utils.js')}`;

const SCRIPT = `
const u = await import(process.argv[1]);
const assert = (cond, name) => {
  if (!cond) { console.error('FAIL: ' + name); process.exit(1); }
  console.log('ok: ' + name);
};

// joinPath
assert(u.joinPath('/a/b', 'c.json') === '/a/b/c.json', 'joinPath basic');
assert(u.joinPath('/a/b/', '/c.json') === '/a/b/c.json', 'joinPath slashes');
assert(u.joinPath('', 'c.json') === 'c.json', 'joinPath empty base');

// getRelativePath (legacy semantics: leading slash)
assert(u.getRelativePath('/a/b', '/a/b/c.mp3') === '/c.mp3', 'getRelativePath child');
assert(u.getRelativePath('/a/b/c', '/a/b/d/e.mp3') === '/../d/e.mp3', 'getRelativePath sibling');
assert(u.getRelativePath('/a/b', '/a/b') === '/', 'getRelativePath identical');

// longestCommonAncestor
assert(
  u.longestCommonAncestor(['/m/a/1.mp3', '/m/a/2.mp3']) === '/m/a',
  'longestCommonAncestor shared dir'
);
assert(u.longestCommonAncestor(['/m/a/1.mp3']) === '/m/a', 'longestCommonAncestor single');
assert(u.longestCommonAncestor([]) === '', 'longestCommonAncestor empty');

// parseProgressLine
const totals = u.parseProgressLine('[x] Found 3 pending files out of 10 total files');
assert(totals.kind === 'totals' && totals.pending === 3 && totals.total === 10, 'parseProgressLine totals');
assert(u.parseProgressLine('Successfully staged replacement for x').kind === 'step', 'parseProgressLine staged');
assert(u.parseProgressLine('Fingerprinting failed for x').kind === 'step', 'parseProgressLine failed');
assert(u.parseProgressLine('Track identified but not found on Deezer').kind === 'step', 'parseProgressLine not_on_deezer');
assert(u.parseProgressLine('Marking as not_on_deezer').kind === 'step', 'parseProgressLine marking');
assert(u.parseProgressLine('some random log line').kind === 'other', 'parseProgressLine other');

// countLedger
const ledger = {
  root_path: '/m', output_format: 'flac',
  files: {
    '/a.mp3': { status: 'downloaded', decision: 'pending' },
    '/b.mp3': { status: 'unidentified' },
    '/c.mp3': { status: 'not_on_deezer', decision: 'skipped' },
    '/d.mp3': { status: 'download_failed' },
    '/e.mp3': { status: 'pending' },
    '/f.mp3': { status: 'committed', decision: 'approved' },
  },
};
const c = u.countLedger(ledger);
assert(c.total === 6, 'countLedger total');
assert(c.downloaded === 1 && c.unidentified === 1, 'countLedger resolved');
assert(c.not_on_deezer === 1 && c.download_failed === 1, 'countLedger failures');
assert(c.pending === 1 && c.committed === 1, 'countLedger pending/committed');
assert(c.decided === 2, 'countLedger decided');

// ledger names + session helpers
assert(u.ledgerNameForHost('1420') === '.crateup-progress.json', 'ledgerName dev');
assert(u.ledgerNameForHost('') === '.crateup-progress.json', 'ledgerName prod');
assert(u.sanitizeSessionName('My Mix! (2024)') === 'My_Mix___2024_', 'sanitizeSessionName');
assert(/^\\d{8}_\\d{6}$/.test(u.sessionTimestamp(new Date(2024, 0, 2, 3, 4, 5))), 'sessionTimestamp shape');

// extractDeezerTrackId
assert(u.extractDeezerTrackId('882920') === 882920, 'extractDeezerTrackId numeric string');
assert(u.extractDeezerTrackId('  882920  ') === 882920, 'extractDeezerTrackId trimmed');
assert(u.extractDeezerTrackId('https://www.deezer.com/track/882920') === 882920, 'extractDeezerTrackId standard url');
assert(u.extractDeezerTrackId('https://www.deezer.com/en/track/882920') === 882920, 'extractDeezerTrackId localized url');
assert(u.extractDeezerTrackId('https://www.deezer.com/fr/track/882920?utm_source=deezer') === 882920, 'extractDeezerTrackId query params');
assert(u.extractDeezerTrackId('https://www.deezer.com/album/123/track/882920') === 882920, 'extractDeezerTrackId album track url');
assert(u.extractDeezerTrackId('track:882920') === 882920, 'extractDeezerTrackId track uri');
assert(u.extractDeezerTrackId('https://link.deezer.com/?dest=https%3A%2F%2Fwww.deezer.com%2Ftrack%2F2415350') === 2415350, 'extractDeezerTrackId encoded dest');
assert(u.extractDeezerTrackId('invalid') === null, 'extractDeezerTrackId invalid text');
assert(u.extractDeezerTrackId('') === null, 'extractDeezerTrackId empty');

// isPotentialDeezerUrl
assert(u.isPotentialDeezerUrl('https://link.deezer.com/s/34FS7yPyRLun6sg8eglS9') === true, 'isPotentialDeezerUrl short link');
assert(u.isPotentialDeezerUrl('https://deezer.page.link/abc123xyz') === true, 'isPotentialDeezerUrl page link');
assert(u.isPotentialDeezerUrl('https://www.deezer.com/track/123') === true, 'isPotentialDeezerUrl web url');
assert(u.isPotentialDeezerUrl('12345') === false, 'isPotentialDeezerUrl numeric id');
assert(u.isPotentialDeezerUrl('') === false, 'isPotentialDeezerUrl empty');

// getMissedTracks
const missed = u.getMissedTracks({
  files: {
    '/ok.mp3': { status: 'downloaded', artist: 'A', title: 'T' },
    '/unid.mp3': { status: 'unidentified', artist: 'Unknown', title: 'Track 2' },
    '/notdeezer.mp3': { status: 'not_on_deezer', artist: 'Artist 3', title: 'Track 3' },
    '/failed.mp3': { status: 'download_failed', artist: 'Artist 4', title: 'Track 4' },
    '/pending.mp3': { status: 'pending' }
  }
});
assert(missed.length === 3, 'getMissedTracks count');
assert(missed[0].status === 'Unidentified by Shazam', 'getMissedTracks unidentified status');
assert(missed[1].status === 'Not on Deezer', 'getMissedTracks not on deezer status');
assert(missed[2].status === 'Download Failed', 'getMissedTracks failed status');

console.log('UPGRADER_UTILS_OK');
`;

describe('Upgrader utils (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('pure helpers behave per legacy semantics', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, UTILS_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('UPGRADER_UTILS_OK');
  });
});
