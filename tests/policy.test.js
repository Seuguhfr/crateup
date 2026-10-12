const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const POLICY_URL = `file://${path.join(ROOT, 'ui', 'out', 'policy.js')}`;

const SCRIPT = `
const freshPolicy = async (tag, seed) => {
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

const p = await freshPolicy('p1');
assert(p.DEFAULT_PREFS.match.acousticThreshold === 0.9, 'default threshold');
assert(p.DEFAULT_PREFS.outputFormat === 'flac', 'default format');
assert(p.DEFAULT_PREFS.libraryRoot === null, 'default root');
assert(Object.keys(p.DEFAULT_PREFS.match).length === 1, 'match holds only threshold');

// fresh load with nothing stored → defaults
const loaded = p.loadPrefs();
assert(loaded.match.acousticThreshold === 0.9 && loaded.outputFormat === 'flac', 'load defaults');

// save round-trip
p.savePrefs({ outputFormat: 'mp3', libraryRoot: '/m', match: { acousticThreshold: 0.95 } });
const back = p.loadPrefs();
assert(back.outputFormat === 'mp3' && back.libraryRoot === '/m', 'round-trip fields');
assert(back.match.acousticThreshold === 0.95, 'round-trip threshold');
assert(p.thresholdLabel(0.95) === '≥95%', 'threshold label');
assert(p.thresholdLabel(0.9) === '≥90%', 'threshold label default');

// validation: garbage in → defaults out, extras ignored
const bad = await freshPolicy('p2', {
  crateup_prefs_v1: JSON.stringify({ outputFormat: '', libraryRoot: 42, match: { acousticThreshold: 5, defaultDedupDepth: 'tier3', bitIdenticalFirst: false } }),
});
const fixed = bad.loadPrefs();
assert(fixed.outputFormat === 'flac', 'bad format falls back');
assert(fixed.libraryRoot === null, 'bad root falls back');
assert(fixed.match.acousticThreshold === 0.9, 'range threshold falls back');

const corrupt = await freshPolicy('p3', { crateup_prefs_v1: 'not-json{{{' });
assert(corrupt.loadPrefs().outputFormat === 'flac', 'corrupt falls back');

// reset restores + persists defaults
const r = await freshPolicy('p4');
r.savePrefs({ outputFormat: 'wav', libraryRoot: '/x', match: { acousticThreshold: 0.8 } });
const reset = r.resetPrefs();
assert(reset.outputFormat === 'flac' && reset.match.acousticThreshold === 0.9, 'reset values');
assert(r.loadPrefs().outputFormat === 'flac', 'reset persists');

console.log('POLICY_OK');
`;

describe('Match policy prefs (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('defaults, validation, persistence', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, POLICY_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('POLICY_OK');
  });
});
