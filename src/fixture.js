'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Recursively replace the `%FIXTURE_HOME%` token in every string value. */
function expandToken(value, home) {
  if (typeof value === 'string') return value.replace(/%FIXTURE_HOME%/g, home);
  if (Array.isArray(value)) return value.map((item) => expandToken(item, home));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = expandToken(inner, home);
    return out;
  }
  return value;
}

/**
 * Load a captured-enumeration fixture.
 *
 * `home` is resolved relative to the fixture file, and `%FIXTURE_HOME%` tokens
 * are expanded so path globs stay deterministic and never fall back to the real
 * machine's environment.
 */
function loadFixtureFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const home = path.resolve(path.dirname(file), raw.home || './home');
  return { fixture: expandToken(raw, home), home };
}

module.exports = { loadFixtureFile, expandToken };
