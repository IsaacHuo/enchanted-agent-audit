'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { audit } = require('../src/detect.js');
const { renderReport, pad } = require('../src/render.js');
const { loadFixture } = require('../testlib/fixtures.js');

const BIN = path.join(__dirname, '..', 'bin', 'enchanted-agent-audit.js');

function cli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 60000 });
}

async function reportFor(name) {
  const { fixture, home } = loadFixture(name);
  return audit({ fixture, home });
}

test('pad truncates with ASCII only and never truncates an exactly-fitting string', () => {
  assert.equal(pad('GitHub Copilot CLI', 20), 'GitHub Copilot CLI  ');
  assert.equal(pad('Tel.', 4), 'Tel.');
  assert.equal(pad('x'.repeat(30), 10), 'xxxxxxxx..');
});

test('table output is ASCII-only so it renders in the legacy Windows console', async () => {
  const report = await reportFor('codex-daemon');
  const out = renderReport(report);
  assert.equal(/^[\x00-\x7f]*$/.test(out), true, 'non-ASCII character in table output');
  assert.match(out, /Codex CLI/);
  assert.match(out, /1 auto-start/);
});

test('CLI --json returns schema 1 and exit 0 for a clean fixture', () => {
  const { file } = loadFixture('clean');
  const res = cli(['--fixture', file, '--json']);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.schema, 'enchanted.agent-audit/v1');
  assert.equal(report.ci.triggered, false);
});

test('CLI --ci exits 1 when a persistent daemon is present', () => {
  const { file } = loadFixture('codex-daemon');
  const res = cli(['--fixture', file, '--ci']);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /CI: FAIL/);
});

test('CLI --ci exits 1 for an observed background auto-update', () => {
  const { file } = loadFixture('autoupdate-on');
  assert.equal(cli(['--fixture', file, '--ci']).status, 1);
});

test('CLI --ci exits 0 when auto-update is explicitly disabled', () => {
  const { file } = loadFixture('autoupdate-off');
  assert.equal(cli(['--fixture', file, '--ci']).status, 0);
});

test('CLI rejects an unknown option with exit 2', () => {
  assert.equal(cli(['--nope']).status, 2);
});

test('CLI rejects an unknown agent id with exit 2', () => {
  assert.equal(cli(['--only', 'not-an-agent']).status, 2);
});
