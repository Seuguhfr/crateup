const child_process = require('child_process');
const fs = require('fs');
const {
  calculateSimilarity,
  getRawAudioMD5,
  getChromaprintFingerprint,
  compareAudioFiles
} = require('../node-sidecar/similarity');

jest.mock('child_process');
jest.mock('fs');

describe('Audio Similarity Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getRawAudioMD5', () => {
    test('parses MD5 from ffmpeg output successfully', () => {
      child_process.execFileSync.mockReturnValueOnce('MD5=4c820520d7faa9b2e11c76e9c4d2d7c7\n');
      const hash = getRawAudioMD5('dummy.mp3');
      expect(hash).toBe('4c820520d7faa9b2e11c76e9c4d2d7c7');
      expect(child_process.execFileSync).toHaveBeenCalledWith(
        'ffmpeg',
        ['-i', 'dummy.mp3', '-map', '0:a', '-f', 'md5', '-'],
        expect.any(Object)
      );
    });

    test('returns null and logs error if ffmpeg fails', () => {
      child_process.execFileSync.mockImplementation(() => {
        throw new Error('ffmpeg command not found');
      });
      const hash = getRawAudioMD5('dummy.mp3');
      expect(hash).toBeNull();
    });
  });

  describe('getChromaprintFingerprint', () => {
    test('parses comma-separated fingerprint integers successfully', () => {
      child_process.execFileSync.mockReturnValueOnce('DURATION=5\nFINGERPRINT=123,456,789\n');
      const fp = getChromaprintFingerprint('dummy.mp3');
      expect(fp).toEqual([123, 456, 789]);
    });

    test('returns null and logs error if fpcalc fails', () => {
      child_process.execFileSync.mockImplementation(() => {
        throw new Error('fpcalc failed');
      });
      const fp = getChromaprintFingerprint('dummy.mp3');
      expect(fp).toBeNull();
    });
  });

  describe('calculateSimilarity', () => {
    test('returns 1.0 for identical fingerprints', () => {
      const fp = [123456, 789012, 345678, 901234, 567890, 123456, 789012, 345678, 901234, 567890];
      const sim = calculateSimilarity(fp, fp);
      expect(sim).toBe(1.0);
    });

    test('returns 0 for empty or invalid inputs', () => {
      expect(calculateSimilarity(null, [])).toBe(0);
      expect(calculateSimilarity([123], null)).toBe(0);
    });

    test('slides arrays to align them and returns maximum similarity', () => {
      // Create two fingerprints that are aligned but offset by 2 frames
      const fp1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const fp2 = [99, 99, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99];
      // When aligned (offset of 2), they should match perfectly
      // Using minOverlap = Math.min(60, 10) = 10, so overlap K = 10.
      const sim = calculateSimilarity(fp1, fp2);
      expect(sim).toBe(1.0);
    });

    test('partially different fingerprints return fractional similarity', () => {
      // A XOR B differs in some bits
      const fp1 = [0b11111111111111110000000000000000];
      const fp2 = [0b11111111111111111111111111111111]; // differs in last 16 bits
      // minOverlap will be 1 (since len is 1).
      // 16 bits match, 16 bits mismatch out of 32 bits -> 50% matching bits (0.5 similarity)
      const sim = calculateSimilarity(fp1, fp2);
      expect(sim).toBe(0.5);
    });
  });

  describe('compareAudioFiles', () => {
    test('returns bitIdentical=true if MD5s match', () => {
      fs.existsSync.mockReturnValue(true);
      child_process.execFileSync
        .mockReturnValueOnce('MD5=4c820520d7faa9b2e11c76e9c4d2d7c7\n') // file 1 md5
        .mockReturnValueOnce('MD5=4c820520d7faa9b2e11c76e9c4d2d7c7\n'); // file 2 md5

      const result = compareAudioFiles('f1.mp3', 'f2.mp3');
      expect(result).toEqual({ bitIdentical: true, similarity: 1.0 });
    });

    test('falls back to Chromaprint similarity if MD5s differ', () => {
      fs.existsSync.mockReturnValue(true);
      child_process.execFileSync
        .mockReturnValueOnce('MD5=4c820520d7faa9b2e11c76e9c4d2d7c7\n') // f1 md5
        .mockReturnValueOnce('MD5=1234567890abcdef1234567890abcdef\n') // f2 md5
        .mockReturnValueOnce('DURATION=5\nFINGERPRINT=123,456\n') // f1 fp
        .mockReturnValueOnce('DURATION=5\nFINGERPRINT=123,456\n'); // f2 fp

      const result = compareAudioFiles('f1.mp3', 'f2.mp3');
      expect(result).toEqual({ bitIdentical: false, similarity: 1.0 });
    });
  });
});
