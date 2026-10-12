const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOD_URL = `file://${path.join(ROOT, 'ui', 'out', 'ingestion', 'settings.js')}`;

const SCRIPT = `
const freshSettings = async (tag, seed) => {
  const mem = new Map(Object.entries(seed || {}));
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  return await import(process.argv[1] + '?t=' + tag);
};
const assert = (cond, name) => {
  if (!cond) { console.error('FAIL: ' + name); process.exit(1); }
  console.log('ok: ' + name);
};

const s = await freshSettings('g1');

// track helpers
const t = s.trackFromPath('/Music/Artist - Title.flac', 1024 * 1024 * 54.2);
assert(t.name === 'Artist - Title.flac', 'basename');
assert(t.format === 'flac', 'format lowercased');
assert(t.size === '54.2 MB', 'size format');
assert(s.trackFromPath('/Music/noext', 0).size === '—', 'unknown size');
assert(s.formatBytes(500) === '500 B', 'bytes');
assert(s.formatBytes(2048) === '2.0 KB', 'kilobytes');

// add dedupes by path, preserves order
const a = { path: '/a.mp3', name: 'a.mp3', size: '1 MB', format: 'mp3' };
const b = { path: '/b.mp3', name: 'b.mp3', size: '2 MB', format: 'mp3' };
let staged = s.addStagedTracks([], [a, b, a]);
assert(staged.length === 2 && staged[0].path === '/a.mp3', 'add dedupes');
staged = s.removeStagedTrack(staged, '/a.mp3');
assert(staged.length === 1 && staged[0].path === '/b.mp3', 'remove');

// validation
assert(s.validateIngestInputs(0, '', '').ok === false, 'empty invalid');
assert(s.validateIngestInputs(2, 'Mix', '/d').ok === true, 'full valid');
assert(s.validateIngestInputs(1, '', '/d').reasons.length === 1, 'name missing');

// xml name
assert(s.defaultXmlName('Winter Club Cuts') === 'Winter_Club_Cuts_import.xml', 'slug');
assert(s.defaultXmlName('   ') === 'playlist_import.xml', 'blank fallback');

// staged from bare paths (session resume)
const resumed = s.stagedFromPaths(['/x/y.mp3']);
assert(resumed.length === 1 && resumed[0].name === 'y.mp3' && resumed[0].size === '—', 'resume tracks');

// staged paths persist (same store, as across repaint/navigation)
s.saveStagedPaths(['/a.mp3', '/b.mp3']);
assert(JSON.stringify(s.loadStagedPaths()) === JSON.stringify(['/a.mp3', '/b.mp3']), 'staged paths persist');
s.saveStagedPaths([]);
assert(s.loadStagedPaths().length === 0, 'staged paths clear');
const run = {
  playlistName: 'Mix', destPath: '/d', xmlSavePath: '/d/mix.xml',
  stagedFiles: ['/a.mp3'],
  opts: { fileMode: 'copy', crossFormat: 'smart', dedupDepth: 'standard', renamingRule: 'preserve' },
  result: { success: true, healthy_count: 1, missing_count: 0, duplicate_count: 0, missing_list: [], backup_filename: null },
};
assert(s.loadIngestionRun('nope') === null, 'missing run null');
s.saveIngestionRun('g9', run);
assert(JSON.stringify(s.loadIngestionRun('g9')) === JSON.stringify(run), 'run round-trip');
s.removeIngestionRun('g9');
assert(s.loadIngestionRun('g9') === null, 'run removed');

// library check pref (default on)
assert(s.loadLibraryCheck() === true, 'library check defaults on');
s.saveLibraryCheck(false);
assert(s.loadLibraryCheck() === false, 'library check round-trip');

console.log('INGESTION_SETTINGS_OK');
`;

describe('Ingestion settings (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('tracks, validation, persistence, run records', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, MOD_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('INGESTION_SETTINGS_OK');
  });
});
