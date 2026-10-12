const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const COMPARE_URL = `file://${path.join(ROOT, 'ui', 'out', 'compare', 'compare.js')}`;
const SOURCE_ACCESS_URL = `file://${path.join(ROOT, 'ui', 'out', 'source-access.js')}`;

const SCRIPT = `
const c = await import(process.argv[1]);
const sa = await import(process.argv[2]);
const assert = (cond, name) => {
  if (!cond) { console.error('FAIL: ' + name); process.exit(1); }
  console.log('ok: ' + name);
};

// normalizeTrackKey
assert(c.normalizeTrackKey('/M/Song.mp3') === '/m/song.mp3', 'key casefolds');
assert(c.normalizeTrackKey('/M/My%20Song.mp3') === '/m/my song.mp3', 'key decodes');
assert(c.normalizeTrackKey('  /m/a.mp3  ') === '/m/a.mp3', 'key trims');

// displayTrackName
assert(c.displayTrackName('/m/Artist%20-%20Title.mp3') === 'Artist - Title.mp3', 'display decodes basename');
assert(c.displayTrackName('C:\\\\m\\\\song.mp3') === 'song.mp3', 'display windows sep');

// diffPlaylists
const d = c.diffPlaylists(
  ['/m/A.mp3', '/m/B.mp3', '/m/A.mp3'],
  ['/m/b.mp3', '/m/C.mp3'],
);
assert(d.common.length === 1 && d.common[0] === '/m/B.mp3', 'common keeps first A spelling');
assert(d.onlyA.length === 1 && d.onlyA[0] === '/m/A.mp3', 'onlyA dedupes');
assert(d.onlyB.length === 1 && d.onlyB[0] === '/m/C.mp3', 'onlyB');
const empty = c.diffPlaylists([], []);
assert(empty.common.length === 0 && empty.onlyA.length === 0 && empty.onlyB.length === 0, 'empty diff');

// collectPlaylists flattens leaf playlists with breadcrumbs
const tree = [
  { name: 'Party', type: 'folder', children: [
    { name: 'Warm-up', type: 'playlist' },
    { name: 'Peak', type: 'playlist' },
  ]},
  { name: 'Chill', type: 'playlist' },
  { name: 'Empty', type: 'folder', children: [] },
];
const opts = sa.collectPlaylists(tree);
assert(opts.length === 4, 'collect count (folders + playlists)');
assert(opts[0].label === 'Party' && opts[0].nodeType === 'folder', 'collect folder entry');
assert(opts[1].label === 'Party / Warm-up' && opts[1].nodeType === 'playlist', 'collect breadcrumb');
assert(opts[3].label === 'Chill', 'collect top-level');
assert(new Set(opts.map((o) => o.key)).size === 4, 'collect unique keys');

console.log('COMPARE_OK');
`;

describe('Playlist compare (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('diff + tree flatten behave', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, COMPARE_URL, SOURCE_ACCESS_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('COMPARE_OK');
  });
});
