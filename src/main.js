'use strict';

const os = require('node:os');
const path = require('node:path');
const { audit } = require('./detect.js');
const { loadFixtureFile } = require('./fixture.js');
const { renderReport } = require('./render.js');
const { AGENTS } = require('./rules.js');

const TOOL_VERSION = require('../package.json').version;

const EXIT = Object.freeze({
  OK: 0,
  CI_TRIGGERED: 1,
  USAGE: 2,
  ERROR: 3,
});

const HELP = `enchanted-agent-audit v${TOOL_VERSION}

Read-only audit of the persistent daemons/services, telemetry endpoints and
auto-update behaviour that coding-agent CLIs install and run on your machine.

Usage:
  enchanted-agent-audit [options]

Options:
  --json                Print the full report as JSON.
  --table               Print the human-readable table (default).
  --ci                  CI gate: exit 1 when an observed persistent daemon or
                        background auto-update is found, else exit 0.
  --only <ids>          Comma-separated agent ids: ${AGENTS.map((a) => a.id).join(', ')}
  --home <dir>          Audit an alternative home directory (for fixtures/CI).
  --fixture <file>      Replay captured enumeration data from a JSON fixture
                        instead of querying this machine (deterministic CI demo).
  --paths <mode>        raw | home-relative (default: home-relative).
  --quiet               Table only, without per-agent detail.
  --version             Print the tool version.
  --help                Print this help.

Guarantees:
  * Reports only. Never modifies, stops, uninstalls or writes system state.
  * No network access, no accounts, no telemetry from this tool.
  * Unknowable facts are labelled unknown; vendor behaviour is labelled
    documented with a source URL. Runtime loading and network traffic are
    never claimed to be observed.

Exit codes: 0 ok, 1 CI triggered, 2 usage error, 3 internal error.
`;

function parseArgs(argv) {
  const options = {
    json: false,
    ci: false,
    detail: true,
    only: null,
    home: process.env.ENCHANTED_AGENT_AUDIT_HOME || os.homedir(),
    pathMode: 'home-relative',
    fixturePath: null,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--json':
        options.json = true;
        break;
      case '--table':
        options.json = false;
        break;
      case '--ci':
        options.ci = true;
        break;
      case '--quiet':
        options.detail = false;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-V':
        options.version = true;
        break;
      case '--only': {
        const value = argv[++i];
        if (!value) throw new UsageError('--only requires a value');
        options.only = value.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      }
      case '--home': {
        const value = argv[++i];
        if (!value) throw new UsageError('--home requires a value');
        options.home = path.resolve(value);
        break;
      }
      case '--fixture': {
        const value = argv[++i];
        if (!value) throw new UsageError('--fixture requires a path');
        options.fixturePath = path.resolve(value);
        break;
      }
      case '--paths': {
        const value = argv[++i];
        if (value !== 'raw' && value !== 'home-relative') throw new UsageError('--paths must be raw or home-relative');
        options.pathMode = value;
        break;
      }
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }
  return options;
}

class UsageError extends Error {}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}`);
    return EXIT.USAGE;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }
  if (options.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return EXIT.OK;
  }

  if (options.fixturePath) {
    try {
      const loaded = loadFixtureFile(options.fixturePath);
      options.fixture = loaded.fixture;
      options.home = loaded.home;
    } catch (err) {
      process.stderr.write(`cannot read fixture ${options.fixturePath}: ${err.message}\n`);
      return EXIT.USAGE;
    }
  }

  if (options.only) {
    const known = new Set(AGENTS.map((a) => a.id));
    const bad = options.only.filter((id) => !known.has(id));
    if (bad.length) {
      process.stderr.write(`unknown agent id(s): ${bad.join(', ')}\n`);
      return EXIT.USAGE;
    }
  }

  let report;
  try {
    report = await audit(options);
  } catch (err) {
    process.stderr.write(`audit failed: ${(err && err.stack) || err}\n`);
    return EXIT.ERROR;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReport(report, { detail: options.detail })}\n`);
  }

  if (options.ci && report.ci.triggered) return EXIT.CI_TRIGGERED;
  return EXIT.OK;
}

module.exports = { main, parseArgs, EXIT, HELP, UsageError };
