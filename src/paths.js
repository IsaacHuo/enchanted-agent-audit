'use strict';

const path = require('node:path');
const { listDir, exists } = require('./fsread.js');

/** Expand leading `~` and `%VAR%` references without running a shell. */
function expandPath(input, home, env = process.env) {
  if (typeof input !== 'string') return input;
  let s = input;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(home, s.slice(1));
  }
  s = s.replace(/%([^%]+)%/g, (match, name) => {
    const value = env[name] ?? env[name.toUpperCase()];
    return typeof value === 'string' && value !== '' ? value : match;
  });
  return s;
}

function globToRegExp(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Expand a path pattern with single-segment `*` wildcards against the real
 * filesystem (read-only). Returns existing absolute paths.
 */
function listMatches(pattern, home, env = process.env) {
  const expanded = expandPath(pattern, home, env);
  if (!expanded || expanded.includes('%')) return [];
  const normalized = expanded.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((p) => p !== '');
  let base = '/';
  if (/^[A-Za-z]:$/.test(parts[0] || '')) {
    base = `${parts.shift()}/`;
  }
  let current = [base];
  for (const part of parts) {
    const next = [];
    for (const dir of current) {
      if (part.includes('*')) {
        const re = globToRegExp(part);
        for (const entry of listDir(dir)) {
          if (entry.dir && re.test(entry.name)) next.push(path.join(dir, entry.name));
        }
      } else {
        next.push(path.join(dir, part));
      }
    }
    current = next;
    if (current.length === 0) break;
  }
  return current.filter((p) => exists(p));
}

/** Normalise a path for display, replacing the home prefix with `~`. */
function displayPath(p, home, mode) {
  if (typeof p !== 'string') return p;
  if (mode === 'raw' || !home) return p;
  const normalized = path.normalize(p);
  const normalizedHome = path.normalize(home);
  if (normalized.toLowerCase().startsWith(normalizedHome.toLowerCase())) {
    const rest = normalized.slice(normalizedHome.length);
    return rest ? `~${rest.startsWith(path.sep) ? rest : path.sep + rest}` : '~';
  }
  return normalized;
}

module.exports = { expandPath, listMatches, displayPath };
