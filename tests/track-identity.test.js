const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const IDENTITY_URL = `file://${path.join(ROOT, 'ui', 'out', 'track-identity.js')}`;

const SCRIPT = `
const t = await import(process.argv[1]);
const assert = (cond, name) => {
  if (!cond) { console.error('FAIL: ' + name); process.exit(1); }
  console.log('ok: ' + name);
};

// identityFromPath: Artist - Title convention
const m1 = t.identityFromPath('/m/Daft Punk - One More Time.mp3');
assert(m1.artist === 'Daft Punk' && m1.title === 'One More Time', 'parse artist-title');
assert(m1.name === 'Daft Punk - One More Time.mp3', 'display name');
const m2 = t.identityFromPath('/m/Track01.mp3');
assert(m2.artist === null && m2.title === null, 'no meta fallback');
assert(m2.name === 'Track01.mp3', 'fallback name');
const m3 = t.identityFromPath('/m/A - B - C.flac');
assert(m3.artist === 'A' && m3.title === 'B - C', 'first separator wins');

// identityKey: same recording, different encodings share a key
const k1 = t.identityKey(t.identityFromPath('/a/Daft Punk - One More Time.mp3'));
const k2 = t.identityKey(t.identityFromPath('/b/daft punk - one more time.flac'));
assert(k1 === k2, 'key case-insensitive across encodings');
const k3 = t.identityKey(t.identityFromPath('/a/Other - Song.mp3'));
assert(k3 !== k1, 'different songs differ');
const k4 = t.identityKey(t.identityFromPath('/a/Track01.mp3'));
assert(k4.startsWith('path:'), 'unparseable falls back to path');

// preferredPath + dedupeIdentities
assert(t.preferredPath(['/a/s.mp3', '/a/s.flac']) === '/a/s.flac', 'prefers lossless');
const dd = t.dedupeIdentities(['/a/Daft Punk - One More Time.mp3', '/b/daft punk - one more time.flac', '/a/Track01.mp3']);
assert(dd.length === 2, 'dedupe collapses same recording');
assert(dd.includes('/b/daft punk - one more time.flac'), 'dedupe keeps lossless');
assert(t.dedupeIdentities([]).length === 0, 'dedupe empty');

console.log('IDENTITY_OK');
`;

describe('Track identity (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('parse, key, dedupe', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, IDENTITY_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('IDENTITY_OK');
  });
});
