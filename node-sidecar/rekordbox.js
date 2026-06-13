const fs = require('fs');
const path = require('path');
const { getFileMetadata } = require('./commit');

/**
 * Helper to decode XML entities in track attributes
 */
function decodeXMLEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Helper to decode Location attributes
 */
function decodeLocation(rawLocation) {
  let decoded = rawLocation;
  if (decoded.startsWith('file://localhost/')) {
    decoded = decoded.substring('file://localhost'.length);
  } else if (decoded.startsWith('file:///')) {
    decoded = decoded.substring('file://'.length);
  }
  try {
    return decodeURIComponent(decoded);
  } catch (e) {
    return decoded;
  }
}

/**
 * Helper to format local date as YYYY-MM-DD
 */
function getLocalDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Helper to format timestamp as YYYY-MM-DD HH:MM:SS
 */
function getLogTimestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Helper to format log lines
 */
function formatLogLine(action, message) {
  const timestamp = getLogTimestamp();
  const actionTag = `[${action}]`.padEnd(17, ' ');
  return `[${timestamp}] ${actionTag}${message}\n`;
}

/**
 * URL-encode absolute path preserving file://localhost/ prefix
 */
function urlEncodePath(absPath) {
  const standardPath = absPath.split(path.sep).join('/');
  const segments = standardPath.split('/');
  const encodedSegments = segments.map(seg => {
    if (seg === '') return '';
    return encodeURIComponent(seg);
  });
  let encoded = encodedSegments.join('/');
  if (!encoded.startsWith('/')) {
    encoded = '/' + encoded;
  }
  return 'file://localhost' + encoded;
}

/**
 * Update Rekordbox XML Location attributes
 * @param {string} xmlPath - Path to Rekordbox exported XML file
 * @param {object} ledger - Current ledger state object
 * @param {string} rootPath - Scanned root directory path
 */
async function updateXML(xmlPath, ledger, rootPath, outputPath) {
  if (!fs.existsSync(xmlPath)) {
    throw new Error(`Rekordbox XML file not found at ${xmlPath}`);
  }

  const xmlContent = fs.readFileSync(xmlPath, 'utf8');
  const outputFormat = ledger.output_format || 'flac';
  const files = ledger.files;

  // Setup logging path
  const dateStr = getLocalDateString();
  const logPath = path.join(rootPath, `.crateup-log-${dateStr}.txt`);

  function writeLog(action, message) {
    try {
      const line = formatLogLine(action, message);
      fs.appendFileSync(logPath, line);
    } catch (err) {
      console.error(`Failed to write to session log: ${err.message}`);
    }
  }

  // Regex to find all TRACK elements
  const trackRegex = /<TRACK\s+([^>]+)\/?>/gi;
  const trackMatches = [];
  let match;
  trackRegex.lastIndex = 0;
  while ((match = trackRegex.exec(xmlContent)) !== null) {
    const fullTag = match[0];
    const attrString = match[1];

    // Simple attribute parser
    const attributes = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrString)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2];
    }

    trackMatches.push({
      index: match.index,
      length: fullTag.length,
      fullTag,
      attributes,
      isModified: false,
      newFullTag: ''
    });
  }

  // Map to speed up direct matches (normalized original path -> array of trackMatches)
  const nodesByLocation = new Map();
  for (const node of trackMatches) {
    const rawLoc = node.attributes.Location;
    if (rawLoc) {
      const decLoc = decodeLocation(rawLoc);
      const normLoc = path.normalize(decLoc);
      if (!nodesByLocation.has(normLoc)) {
        nodesByLocation.set(normLoc, []);
      }
      nodesByLocation.get(normLoc).push(node);
    }
  }

  let matchedCount = 0;
  let unmatchedCount = 0;
  let rewrittenCount = 0;

  for (const relPath in files) {
    const entry = files[relPath];
    const isCommitted = entry.status === 'committed';
    const isSkippedWithOutput = entry.status === 'skipped' && entry.output_path;

    if (!isCommitted && !isSkippedWithOutput) {
      continue;
    }

    const originalAbsPath = path.normalize(path.join(rootPath, relPath));
    let newAbsPath;
    if (entry.output_path) {
      newAbsPath = entry.output_path;
    } else {
      if (entry.status === 'committed') {
        const ext = path.extname(relPath);
        const newExt = '.' + outputFormat.toLowerCase();
        const newRelPath = relPath.slice(0, -ext.length) + newExt;
        newAbsPath = path.join(outputPath || rootPath, newRelPath);
      } else {
        newAbsPath = path.join(outputPath || rootPath, relPath);
      }
    }
    const newLocationEncoded = urlEncodePath(newAbsPath);

    // Get metadata for this track (for logging and/or fuzzy matching)
    const meta = getFileMetadata(newAbsPath);
    const artistTitle = `${meta.artist || 'Unknown Artist'} - ${meta.name || 'Unknown Title'}`;

    // 1. Try primary match: direct comparison of the Location path
    let matchedNodes = nodesByLocation.get(originalAbsPath) || [];

    if (matchedNodes.length > 0) {
      for (const node of matchedNodes) {
        node.isModified = true;
        node.newFullTag = node.fullTag.replace(/Location="[^"]*"/, () => `Location="${newLocationEncoded}"`);
        rewrittenCount++;
      }
      matchedCount++;
    } else {
      // 2. Try fallback fuzzy match on Name + Artist + TotalTime
      const fuzzyMatches = [];
      for (const node of trackMatches) {
        const xmlName = decodeXMLEntities(node.attributes.Name || '').toLowerCase().trim();
        const xmlArtist = decodeXMLEntities(node.attributes.Artist || '').toLowerCase().trim();
        const xmlDuration = parseFloat(node.attributes.TotalTime || '0');

        const ledgerName = (meta.name || '').toLowerCase().trim();
        const ledgerArtist = (meta.artist || '').toLowerCase().trim();
        const ledgerDuration = meta.duration || 0;

        const nameMatch = xmlName === ledgerName;
        const artistMatch = xmlArtist === ledgerArtist;
        const durationMatch = Math.abs(xmlDuration - ledgerDuration) <= 3;

        if (nameMatch && artistMatch && durationMatch) {
          fuzzyMatches.push(node);
        }
      }

      if (fuzzyMatches.length === 1) {
        const node = fuzzyMatches[0];
        node.isModified = true;
        node.newFullTag = node.fullTag.replace(/Location="[^"]*"/, () => `Location="${newLocationEncoded}"`);
        rewrittenCount++;
        matchedCount++;
      } else {
        // Zero or multiple fuzzy matches found -> unmatched
        unmatchedCount++;
        writeLog('UNMATCHED XML', `${artistTitle}  →  no Rekordbox node found`);
      }
    }
  }

  // Sort modified nodes by index descending to rebuild XML safely
  const modifiedNodes = trackMatches.filter(n => n.isModified);
  modifiedNodes.sort((a, b) => b.index - a.index);

  let updatedXml = xmlContent;
  for (const node of modifiedNodes) {
    const before = updatedXml.substring(0, node.index);
    const after = updatedXml.substring(node.index + node.length);
    updatedXml = before + node.newFullTag + after;
  }

  // Write output XML to the same directory as input XML
  const xmlDir = path.dirname(xmlPath);
  const outputXmlPath = path.join(xmlDir, `rekordbox_upgraded_${dateStr}.xml`);
  fs.writeFileSync(outputXmlPath, updatedXml, 'utf8');

  return {
    matched: matchedCount,
    unmatched: unmatchedCount,
    rewritten: rewrittenCount
  };
}

module.exports = {
  updateXML
};
