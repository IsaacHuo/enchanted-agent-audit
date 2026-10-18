# enchanted-agent-audit

A zero-dependency, **read-only** CLI that audits what coding-agent CLIs install
and run on your machine. One command answers four questions for each detected
agent (Codex CLI, Claude Code, GitHub Copilot CLI, OpenCode):

1. **Persistent daemons** — services, launchd jobs, scheduled tasks, autostart
   entries that start on their own, and how they are persisted.
2. **Auto-update and version decoupling** — background update behaviour, and
   whether the running backend has drifted away from the package-manager version.
3. **Telemetry** — endpoints that can be read statically, plus the documented off
   switches and whether their effect is verified (it is not).
4. **Dangerous defaults** — documented vendor/user-reported footguns, each with a
   source URL.

中文说明：[README.zh-CN.md](README.zh-CN.md)

## What it never does

- Never modifies, stops, uninstalls, or writes to audited state.
- Never uses the network, never needs an account.
- Never reads credential contents (`auth.json`, `service.json`, `.env*`,
  `*.tokens.json`, keys, `.ssh`, `.aws` are refused before opening).
- Never claims to have observed network traffic or runtime loading.
- Never guesses: anything it cannot establish is `unknown` with a reason.

Two independent checks back this up:

```bash
npm test                          # includes a static "no write API" test
node scripts/readonly-proof.js    # hash before -> run audit -> hash after
```

## Requirements

- Node.js **>= 18.13** (developed and verified on Node v24.19.0, Windows 10).
- No dependencies, no install step required.

## Quick start

```bash
git clone https://github.com/IsaacHuo/enchanted-agent-audit.git
cd enchanted-agent-audit
node bin/enchanted-agent-audit.js
```

Or, once published: `npx enchanted-agent-audit`.

```text
$ node bin/enchanted-agent-audit.js
enchanted-agent-audit v0.1.0
host: win32 10.0.19045 x64  |  generated: 2026-10-18T14:08:01.067Z
platform capability: processes=yes services=yes tasks=yes autostart=yes

Agent                Installed Daemon          Auto-update  Decoupled  Tel.
-------------------- --------- --------------- ------------ ---------- ----
Codex CLI            yes       1 auto-start    enabled*     yes*       -
Claude Code          traces    none            enabled*     unknown    -
GitHub Copilot CLI   traces    none            unknown      unknown    -
OpenCode             yes       none            enabled*     yes~       -
legend: yes/no = observed on this host; * = vendor-documented default, not measured; ~ = inferred from observed files/processes; unknown = not statically established.

[Codex CLI] OpenAI - https://github.com/openai/codex
  installed: true (installed); detection: process, dir, service
  persistent daemon: yes [observed/registry-read] - persistent auto-start or scheduled entry matched this agent
    - windows-service: CodexSandboxService.OpenAI.Codex (start=auto, state=running) [observed/registry-read]
        ~\Program Files\WindowsApps\OpenAI.Codex_...\app\resources\codex-windows-sandbox-service.exe
  auto-update: enabled [documented/external-doc] - vendor default; no explicit local override found in readable config
  version decoupled from package manager: yes [documented] - The platform package (~374MB) is copied into ~/.codex/packages ...
    - install: ~\AppData\Local\OpenAI\Codex (sideloaded)
    - install: ~\AppData\Local\OpenAI\Codex\bin\896a0166b774037a (sideloaded)
  telemetry endpoints: 0 (no traffic capture)
  known dangerous defaults (documented):
    - daemon-inherits-first-session-env: ...
      source: https://github.com/openai/codex/issues/48195

CI: FAIL (1 reason(s))
  - codex: persistent-daemon ["windows-service:CodexSandboxService.OpenAI.Codex"]
```

The full captured outputs live in [`examples/`](examples/).

## Options

| Option | Description |
| --- | --- |
| `--json` | Full structured report (`enchanted.agent-audit/v1`). |
| `--table` | Human-readable table (default). |
| `--ci` | Exit `1` when an observed persistent daemon or enabled background auto-update is found. |
| `--only <ids>` | Restrict to agents: `codex,claude-code,copilot-cli,opencode`. |
| `--home <dir>` | Audit an alternative home directory. |
| `--fixture <file>` | Replay captured enumeration data instead of querying this machine. Deterministic CI demo. |
| `--paths raw` | Print absolute paths instead of `~`-relative ones. |
| `--quiet` | Table only, no per-agent detail. |
| `--version`, `--help` | Version / usage. |

## JSON shape

```json
{
  "schema": "enchanted.agent-audit/v1",
  "tool": { "name": "enchanted-agent-audit", "version": "0.1.0" },
  "host": { "platform": "win32", "release": "10.0.19045", "arch": "x64" },
  "platformCapabilities": { "processes": {}, "services": {}, "scheduledTasks": {}, "autostart": {}, "launchd": {} },
  "installEnumeration": { "npmGlobalRoot": "~\\AppData\\Roaming\\npm\\node_modules", "npmGlobalRootSource": "npm-default-prefix" },
  "agents": [
    {
      "id": "codex",
      "installed": true,
      "evidenceLevel": "installed",
      "daemons": { "persistenceDetected": {}, "entries": [], "documented": {} },
      "autoUpdate": { "status": {}, "decoupledFromPackageManager": {}, "installLocations": [] },
      "telemetry": { "endpoints": [], "staticScanHosts": [], "disableSwitches": [], "networkTrafficObserved": false },
      "dangerousDefaults": [],
      "limitations": []
    }
  ],
  "summary": { "agentsChecked": 4, "installed": [], "persistentDaemons": [], "backgroundAutoUpdate": [] },
  "ci": { "triggered": true, "reasons": [], "policy": "..." }
}
```

Every finding object carries `value`, `confidence` (`observed` | `inferred` |
`documented` | `unknown`), `method`, optional `evidence[]`, and optional `note`.
See [docs/methodology.md](docs/methodology.md).

## CI gate

```bash
node bin/enchanted-agent-audit.js --ci
```

Exit `0` = clean, `1` = observed persistent daemon or enabled background
auto-update, `2` = usage error, `3` = internal error.

Copy-paste workflows for GitHub Actions, GitLab CI and generic shells are in
[docs/ci-gate.md](docs/ci-gate.md). The gate self-test needs no agent installs:

```bash
node bin/enchanted-agent-audit.js --fixture test/fixtures/codex-daemon/fixture.json --ci   # -> 1
node bin/enchanted-agent-audit.js --fixture test/fixtures/autoupdate-off/fixture.json --ci # -> 0
```

## Support matrix

| Agent | Status | Notes |
| --- | --- | --- |
| Codex CLI | Supported | Real Windows service, versioned side-loaded runtime, documented switches. |
| Claude Code | Partial | Config traces only when the binary is not on PATH; telemetry/update switches documented, not verified. |
| GitHub Copilot CLI | Partial | Config traces only; auto-update default is `unknown` because it is not documented. |
| OpenCode | Supported | Multiple decoupled installs, `autoupdate` config key, documented bypass. |

Full matrix and per-answer methods: [docs/support-matrix.md](docs/support-matrix.md).

## Development

```bash
npm test                          # 32 tests, fixtures only
npm run examples                  # regenerate examples/ from fixtures
npm run readonly-proof            # runtime read-only proof
```

Tests use captured enumeration fixtures and never read the real home directory,
so they are deterministic on a clean CI runner.

## License

MIT. See [LICENSE](LICENSE).
