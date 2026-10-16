const { execSync, execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REVIEW_URL = `file://${path.join(ROOT, 'ui', 'out', 'upgrader', 'review.js')}`;

const SCRIPT = `
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};

let audioPaused = false;
let audioCurrentTime = 100;
let audioSrcAttr = 'track.mp3';

const mockAudioEl = {
  tagName: 'AUDIO',
  pause: () => { audioPaused = true; },
  set currentTime(v) { audioCurrentTime = v; },
  get currentTime() { return audioCurrentTime; },
  removeAttribute: (attr) => { if (attr === 'src') audioSrcAttr = ''; },
  load: () => {},
};

globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  matchMedia: () => ({ matches: false }),
};

globalThis.document = {
  documentElement: {},
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: (selector) => {
    if (selector.includes('audio')) {
      return [mockAudioEl];
    }
    return [];
  },
  addEventListener: () => {},
};

const review = await import(process.argv[1]);
const assert = (cond, name) => {
  if (!cond) { console.error('FAIL: ' + name); process.exit(1); }
  console.log('ok: ' + name);
};

// 1. stopAllReviewAudio should be exported and executable cleanly in headless env
assert(typeof review.stopAllReviewAudio === 'function', 'stopAllReviewAudio exported');
audioPaused = false;
audioCurrentTime = 50;
review.stopAllReviewAudio();
assert(audioPaused === true, 'audio elements paused by stopAllReviewAudio');
assert(audioCurrentTime === 0, 'audio currentTime reset to 0 by stopAllReviewAudio');

// 2. teardownReview calls stopAllReviewAudio even when active is false
audioPaused = false;
audioCurrentTime = 25;
const result = review.teardownReview();
assert(result === false, 'teardownReview returns false when not active');
assert(audioPaused === true, 'audio elements paused by teardownReview');
assert(audioCurrentTime === 0, 'audio currentTime reset to 0 by teardownReview');

console.log('AUDIO_LIFECYCLE_OK');
`;

describe('Audio lifecycle and teardown (compiled ui output)', () => {
  beforeAll(() => {
    execSync('npm run build:ui --silent', { cwd: ROOT, stdio: 'pipe' });
  });

  test('stopAllReviewAudio and teardownReview silence all audio playback', () => {
    const out = execFileSync('node', ['--input-type=module', '-e', SCRIPT, REVIEW_URL], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(out).toContain('AUDIO_LIFECYCLE_OK');
  });
});
