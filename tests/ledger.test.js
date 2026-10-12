process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PROD_LEDGER_FILENAME,
  LEDGER_VERSION,
  resolveLedgerFilename,
  resolveLedgerPath,
  loadLedger,
  saveLedger,
  clearLedgerCache,
} = require('../node-sidecar/ledger');
const { initLedger } = require('../node-sidecar/scanner');

describe('ledger module (shared resolution + read-through cache)', () => {
  test('test env resolves the production filename', () => {
    expect(resolveLedgerFilename()).toBe(PROD_LEDGER_FILENAME);
    expect(resolveLedgerFilename()).toBe('.crateup-progress.json');
  });

  test('resolveLedgerPath joins root + filename', () => {
    expect(resolveLedgerPath('/music')).toBe(path.join('/music', '.crateup-progress.json'));
  });

  describe('read-through cache', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crateup-ledger-'));
      clearLedgerCache();
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      clearLedgerCache();
    });

    const seed = (files) => {
      const ledgerPath = path.join(dir, '.crateup-progress.json');
      fs.writeFileSync(ledgerPath, JSON.stringify({ files }), 'utf8');
      return ledgerPath;
    };

    test('loadLedger returns null when no file exists', () => {
      expect(loadLedger(dir)).toBeNull();
    });

    test('second load hits the cache (same reference)', () => {
      seed({ '/a.mp3': { status: 'pending' } });
      const first = loadLedger(dir);
      const second = loadLedger(dir);
      expect(first).not.toBeNull();
      expect(second).toBe(first);
    });

    test('outside modification invalidates the cache', () => {
      seed({ '/a.mp3': { status: 'pending' } });
      const first = loadLedger(dir);
      expect(first.files['/a.mp3'].status).toBe('pending');

      // Simulate an outside writer (Rust side / manual edit) with a
      // guaranteed-different mtime to avoid timestamp granularity flakes.
      const ledgerPath = path.join(dir, '.crateup-progress.json');
      fs.writeFileSync(
        ledgerPath,
        JSON.stringify({ files: { '/a.mp3': { status: 'downloaded' } } }),
        'utf8'
      );
      const past = new Date(Date.now() - 5000);
      fs.utimesSync(ledgerPath, past, past);

      const second = loadLedger(dir);
      expect(second).not.toBe(first);
      expect(second.files['/a.mp3'].status).toBe('downloaded');
    });

    test('saveLedger persists and refreshes the cache', () => {
      seed({ '/a.mp3': { status: 'pending' } });
      const ledger = loadLedger(dir);
      ledger.files['/a.mp3'].status = 'skipped';
      const written = saveLedger(dir, ledger);
      expect(written).toBe(path.join(dir, '.crateup-progress.json'));
      expect(JSON.parse(fs.readFileSync(written, 'utf8')).files['/a.mp3'].status).toBe(
        'skipped'
      );
      // Cache reflects the write even if the filesystem timestamp collides.
      expect(loadLedger(dir)).toBe(ledger);
    });
  });

  describe('schema version', () => {
    let dir;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crateup-ledger-v-'));
      clearLedgerCache();
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      clearLedgerCache();
    });

    test('new ledgers carry the current version', () => {
      const ledger = initLedger(dir, 'flac');
      expect(ledger.ledger_version).toBe(LEDGER_VERSION);
      expect(JSON.parse(fs.readFileSync(resolveLedgerPath(dir), 'utf8')).ledger_version).toBe(
        LEDGER_VERSION
      );
    });

    test('pre-version ledgers load as v1 and keep unknown fields', () => {
      const legacy = {
        session_id: 's1',
        root_path: dir,
        output_format: 'flac',
        files: {},
        future_field: { hello: 'world' },
      };
      fs.writeFileSync(resolveLedgerPath(dir), JSON.stringify(legacy), 'utf8');
      const merged = initLedger(dir, 'flac');
      expect(merged.ledger_version).toBe(1);
      expect(merged.future_field).toEqual({ hello: 'world' });
      const roundTripped = JSON.parse(fs.readFileSync(resolveLedgerPath(dir), 'utf8'));
      expect(roundTripped.ledger_version).toBe(1);
      expect(roundTripped.future_field).toEqual({ hello: 'world' });
    });
  });
});
