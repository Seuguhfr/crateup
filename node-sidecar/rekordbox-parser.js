const fs = require('fs');
const path = require('path');

function parseAttributes(attrString) {
  const attrs = {};
  const regex = /(\w+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = regex.exec(attrString)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function decodeLocation(location) {
  if (!location) return '';
  const rawPath = decodeURIComponent(
    location.replace(/^file:\/\/localhost/, '').replace(/^file:\/\//, '')
  );
  const absolutePath = path.resolve(rawPath);
  if (!fs.existsSync(absolutePath)) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.warn(`[${ts}] [REKORDBOX-PARSER] Warning: resolved path does not exist on disk: ${absolutePath}`);
  }
  return absolutePath;
}

function parsePlaylistsXml(xmlString) {
  const nodeRegex = /<(\/?)(NODE|TRACK)\b([^>]*)>/g;
  let match;
  const stack = [];
  const rootChildren = [];
  
  while ((match = nodeRegex.exec(xmlString)) !== null) {
    const isClosing = match[1] === '/';
    const tagName = match[2];
    const attrString = match[3];
    const isSelfClosing = attrString.endsWith('/');
    
    if (tagName === 'NODE') {
      if (isClosing) {
        if (stack.length > 0) {
          const finishedNode = stack.pop();
          if (stack.length > 0) {
            stack[stack.length - 1].children.push(finishedNode);
          } else {
            rootChildren.push(finishedNode);
          }
        }
      } else {
        const attrs = parseAttributes(attrString);
        const node = {
          name: attrs.Name || '',
          type: attrs.Type === '0' ? 'folder' : 'playlist',
          children: [],
          tracks: []
        };
        if (attrs.Entries) {
          node.entryCount = parseInt(attrs.Entries, 10);
        }
        if (isSelfClosing) {
          if (stack.length > 0) {
            stack[stack.length - 1].children.push(node);
          } else {
            rootChildren.push(node);
          }
        } else {
          stack.push(node);
        }
      }
    } else if (tagName === 'TRACK' && !isClosing) {
      const attrs = parseAttributes(attrString);
      if (attrs.Key && stack.length > 0) {
        stack[stack.length - 1].tracks.push(attrs.Key);
      }
    }
  }
  
  return rootChildren;
}

function countTracks(node) {
  if (node.type === 'playlist') {
    return node.entryCount !== undefined ? node.entryCount : node.tracks.length;
  }
  let sum = 0;
  if (node.children) {
    for (const child of node.children) {
      sum += countTracks(child);
    }
  }
  return sum;
}

function mapTreeForUi(node) {
  const result = {
    name: node.name,
    type: node.type
  };
  if (node.type === 'playlist') {
    result.entryCount = node.entryCount !== undefined ? node.entryCount : node.tracks.length;
  } else if (node.type === 'folder') {
    result.totalTracks = countTracks(node);
  }
  if (node.type === 'folder' && node.children && node.children.length > 0) {
    result.children = node.children.map(mapTreeForUi);
  }
  return result;
}

function findPlaylistTracks(nodes, targetName) {
  for (const node of nodes) {
    if (node.type === 'playlist' && node.name === targetName) {
      return node.tracks;
    }
    if (node.children && node.children.length > 0) {
      const found = findPlaylistTracks(node.children, targetName);
      if (found) return found;
    }
  }
  return null;
}

function parsePlaylists(xmlPath) {
  if (!fs.existsSync(xmlPath)) {
    throw new Error(`XML file not found at: ${xmlPath}`);
  }
  const xmlString = fs.readFileSync(xmlPath, 'utf8');
  const rootChildren = parsePlaylistsXml(xmlString);
  
  const rootNode = rootChildren.find(n => n.name === 'ROOT');
  const topLevelNodes = rootNode ? rootNode.children : rootChildren;
  
  return topLevelNodes.map(mapTreeForUi);
}

function getPlaylistTracks(xmlPath, playlistName) {
  if (!fs.existsSync(xmlPath)) {
    throw new Error(`XML file not found at: ${xmlPath}`);
  }
  const xmlString = fs.readFileSync(xmlPath, 'utf8');
  
  // 1. Collect track locations
  const collection = new Map();
  const trackRegex = /<TRACK\s+([^>]+)\/?>/g;
  let trackMatch;
  while ((trackMatch = trackRegex.exec(xmlString)) !== null) {
    const attrs = parseAttributes(trackMatch[1]);
    if (attrs.TrackID && attrs.Location) {
      collection.set(attrs.TrackID, decodeLocation(attrs.Location));
    }
  }
  
  // 2. Parse tree to find target playlist
  const rootChildren = parsePlaylistsXml(xmlString);
  const trackIds = findPlaylistTracks(rootChildren, playlistName);
  
  if (!trackIds) return [];
  return trackIds.map(id => collection.get(id)).filter(Boolean);
}

function findFolderNode(nodes, targetName) {
  for (const node of nodes) {
    if (node.type === 'folder' && node.name === targetName) {
      return node;
    }
    if (node.children && node.children.length > 0) {
      const found = findFolderNode(node.children, targetName);
      if (found) return found;
    }
  }
  return null;
}

function collectTracksFromNode(node, tracksSet) {
  if (node.type === 'playlist') {
    if (node.tracks) {
      node.tracks.forEach(track => tracksSet.add(track));
    }
  } else if (node.type === 'folder' && node.children) {
    node.children.forEach(child => collectTracksFromNode(child, tracksSet));
  }
}

function getFolderTracks(xmlPath, folderName) {
  if (!fs.existsSync(xmlPath)) {
    throw new Error(`XML file not found at: ${xmlPath}`);
  }
  const xmlString = fs.readFileSync(xmlPath, 'utf8');
  
  // 1. Collect track locations
  const collection = new Map();
  const trackRegex = /<TRACK\s+([^>]+)\/?>/g;
  let trackMatch;
  while ((trackMatch = trackRegex.exec(xmlString)) !== null) {
    const attrs = parseAttributes(trackMatch[1]);
    if (attrs.TrackID && attrs.Location) {
      collection.set(attrs.TrackID, decodeLocation(attrs.Location));
    }
  }
  
  // 2. Parse tree to find target folder
  const rootChildren = parsePlaylistsXml(xmlString);
  const folderNode = findFolderNode(rootChildren, folderName);
  
  if (!folderNode) return [];
  
  // 3. Collect descendant tracks
  const tracksSet = new Set();
  collectTracksFromNode(folderNode, tracksSet);
  
  const trackIds = Array.from(tracksSet);
  return trackIds.map(id => collection.get(id)).filter(Boolean);
}

module.exports = {
  parsePlaylists,
  getPlaylistTracks,
  getFolderTracks,
  decodeLocation
};
