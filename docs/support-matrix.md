# Support matrix

Status key:

- **Supported** — detection and reporting are implemented and exercised by tests
  plus a real-machine run.
- **Partial** — some questions can be answered; the rest is explicitly `unknown`.
- **Not supported** — not a target, and never guessed.

| Agent | Installed / traces | Persistent daemon | Auto-update | Version decoupling | Telemetry endpoints | Off switches | Dangerous defaults | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Codex CLI (`openai/codex`) | process, binary, config dir, Windows service | Windows service / launchd / systemd patterns; START type + live state | explicit update keys + documented default | package-manager vs side-loaded copies, documented runtime copy | config keys + static scan | documented (`--no-daemon`, `daemon_auto_start`, `app-server daemon stop`) | documented (proxy/env inheritance, self-upgrading copy) | **Supported** |
| Claude Code (`anthropics/claude-code`) | config dir only when the binary is not on PATH | none documented; service/task patterns checked | documented default + explicit keys | requires a package-manager install to compare | config keys + static scan | documented (`DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_ERROR_REPORTING`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`) | documented (telemetry switch side effects) | **Partial** |
| GitHub Copilot CLI (`github/copilot-cli`) | config dir only when the binary is not on PATH | none documented | vendor default not characterised → `unknown` | requires a package-manager install to compare | config keys + static scan | documented (`COPILOT_OFFLINE=true`) | documented (plaintext MCP OAuth tokens, managed-policy bypass) | **Partial** |
| OpenCode (`anomalyco/opencode`) | process, binary, config dirs, multiple installs | local server process, no OS service by default | explicit `autoupdate` key + documented default | npm global vs desktop/obsidian copies (observed) | config keys + static scan | documented (`autoupdate: false`, `"notify"`) | documented (config-env bypass) | **Supported** |

## Per-answer evidence

| Question | Codex | Claude Code | Copilot CLI | OpenCode |
| --- | --- | --- | --- | --- |
| Daemon detection method | registry-read + service-enum | service-enum / scheduled-task-enum | service-enum / scheduled-task-enum | service-enum / scheduled-task-enum |
| Auto-update method | file-read or documented | file-read or documented | file-read or unknown | file-read or documented |
| Decoupling method | dir-enum (inferred) or documented | dir-enum (inferred) or unknown | dir-enum (inferred) or unknown | dir-enum (inferred) |
| Telemetry method | file-read / external-doc | file-read / external-doc | file-read / external-doc | file-read / external-doc |

## Known gaps

- **Claude Code and Copilot CLI binaries are not probed beyond PATH + known
  install globs.** If they are installed somewhere unusual, the report shows
  `traces-only` or `absent` rather than guessing.
- **Telemetry endpoints shipped inside a compiled binary are not extracted.**
  Only config files and vendor docs are used. Extracting strings from binaries
  is out of scope for v1.
- **Switch effectiveness is never verified.** Every switch is labelled
  `effectVerified: false`; proving a switch works needs a runtime test that this
  tool intentionally does not perform.
- **Linux `systemctl is-enabled` is bounded to 400 units** to keep the run fast;
  units beyond that keep their earlier `startType` value.

## Non-goals

Session backup/retention/cleanup audits are explicitly out of scope. This tool
covers persistent daemons, auto-update/version pinning, telemetry endpoints and
dangerous defaults only.
