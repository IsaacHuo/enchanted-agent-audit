#!/usr/bin/env node
'use strict';

/**
 * Regenerate the checked-in example outputs from the fixtures, so the docs never
 * drift from the real renderer. Fixtures contain no real host data.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'enchanted-agent-audit.js');
const EXAMPLES = path.join(ROOT, 'examples');

/** Run the CLI and return its exit code plus stdout, without throwing on 1. */
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', timeout: 120000 });
    return { code: 0, stdout };
  } catch (err) {
    return { code: typeof err.status === 'number' ? err.status : 3, stdout: String(err.stdout || '') };
  }
}

function fixture(name) {
  return path.join(ROOT, 'test', 'fixtures', name, 'fixture.json');
}

/** Freeze generated timestamps so regenerating examples produces no diff. */
function normalize(text) {
  return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '2026-01-01T00:00:00.000Z');
}

function write(name, text) {
  const body = normalize(text.endsWith('\n') ? text : `${text}\n`);
  fs.writeFileSync(path.join(EXAMPLES, name), body, 'utf8');
  process.stdout.write(`wrote examples/${name} (${body.length} bytes)\n`);
}

fs.mkdirSync(EXAMPLES, { recursive: true });

const daemonTable = run(['--fixture', fixture('codex-daemon')]);
write('table.txt', daemonTable.stdout);

const daemonJson = run(['--fixture', fixture('codex-daemon'), '--json']);
write('report.json', daemonJson.stdout);

const cleanJson = run(['--fixture', fixture('clean'), '--json']);
write('report-clean.json', cleanJson.stdout);

const ciFail = run(['--fixture', fixture('codex-daemon'), '--ci']);
write('ci-fail.txt', `${ciFail.stdout}exit code: ${ciFail.code}\n`);

const ciFailUpdate = run(['--fixture', fixture('autoupdate-on'), '--ci']);
write('ci-fail-autoupdate.txt', `${ciFailUpdate.stdout}exit code: ${ciFailUpdate.code}\n`);

const ciPass = run(['--fixture', fixture('autoupdate-off'), '--ci']);
write('ci-pass.txt', `${ciPass.stdout}exit code: ${ciPass.code}\n`);

if (daemonTable.code !== 0 || daemonJson.code !== 0 || ciFail.code !== 1 || ciFailUpdate.code !== 1 || ciPass.code !== 0) {
  process.stderr.write('unexpected exit codes while generating examples\n');
  process.exitCode = 1;
}
