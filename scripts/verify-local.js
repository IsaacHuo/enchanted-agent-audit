#!/usr/bin/env node
'use strict';

/**
 * Local acceptance checks for the release candidate. Read-only: runs the CLI,
 * validates its output, and prints a PASS/FAIL line per criterion.
 *
 * Usage: node scripts/verify-local.js [--skip-proof]
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'enchanted-agent-audit.js');
const results = [];

function runNode(args) {
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 240000, cwd: ROOT });
}

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
    process.stdout.write(`PASS  ${name}${detail ? ` - ${detail}` : ''}\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: (err && err.message) || String(err) });
    process.stdout.write(`FAIL  ${name} - ${(err && err.message) || err}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Every finding object in the report must carry confidence and method. */
function auditFindingShape(node, trail = 'report') {
  if (Array.isArray(node)) {
    node.forEach((item, i) => auditFindingShape(item, `${trail}[${i}]`));
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (Object.prototype.hasOwnProperty.call(node, 'confidence')) {
    assert(typeof node.confidence === 'string', `${trail}: confidence is not a string`);
    assert(
      ['observed', 'inferred', 'documented', 'unknown'].includes(node.confidence),
      `${trail}: bad confidence ${node.confidence}`,
    );
    assert(typeof node.method === 'string' && node.method.length > 0, `${trail}: missing method`);
  }
  for (const [key, value] of Object.entries(node)) auditFindingShape(value, `${trail}.${key}`);
}

check('runtime records Node version', () => `${process.version} on ${process.platform}`);

check('--version exits 0', () => {
  const res = runNode([BIN, '--version']);
  assert(res.status === 0, `exit ${res.status}`);
  return res.stdout.trim();
});

check('--help exits 0 and documents exit codes', () => {
  const res = runNode([BIN, '--help']);
  assert(res.status === 0, `exit ${res.status}`);
  assert(res.stdout.includes('Exit codes'), 'help lacks exit code section');
  return 'help ok';
});

check('default table on this machine exits 0 or 1', () => {
  const res = runNode([BIN, '--quiet']);
  assert([0, 1].includes(res.status), `exit ${res.status}: ${res.stderr}`);
  assert(res.stdout.includes('Agent'), 'table header missing');
  assert(/CI: (PASS|FAIL)/.test(res.stdout), 'CI verdict line missing');
  const nonAscii = [...res.stdout].filter((c) => c.charCodeAt(0) > 127);
  assert(nonAscii.length === 0, `non-ASCII output: ${[...new Set(nonAscii)].join(' ')}`);
  return `${res.stdout.split(/\r?\n/).length} lines`;
});

check('--json is valid, schema-tagged and every finding is labelled', () => {
  const res = runNode([BIN, '--json']);
  assert([0, 1].includes(res.status), `exit ${res.status}: ${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert(report.schema === 'enchanted.agent-audit/v1', `schema ${report.schema}`);
  assert(Array.isArray(report.agents) && report.agents.length === 4, 'expected 4 agent entries');
  auditFindingShape(report);
  return `${report.agents.length} agents, ${report.summary.installed.length} installed, ci=${report.ci.triggered}`;
});

check('--ci exit code matches report.ci.triggered', () => {
  const ci = runNode([BIN, '--ci', '--quiet']);
  const json = runNode([BIN, '--json']);
  const report = JSON.parse(json.stdout);
  const expected = report.ci.triggered ? 1 : 0;
  assert(ci.status === expected, `exit ${ci.status}, expected ${expected}`);
  return `exit ${ci.status}`;
});

check('fixture gate: persistent daemon -> 1', () => {
  const res = runNode([BIN, '--fixture', 'test/fixtures/codex-daemon/fixture.json', '--ci', '--quiet']);
  assert(res.status === 1, `exit ${res.status}`);
  return 'exit 1';
});

check('fixture gate: enabled background auto-update -> 1', () => {
  const res = runNode([BIN, '--fixture', 'test/fixtures/autoupdate-on/fixture.json', '--ci', '--quiet']);
  assert(res.status === 1, `exit ${res.status}`);
  return 'exit 1';
});

check('fixture gate: auto-update disabled -> 0', () => {
  const res = runNode([BIN, '--fixture', 'test/fixtures/autoupdate-off/fixture.json', '--ci', '--quiet']);
  assert(res.status === 0, `exit ${res.status}`);
  return 'exit 0';
});

check('fixture gate: nothing installed -> 0', () => {
  const res = runNode([BIN, '--fixture', 'test/fixtures/clean/fixture.json', '--ci', '--quiet']);
  assert(res.status === 0, `exit ${res.status}`);
  return 'exit 0';
});

if (!process.argv.includes('--skip-proof')) {
  check('read-only proof passes', () => {
    const res = runNode([path.join(ROOT, 'scripts', 'readonly-proof.js'), '--json', '--settle-ms', '1500']);
    assert(res.status === 0, `exit ${res.status}`);
    const proof = JSON.parse(res.stdout);
    assert(proof.unchanged === true, 'proof reported a change');
    return `${proof.roots.length} roots, 0 audit writes`;
  });
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exitCode = failed.length ? 1 : 0;
