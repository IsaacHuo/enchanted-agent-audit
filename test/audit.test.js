'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { audit } = require('../src/detect.js');
const { loadFixture } = require('../testlib/fixtures.js');

async function run(name, extra = {}) {
  const { fixture, home } = loadFixture(name);
  return audit({ fixture, home, ...extra });
}

function agent(report, id) {
  return report.agents.find((a) => a.id === id);
}

test('clean fixture: nothing installed, gate passes', async () => {
  const report = await run('clean');
  assert.deepEqual(report.summary.installed, []);
  assert.equal(report.ci.triggered, false);
});

test('codex fixture: auto-start service is observed with live state and fails the gate', async () => {
  const report = await run('codex-daemon');
  const codex = agent(report, 'codex');
  assert.equal(codex.installed, true);
  assert.equal(codex.daemons.persistenceDetected.value, true);
  assert.equal(codex.daemons.persistenceDetected.confidence, 'observed');
  assert.equal(codex.daemons.persistenceDetected.method, 'registry-read');
  const svc = codex.daemons.entries.find((e) => e.name === 'CodexSandboxService.OpenAI.Codex');
  assert.equal(svc.startType, 'auto');
  assert.equal(svc.state, 'running');
  assert.equal(report.ci.triggered, true);
  assert.deepEqual(report.ci.reasons[0].detail, ['windows-service:CodexSandboxService.OpenAI.Codex']);
});

test('codex fixture: decoupling is documented, never claimed as measured', async () => {
  const report = await run('codex-daemon');
  const dec = agent(report, 'codex').autoUpdate.decoupledFromPackageManager;
  assert.equal(dec.value, true);
  assert.equal(dec.confidence, 'documented');
  assert.ok(dec.note && dec.note.length > 10);
});

test('opencode fixture: explicit autoupdate=true is observed and fails the gate', async () => {
  const report = await run('autoupdate-on');
  const status = agent(report, 'opencode').autoUpdate.status;
  assert.equal(status.value, 'enabled');
  assert.equal(status.confidence, 'observed');
  assert.equal(status.method, 'file-read');
  assert.equal(report.ci.triggered, true);
  assert.equal(report.ci.reasons[0].kind, 'background-auto-update');
});

test('opencode fixture: explicit autoupdate=false is observed and passes the gate', async () => {
  const report = await run('autoupdate-off');
  const status = agent(report, 'opencode').autoUpdate.status;
  assert.equal(status.value, 'disabled');
  assert.equal(status.confidence, 'observed');
  assert.equal(report.ci.triggered, false);
});

test('adjacent update key is never promoted to an auto-update verdict', async () => {
  // Regression: `electron-internal-update-cdn-enabled = false` used to be read
  // as "auto-update disabled". It describes a CDN, not the update policy.
  const report = await run('adjacent-update-key');
  const autoUpdate = agent(report, 'codex').autoUpdate;
  assert.equal(autoUpdate.status.confidence, 'documented');
  assert.equal(autoUpdate.status.value, 'enabled');
  const key = autoUpdate.configuredKeys.find((k) => k.key === 'electron-internal-update-cdn-enabled');
  assert.equal(key.decidesAutoUpdate, false);
});

test('unavailable enumeration yields unknown, not a guess, and never fails the gate', async () => {
  const report = await run('enumeration-unavailable');
  for (const id of ['codex', 'claude-code', 'copilot-cli', 'opencode']) {
    assert.equal(agent(report, id).daemons.persistenceDetected.confidence, 'unknown', id);
  }
  assert.equal(report.ci.triggered, false);
});

test('secret-looking values are never copied into the report', async () => {
  const report = await run('enumeration-unavailable');
  const json = JSON.stringify(report);
  assert.equal(json.includes('fixture-must-never-appear-in-output'), false);
  assert.equal(/(oauth|api[_-]?key|token)/i.test(json) && json.includes('fixture-must'), false);
});

test('--only restricts the report to the requested agents', async () => {
  const report = await run('clean', { only: ['codex'] });
  assert.deepEqual(report.agents.map((a) => a.id), ['codex']);
});

test('telemetry-looking hosts are reported from a bounded static scan, labelled as text not traffic', async () => {
  const report = await run('autoupdate-on');
  const hosts = agent(report, 'opencode').telemetry.staticScanHosts.map((h) => h.value);
  assert.ok(hosts.includes('https://telemetry.example.test/ingest'), JSON.stringify(hosts));
  const hit = agent(report, 'opencode').telemetry.staticScanHosts.find((h) => h.value.includes('telemetry.example.test'));
  assert.equal(hit.confidence, 'observed');
  assert.equal(hit.method, 'file-read');
  assert.match(agent(report, 'opencode').telemetry.note, /No network traffic/);
});

test('fixture runs never fall back to the real home directory', async () => {
  const report = await run('codex-daemon');
  assert.equal(JSON.stringify(report).includes(os.homedir()), false);
});
