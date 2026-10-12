const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_URL = `file://${path.join(ROOT, 'ui', 'out', 'store.js')}`;

const SCRIPT = `
const freshStore = async (tag, seed) => {
  const mem = new Map(Object.entries(seed || {}));
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.document = { documentElement: {} };
  const mod = await import(process.argv[1] + '?t=' + tag);
  return { mod, mem };
};
const assert = (cond, name) => {
  if (!cond) { console.error('FAIL: ' + name); process.exit(1); }
  console.log('ok: ' + name);
};

// ---- phase 1: fresh store, identity, lifecycle ----
{
  const { mod: s, mem } = await freshStore('p1');
  assert(s.listSessions().length === 0, 'fresh list empty');
  assert(s.getSession() === null, 'fresh current null');
  assert(s.getCurrentId() === null, 'fresh currentId null');

  const a = s.openSession({ tool: 'upgrader', rootPath: '/m/ug-test' });
  assert(typeof a.id === 'string' && a.id.length > 0, 'open assigns id');
  assert(a.tool === 'upgrader' && a.name === 'ug-test', 'open derives name');
  assert(a.status === 'active' && a.hasFollowUps === false, 'open defaults');
  assert(s.getCurrentId() === a.id, 'open makes current');
  assert(s.listSessions().length === 1, 'list has one');

  const a2 = s.openSession({ tool: 'upgrader', rootPath: '/m/ug-test' });
  assert(a2.id === a.id, 're-pick folder resumes');
  assert(s.listSessions().length === 1, 'no duplicate on resume');

  const b = s.openSession({ tool: 'cleaner', rootPath: '/m/ug-test' });
  assert(b.id !== a.id, 'same path other tool is separate');
  assert(s.listSessions().length === 2, 'list has two');

  const c1 = s.openSession({ tool: 'upgrader', rootPath: '/app/sessions/Mix_1', ledgerPath: '/app/sessions/Mix_1/.crateup-progress.json', isSessionDir: true, playlistName: 'Mix' });
  const c2 = s.openSession({ tool: 'upgrader', rootPath: '/app/sessions/Mix_1', ledgerPath: '/app/sessions/Mix_1/.crateup-progress.json', isSessionDir: true, playlistName: 'Mix' });
  assert(c1.id === c2.id && c1.name === 'Mix', 'session-dir identity resumes');

  assert(s.sourceKeyFor('upgrader', { rootPath: '/m/ug-test' }) === 'upgrader:/m/ug-test', 'sourceKey folder');
  assert(s.sourceKeyFor('upgrader', { rootPath: '/x', ledgerPath: '/x/p.json', isSessionDir: true }) === 'upgrader:/x/p.json', 'sourceKey session dir');
  assert(s.sessionBasename('/a/b/c/') === 'c', 'sessionBasename');

  s.updateSession(c1.id, { progressLabel: '1/2 reviewed' });
  assert(s.getSession().progressLabel === '1/2 reviewed', 'update progress');
  s.setSession({ outputFormat: 'flac' });
  assert(s.getSession().outputFormat === 'flac', 'setSession compat patches current');

  assert(s.enterSession(a.id) === true, 'enter switches');
  assert(s.getCurrentId() === a.id, 'current switched');
  assert(s.enterSession('nope') === false, 'enter unknown false');
  s.closeSession();
  assert(s.getSession() === null, 'close clears current');
  assert(s.listSessions().length === 3, 'close keeps list');
  s.setSession({ outputFormat: 'mp3' });
  assert(s.listSessions().every((x) => x.outputFormat !== 'mp3'), 'setSession no-op without current');

  s.enterSession(b.id);
  s.removeSession(a.id);
  assert(s.listSessions().length === 2, 'remove shrinks list');
  assert(s.getCurrentId() === b.id, 'remove other keeps current');
  s.clearSession();
  assert(s.getSession() === null, 'clearSession removes current');
  assert(s.listSessions().length === 1, 'clearSession shrinks list');

  const persisted = JSON.parse(mem.get('crateup_sessions_v1'));
  assert(Array.isArray(persisted.sessions) && persisted.sessions.length === 1, 'persisted list');
}

// ---- phase 2: rehydration across reload (same backing store) ----
{
  const { mod: s1 } = await freshStore('p2a');
  const a = s1.openSession({ tool: 'upgrader', rootPath: '/m/one' });
  s1.updateSession(a.id, { progressLabel: '2/2 reviewed' });
  const re = await import(process.argv[1] + '?t=p2b');
  assert(re.listSessions().length === 1, 'rehydrated list');
  assert(re.getSession() && re.getSession().progressLabel === '2/2 reviewed', 'rehydrated progress + current');
  assert(re.getCurrentId() === a.id, 'rehydrated current id');
}

// ---- phase 3: legacy migration ----
{
  const legacy = { rootPath: '/old/lib', playlistName: 'Old Mix', ledgerPath: '/old/lib/.crateup-progress.json', sourceKind: 'folder', isSessionDir: false, outputFormat: 'mp3', progressLabel: '1/3 reviewed' };
  const { mod: s, mem } = await freshStore('p3', { crateup_session: JSON.stringify(legacy) });
  const list = s.listSessions();
  assert(list.length === 1, 'migrated one session');
  assert(list[0].tool === 'upgrader' && list[0].name === 'Old Mix', 'migrated fields');
  assert(list[0].progressLabel === '1/3 reviewed', 'migrated progress');
  assert(s.getCurrentId() === list[0].id, 'migrated current');
  assert(mem.get('crateup_session') === undefined, 'legacy key removed');
}

console.log('SESSIONS_OK');
`;

describe('Session store (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('session list lifecycle, persistence, migration', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, STORE_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('SESSIONS_OK');
  });
});
