'use strict';

/**
 * Read-only filesystem helpers with a conservative secret policy.
 *
 * The audit only ever needs three things from a file: does it exist, which
 * *keys* appear in it, and (for a small allowlist of known-safe settings) its
 * value. To keep that guarantee we:
 *   - never read files whose name marks them as credential stores;
 *   - never return raw values for keys that look like secrets;
 *   - cap how much of a file we read.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Bounded read. Some agent config stores are legitimately larger than half a
 * megabyte (Codex's global state file is ~600 KB); a smaller cap silently
 * truncated them and turned readable settings into parse errors. 4 MB keeps the
 * bound while covering real configs; bulk content scanning has its own 512 KB
 * limit in detect.js.
 */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** Key names that are never allowed to carry a value into the report. */
const SECRET_KEY_RE =
  /(pass(word|phrase)?|secret|token|api[_-]?key|apikey|auth(orization)?|cookie|credential|private[_-]?key|bearer|session[_-]?id|client[_-]?secret)/i;

/** Files that are treated as credential stores and never read. */
const SECRET_FILE_RE =
  /^(auth\.json|credentials(\.json)?|service\.json|\.env(\..+)?|id_(rsa|ed25519|ecdsa)|.+\.(pem|key|p12|pfx))$/i;

/** Paths that are always off-limits even if the file name looks innocent. */
const SECRET_DIR_SEGMENT_RE = /(^|[\\/])(secrets?|credentials?|\.ssh|\.aws|\.gnupg)([\\/]|$)/i;

function isSecretFile(filePath) {
  const base = path.basename(filePath);
  if (SECRET_FILE_RE.test(base)) return true;
  if (/\.tokens\.json$/i.test(base)) return true;
  if (SECRET_DIR_SEGMENT_RE.test(filePath)) return true;
  return false;
}

function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key));
}

/** Read a text file, refusing credential stores. Returns null on any failure. */
function readTextSafe(filePath) {
  if (isSecretFile(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(filePath, 'r');
    try {
      const length = Math.min(stat.size, MAX_READ_BYTES);
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, 0);
      return buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** List directory entry names (never recurses). Returns [] on failure. */
function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      dir: e.isDirectory(),
    }));
  } catch {
    return [];
  }
}

/** Size in bytes or null. */
function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

/**
 * Minimal, dependency-free TOML reader for the shapes we care about:
 * `key = value`, `[table]`, `[table.sub]`, and `[[array.of.tables]]`.
 * It is intentionally small; anything it cannot parse is reported as unknown
 * rather than guessed.
 * @returns {object|null}
 */
function parseTomlShallow(text) {
  if (typeof text !== 'string') return null;
  const root = {};
  let cursor = root;
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    let m = /^\[\[\s*([^\]]+?)\s*\]\]$/.exec(line);
    if (m) {
      const keys = m[1].split('.').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      let node = root;
      for (let i = 0; i < keys.length; i += 1) {
        const last = i === keys.length - 1;
        if (last) {
          if (!Array.isArray(node[keys[i]])) node[keys[i]] = [];
          const entry = {};
          node[keys[i]].push(entry);
          node = entry;
        } else {
          if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
          node = node[keys[i]];
        }
      }
      cursor = node;
      continue;
    }
    m = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (m) {
      const keys = m[1].split('.').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      let node = root;
      for (const key of keys) {
        if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
        node = node[key];
      }
      cursor = node;
      continue;
    }
    m = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (m) {
      const key = m[1].trim().replace(/^["']|["']$/g, '');
      if (!key) continue;
      cursor[key] = parseTomlValue(m[2].trim());
    }
  }
  return root;
}

function parseTomlValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === '') return '';
  const quoted = /^(['"])([\s\S]*)\1$/.exec(raw);
  if (quoted) return quoted[2];
  if (/^\[[\s\S]*\]$/.test(raw)) {
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map((s) => {
        const q = /^(['"])([\s\S]*)\1$/.exec(s);
        return q ? q[2] : s;
      });
  }
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

/** Collect dotted key paths of an object, skipping secret-looking keys. */
function collectKeyPaths(obj, prefix = '', out = [], depth = 0) {
  if (depth > 6 || obj === null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    for (const item of obj) collectKeyPaths(item, prefix, out, depth + 1);
    return out;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretKey(key)) continue;
    const dotted = prefix ? `${prefix}.${key}` : key;
    out.push(dotted);
    if (value && typeof value === 'object') collectKeyPaths(value, dotted, out, depth + 1);
  }
  return out;
}

/** Safely resolved value for an allowlisted key path, else undefined. */
function getPath(obj, dotted) {
  return dotted
    .split('.')
    .reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), obj);
}

module.exports = {
  isSecretFile,
  isSecretKey,
  readTextSafe,
  exists,
  isDir,
  isFile,
  listDir,
  sizeOf,
  parseTomlShallow,
  collectKeyPaths,
  getPath,
};
