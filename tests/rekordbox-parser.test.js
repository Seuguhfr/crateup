const fs = require('fs');
const path = require('path');
const { parsePlaylists, getPlaylistTracks, getFolderTracks, decodeLocation } = require('../node-sidecar/rekordbox-parser');

describe('Rekordbox XML Parser Module', () => {
  const testRoot = path.join(__dirname, 'temp-parser-test');
  const xmlPath = path.join(testRoot, 'collection.xml');

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRoot);
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('decodeLocation correctly decodes paths', () => {
    expect(decodeLocation('file://localhost/Users/username/Music/Track%20Name.mp3')).toBe('/Users/username/Music/Track Name.mp3');
    expect(decodeLocation('file:///Users/username/Music/Track%26Name.mp3')).toBe('/Users/username/Music/Track&Name.mp3');
    expect(decodeLocation('file://localhost/C:/Users/username/Music/Track%20Name.mp3')).toBe('/C:/Users/username/Music/Track Name.mp3');
  });

  test('parsePlaylists parses nested folders and empty playlists', () => {
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="2">
    <TRACK TrackID="1" Location="file://localhost/Users/test/1.mp3" />
    <TRACK TrackID="2" Location="file://localhost/Users/test/2.mp3" />
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT">
      <NODE Type="0" Name="Folder A">
        <NODE Type="1" Name="Playlist 1" Entries="2">
          <TRACK Key="1" />
          <TRACK Key="2" />
        </NODE>
        <NODE Type="1" Name="Empty Playlist" Entries="0">
        </NODE>
      </NODE>
      <NODE Type="1" Name="Top Level Playlist" Entries="1">
        <TRACK Key="2" />
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;
    fs.writeFileSync(xmlPath, mockXml, 'utf8');

    const tree = parsePlaylists(xmlPath);

    expect(tree).toEqual([
      {
        name: 'Folder A',
        type: 'folder',
        totalTracks: 2,
        children: [
          {
            name: 'Playlist 1',
            type: 'playlist',
            entryCount: 2
          },
          {
            name: 'Empty Playlist',
            type: 'playlist',
            entryCount: 0
          }
        ]
      },
      {
        name: 'Top Level Playlist',
        type: 'playlist',
        entryCount: 1
      }
    ]);
  });

  test('getPlaylistTracks retrieves decoded absolute file paths', () => {
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="3">
    <TRACK TrackID="10" Location="file://localhost/Users/test/Track%2010.mp3" />
    <TRACK TrackID="20" Location="file://localhost/Users/test/Track%2020.mp3" />
    <TRACK TrackID="30" Location="file://localhost/Users/test/Track%2030.mp3" />
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT">
      <NODE Type="0" Name="Subfolder">
        <NODE Type="1" Name="My Playlist" Entries="2">
          <TRACK Key="10" />
          <TRACK Key="30" />
        </NODE>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;
    fs.writeFileSync(xmlPath, mockXml, 'utf8');

    const tracks = getPlaylistTracks(xmlPath, 'My Playlist');

    expect(tracks).toEqual([
      '/Users/test/Track 10.mp3',
      '/Users/test/Track 30.mp3'
    ]);

    const nonExistent = getPlaylistTracks(xmlPath, 'Non-existent Playlist');
    expect(nonExistent).toEqual([]);
  });

  test('getFolderTracks retrieves and deduplicates tracks from nested playlists', () => {
    const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <COLLECTION Entries="3">
    <TRACK TrackID="10" Location="file://localhost/Users/test/Track%2010.mp3" />
    <TRACK TrackID="20" Location="file://localhost/Users/test/Track%2020.mp3" />
    <TRACK TrackID="30" Location="file://localhost/Users/test/Track%2030.mp3" />
  </COLLECTION>
  <PLAYLISTS>
    <NODE Type="0" Name="ROOT">
      <NODE Type="0" Name="Parent Folder">
        <NODE Type="1" Name="Playlist A" Entries="2">
          <TRACK Key="10" />
          <TRACK Key="20" />
        </NODE>
        <NODE Type="0" Name="Subfolder">
          <NODE Type="1" Name="Playlist B" Entries="2">
            <TRACK Key="20" />
            <TRACK Key="30" />
          </NODE>
        </NODE>
      </NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>
`;
    fs.writeFileSync(xmlPath, mockXml, 'utf8');

    const tracks = getFolderTracks(xmlPath, 'Parent Folder');

    expect(tracks.sort()).toEqual([
      '/Users/test/Track 10.mp3',
      '/Users/test/Track 20.mp3',
      '/Users/test/Track 30.mp3'
    ].sort());

    const nonExistent = getFolderTracks(xmlPath, 'Non-existent Folder');
    expect(nonExistent).toEqual([]);
  });
});
