const path = require('path');
const { identifyTrack } = require('../node-sidecar/identify');

// Mock PythonBridge
jest.mock('../node-sidecar/rpc', () => {
  return jest.fn().mockImplementation(() => {
    return {
      start: jest.fn(),
      stop: jest.fn(),
      call: jest.fn().mockImplementation((method, params) => {
        if (method === 'fingerprint') {
          if (params.path.includes('unidentified')) {
            throw new Error('unidentified');
          }
          return { deezer_id: 12345, title: 'Mock Song', artist: 'Mock Artist' };
        }
      })
    };
  });
});

describe('Single-file Identification Module', () => {
  test('successfully identifies a track', async () => {
    const result = await identifyTrack('/mock/root', 'normal.mp3');
    expect(result).toEqual({
      deezer_id: 12345,
      title: 'Mock Song',
      artist: 'Mock Artist'
    });
  });

  test('handles identification failures', async () => {
    await expect(identifyTrack('/mock/root', 'unidentified.mp3')).rejects.toThrow('unidentified');
  });
});
