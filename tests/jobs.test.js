const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JOBS_URL = `file://${path.join(ROOT, 'ui', 'out', 'jobs.js')}`;

const SCRIPT = `
const j = await import(process.argv[1]);
const assert = (cond, name) => {
  if (!cond) { console.error('FAIL: ' + name); process.exit(1); }
  console.log('ok: ' + name);
};

// jobPercent: 0..100 clamping + degenerate inputs
assert(j.jobPercent(0, 0) === 0, 'percent zero total');
assert(j.jobPercent(5, 0) === 0, 'percent nonzero over zero');
assert(j.jobPercent(1, 2) === 50, 'percent half');
assert(j.jobPercent(3, 2) === 100, 'percent clamps high');
assert(j.jobPercent(-1, 4) === 0, 'percent clamps low');
assert(j.jobPercent(NaN, 4) === 0, 'percent NaN safe');
assert(j.jobPercent(1, Infinity) === 0, 'percent infinite total safe');

// jobProgressHtml: shared markup with ids + escaped label
const html = j.jobProgressHtml('fill-1', 'txt-1', 'Matching <b>by</b> sound');
assert(html.includes('id="fill-1"') && html.includes('id="txt-1"'), 'progress ids');
assert(html.includes('Matching &lt;b&gt;by&lt;/b&gt; sound'), 'progress label escaped');
assert(html.includes('pbox') && html.includes('pbar'), 'progress bar classes');

// detachAll: nulls, undefined, throwers tolerated
let calls = 0;
j.detachAll(null, undefined, () => { calls++; }, () => { throw new Error('gone'); });
assert(calls === 1, 'detachAll runs + tolerates');

console.log('JOBS_OK');
`;

describe('Jobs protocol (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('pure helpers behave', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, JOBS_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('JOBS_OK');
  });
});
