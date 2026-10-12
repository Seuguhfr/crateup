const { execFileSync, execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOOLS_URL = `file://${path.join(ROOT, 'ui', 'out', 'tools.js')}`;
const STORE_URL = `file://${path.join(ROOT, 'ui', 'out', 'store.js')}`;

const SCRIPT = `
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener: () => {},
};
globalThis.document = {
  documentElement: {},
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
const t = await import(process.argv[1]);
const s = await import(process.argv[2]);
const assert = (cond, name) => {
  if (!cond) { console.error('FAIL: ' + name); process.exit(1); }
  console.log('ok: ' + name);
};

assert(t.TOOLS.length === 5, 'five tools registered');
const ids = t.TOOLS.map((x) => x.id);
assert(new Set(ids).size === 5, 'unique ids');
assert(new Set(t.TOOLS.map((x) => x.route)).size === 5, 'unique routes');
assert(new Set(t.TOOLS.map((x) => x.label)).size === 5, 'unique labels');
for (const tool of t.TOOLS) {
  assert(s.ROUTES.includes(tool.route), 'route known: ' + tool.route);
  assert(tool.kind === 'pipeline' || tool.kind === 'utility', 'kind valid: ' + tool.id);
  assert(typeof tool.icon === 'string' && (tool.icon.includes('<path') || tool.icon.includes('<circle')), 'icon markup: ' + tool.id);
  assert(typeof tool.blurb === 'string' && tool.blurb.length > 10, 'blurb: ' + tool.id);
  assert(typeof tool.render === 'function', 'render fn: ' + tool.id);
}
assert(t.pipelineTools().length === 4, 'four pipeline tools');
assert(t.pipelineTools().every((x) => x.kind === 'pipeline'), 'pipelineTools filter');
assert(t.toolById('compare') && t.toolById('compare').kind === 'utility', 'compare is utility');
assert(t.toolById('nope') === null, 'toolById unknown null');
assert(t.toolByRoute('upgrader') && t.toolByRoute('upgrader').id === 'upgrader', 'toolByRoute');
assert(t.toolByRoute('home') === null, 'toolByRoute non-tool null');
assert(t.routeForTool('cleaner') === 'cleaner', 'routeForTool round-trip');
assert(t.routeForTool('compare') === 'compare', 'routeForTool compare');

console.log('TOOLS_OK');
`;

describe('Tool registry (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('registry invariants hold', () => {
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SCRIPT, TOOLS_URL, STORE_URL],
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(out).toMatch('TOOLS_OK');
  });
});
