# Methodology: what a finding means

This tool exists to answer four questions about a coding agent, without trusting
the agent's own claims and without touching its state:

1. Does it install something that starts on its own (service, launchd job,
   scheduled task, autostart entry)?
2. Does it update itself in the background, and has the running copy drifted
   away from the package-manager version?
3. Which telemetry endpoints and off switches can be read statically?
4. Which dangerous defaults are documented by the vendor or reported by users?

Every value in the report carries two labels.

## `confidence`

| Value | Meaning | Example |
| --- | --- | --- |
| `observed` | Read from this machine during this run. | A Windows service whose registry `Start` value is `0x2` (auto). |
| `inferred` | Derived from observed facts by a stated rule. | A package-manager install **and** a side-loaded copy of the same agent both exist, therefore the running copy may be decoupled. |
| `documented` | From a cited vendor doc or user report. Not measured here. | "Auto-update is on by default." |
| `unknown` | Could not be established statically. Carries a reason and a `null` value. | Service enumeration denied and no registry fallback on this platform. |

Rules:

- `unknown` is a first-class answer, never a guessed `false`.
- A `documented` fact is never promoted to `observed` because the tool "knows"
  the vendor behaviour. The label tells you whether it is your machine or a
  citation.
- CI decisions only use `observed` values. A documented default never fails a
  build, because it does not prove anything about the machine being audited.

## `method`

| Value | How the value was obtained |
| --- | --- |
| `file-read` | A config/state file was read (bounded, secret-redacted, read-only). |
| `dir-enum` | Directory listing / path glob resolution. |
| `registry-read` | Windows registry `reg query` (services, Run keys). |
| `process-enum` | Process table (`Get-Process`, `ps`). |
| `service-enum` | `sc query`, `systemctl`, `launchctl`, `brew services`. |
| `scheduled-task-enum` | `schtasks`, `crontab`, systemd timers. |
| `external-doc` | Cited external source only. |
| `not-observed` | Nothing was obtained; see the `note`. |

## What this tool does not claim

- **No network traffic is captured or inspected.** Endpoint findings are config
  values or static text matches in readable files. The report says
  `networkTrafficObserved: false`.
- **No runtime loading is observed.** The tool does not attach to the agent,
  read its memory, or prove that a config key takes effect. Switches are
  reported with `effectVerified: false`.
- **No credential contents are read.** Files matching credential-store names
  (`auth.json`, `service.json`, `.env*`, `*.tokens.json`, keys, `.ssh`, `.aws`)
  are refused before opening. Secret-looking keys (`token`, `apiKey`, …) are
  dropped from parsed configs. Tests assert that a planted secret never reaches
  the report.
- **No mutation.** The shipped source contains no write/delete/rename/chmod API
  and no mutating system command; `test/readonly-static.test.js` enforces this.

## Read-only proof

Two independent checks:

1. **Static:** shipped source contains no write API and only `openSync(..., 'r')`.
2. **Runtime:** `node scripts/readonly-proof.js` hashes the audited directories,
   waits for an ambient-churn window, runs the audit, and hashes again. Paths
   that changed in the ambient window are excluded, so the verdict is about the
   audit only. Volatile log/cache directories that the running agents append to
   are reported as `skipped-volatile-dirs`.

Actual result on Windows 10 (Node v24.19.0) is recorded in the task evidence and
in `docs/verification.md`.

## Platform behaviour

| Platform | Processes | Services | Auto-start | Notes |
| --- | --- | --- | --- | --- |
| Windows | `Get-Process`, `tasklist` fallback | `reg query` for names + START type; targeted `sc query <name>` for live state | `schtasks`, HKCU/HKLM Run keys, Startup folders | Full `sc query` over all services needs elevation; only *matched* services are queried by name. |
| macOS | `ps` | `launchctl list` + plist directories | launchd plists (user/system), brew services | A plist on disk is reported as `present-on-disk` unless `launchctl list` shows it loaded. |
| Linux | `ps` | `systemctl list-units` + unit directories, `systemctl is-enabled` per unit | systemd units, user units, cron | Missing systemd/cron is reported as `available: false`, which turns dependent findings into `unknown`. |

When enumeration fails, the report says so in `platformCapabilities` and the
affected finding becomes `unknown`. It never falls back to "probably not there".

## Telemetry scan bounds

- Only `configDirs` for each agent, depth <= 1, skipping `logs`, `cache`, `tmp`,
  `history`, `sessions`, `storage` and `node_modules`.
- Only text-like files up to 512 KB.
- URLs must match a telemetry keyword (`telemetry`, `statsig`, `sentry`,
  `otel`, `ingest`, `analytics`, …).
- Results are labelled `observed/file-read` **and** described as a static text
  match, not a traffic capture.
