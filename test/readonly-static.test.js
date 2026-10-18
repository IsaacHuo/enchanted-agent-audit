'use strict';

/**
 * Static proof that the audit itself cannot write.
 *
 * The runtime hash proof in `scripts/readonly-proof.js` can be disturbed by other
 * live processes (the agent writing its own session log). This test closes that
 * gap from the other side: the shipped source must contain no write, delete,
 * rename, chmod, or create API at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SHIPPED_DIRS = ['src', 'bin'];

const WRITE_API_RE =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|createReadStream\s*\([^)]*flags|unlinkSync|unlink|rmSync|rmdirSync|renameSync|rename|mkdirSync|mkdir|copyFileSync|copyFile|chmodSync|chmod|truncateSync|truncate|utimesSync|symlinkSync|linkSync|openSync\s*\([^)]*['"][wa])/;

function shippedFiles() {
  const out = [];
  for (const dir of SHIPPED_DIRS) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js')) out.push(path.join(ROOT, dir, name));
    }
  }
  return out;
}

test('shipped audit source contains no filesystem write or mutation API', () => {
  const offenders = [];
  for (const file of shippedFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, idx) => {
      if (/^\s*(\*|\/\/)/.test(line)) return; // comments and doc blocks
      if (WRITE_API_RE.test(line)) offenders.push(`${path.relative(ROOT, file)}:${idx + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `write API found in shipped source:\n${offenders.join('\n')}`);
});

test('files are only opened read-only', () => {
  const offenders = [];
  for (const file of shippedFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, idx) => {
      const m = /openSync\s*\(([^)]*)\)/.exec(line);
      if (!m) return;
      if (!/['"]r['"]/.test(m[1])) offenders.push(`${path.relative(ROOT, file)}:${idx + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `non read-only openSync:\n${offenders.join('\n')}`);
});

test('no mutating system command is passed to execFile', () => {
  const MUTATING = [
    'stop',
    'start',
    'restart',
    'delete',
    'remove',
    'disable',
    'enable',
    'uninstall',
    'install',
    'kill',
    'terminate',
    'create',
    'set',
    'change',
  ];
  const re = new RegExp(`['"](${MUTATING.join('|')})['"]`, 'i');
  const offenders = [];
  for (const file of shippedFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, idx) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      if (re.test(line)) offenders.push(`${path.relative(ROOT, file)}:${idx + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `mutating command token found:\n${offenders.join('\n')}`);
});
