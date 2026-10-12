const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOD_URL = `file://${path.join(ROOT, 'ui', 'out', 'cleaner', 'settings.js')}`;

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

const s = await freshSettings('c1');
assert(s.DEFAULT_MODIFIERS.fileMode === 'copy', 'default file mode');
assert(s.DEFAULT_MODIFIERS.dedupDepth === 'standard', 'default dedup');
const m = s.loadCleanerModifiers();
assert(m.crossFormat === 'smart' && m.renamingRule === 'preserve', 'load defaults');
assert(s.loadCleanerStrategy() === null, 'no strategy initially');
const paths = s.loadCleanerPaths();
assert(paths.xmlPath === '' && paths.destPath === '', 'empty paths initially');

// round-trip
s.saveCleanerModifiers({ fileMode: 'move', crossFormat: 'strict', dedupDepth: 'fuzzy', renamingRule: 'clean' });
const back = s.loadCleanerModifiers();
assert(back.fileMode === 'move' && back.dedupDepth === 'fuzzy', 'modifiers round-trip');
s.saveCleanerStrategy('db');
assert(s.loadCleanerStrategy() === 'db', 'strategy round-trip');
s.saveCleanerPaths({ xmlPath: '/x.xml', destPath: '/d' });
assert(s.loadCleanerPaths().xmlPath === '/x.xml', 'paths round-trip');

// validation: garbage falls back, keeps legacy keys
const bad = await freshSettings('c2', {
  rebuilder_op_mode: 'teleport',
  rebuilder_cross_format: 'smart',
  rebuilder_dedup_depth: 'tier9',
  rebuilder_rename_rules: 'clean',
  rebuilder_strategy: 'tape',
});
const fixed = bad.loadCleanerModifiers();
assert(fixed.fileMode === 'copy', 'bad file mode falls back');
assert(fixed.crossFormat === 'smart', 'good value kept');
assert(fixed.dedupDepth === 'standard', 'bad dedup falls back');
assert(bad.loadCleanerStrategy() === null, 'bad strategy is null');

// cleanup summary
const sum = s.summarizeCleanup([
  { path: '/a.mp3', status: 'deleted' },
  { path: '/b.mp3', status: 'deleted' },
  { path: '/c.mp3', status: 'skipped_in_live_db' },
  { path: '/d.mp3', status: 'skipped_not_exists' },
  { path: '/e.mp3', status: 'delete_failed: permission denied' },
]);
assert(sum.deleted === 2 && sum.kept === 2 && sum.failed === 1, 'cleanup counts');
assert(s.cleanupReportLine(sum) === '2 deleted · 2 kept · 1 failed', 'report line');
assert(s.cleanupReportLine({ deleted: 0, kept: 0, failed: 0 }) === '0 deleted', 'empty report');

// run records: save / load / validation / remove
const run = {
  strategy: 'db',
  xmlPath: '',
  destPath: '/dest',
  opts: { fileMode: 'copy', crossFormat: 'smart', dedupDepth: 'standard', renamingRule: 'preserve' },
  result: { success: true, healthy_count: 10, missing_count: 1, duplicate_count: 2, missing_list: [], backup_filename: 'master.db.backup_x' },
};
assert(s.loadCleanerRun('nope') === null, 'missing run is null');
s.saveCleanerRun('s1', run);
assert(JSON.stringify(s.loadCleanerRun('s1')) === JSON.stringify(run), 'run round-trip');
s.removeCleanerRun('s1');
assert(s.loadCleanerRun('s1') === null, 'run removed');

console.log('CLEANER_SETTINGS_OK');
`;

describe('Cleaner settings (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('defaults, validation, persistence, cleanup summary', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, MOD_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('CLEANER_SETTINGS_OK');
  });
});
