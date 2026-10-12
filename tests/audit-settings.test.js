const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOD_URL = `file://${path.join(ROOT, 'ui', 'out', 'audit', 'settings.js')}`;

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

const s = await freshSettings('a1');

// summary counts
const sum = s.summarizeAudit({
  audio_file_count: 100,
  referenced_count: 90,
  leftovers: [
    { path: '/a.mp3', size: 10, kind: 'duplicate', dupe_of: '/b.mp3' },
    { path: '/c.mp3', size: 20, kind: 'orphan', dupe_of: null },
    { path: '/d.mp3', size: 30, kind: 'weird', dupe_of: null },
  ],
  stray_groups: [{ folder: '/dl', files: ['/dl/x.mp3', '/dl/y.mp3'] }],
  outside_db: ['/ext/z.mp3'],
  missing_db: [],
  bytes_wasted: 60,
});
assert(sum.audioFiles === 100 && sum.referenced === 90, 'totals');
assert(sum.leftovers === 3 && sum.dupes === 1 && sum.orphans === 2, 'leftover split (unknown kind counts as orphan)');
assert(sum.twinFiles === 2 && sum.twinFolders === 1, 'twins');
assert(sum.outside === 1 && sum.missing === 0, 'info lists');
assert(sum.wastedBytes === 60, 'wasted bytes');

// selection toggle
let sel = s.toggleSelected([], '/a.mp3');
assert(sel.length === 1, 'select');
sel = s.toggleSelected(sel, '/a.mp3');
assert(sel.length === 0, 'deselect');

// parent folders
const parents = s.parentFolders(['/a/b/c.mp3', '/a/b/d.mp3', '/x/y.mp3', 'noroot']);
assert(JSON.stringify(parents) === JSON.stringify(['/a/b', '/x']), 'unique sorted parents, bare names dropped');

// search roots persistence
assert(JSON.stringify(s.loadSearchRoots()) === '[]', 'roots empty initially');
s.saveSearchRoots(['/dl', '/staging']);
assert(JSON.stringify(s.loadSearchRoots()) === JSON.stringify(['/dl', '/staging']), 'roots round-trip');

// run records
const run = {
  libraryRoot: '/lib',
  searchRoots: ['/dl'],
  report: {
    library_root: '/lib', audio_file_count: 2, referenced_count: 1,
    leftovers: [], stray_groups: [],
    twins_found_extra: 0, twins_total_extra: 0,
    outside_db: [], missing_db: [], skipped_dirs: [], bytes_wasted: 0,
  },
};
assert(s.loadAuditRun('nope') === null, 'missing run null');
s.saveAuditRun('a9', run);
assert(JSON.stringify(s.loadAuditRun('a9')) === JSON.stringify(run), 'run round-trip');
s.removeAuditRun('a9');
assert(s.loadAuditRun('a9') === null, 'run removed');

console.log('AUDIT_SETTINGS_OK');
`;

describe('Audit settings (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('summary, selection, persistence, run records', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, MOD_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('AUDIT_SETTINGS_OK');
  });
});
