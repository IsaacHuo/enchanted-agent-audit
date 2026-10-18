# Verification record (engineer self-check)

This is the engineer's own evidence. It is **not** independent QA acceptance.
Independent verification must run against the exact commit named below.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 10.0.19045, x64 |
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| Shell | PowerShell 5.1 |
| Network used | none (the tool never makes network calls) |

## Commit under test

- Code commit: `eb662ecd3196a20a3a79847e3620d74642bc8d66`
  (`feat: read-only audit CLI for agent daemons, auto-update, telemetry`).
- Follow-up evidence commit: `cec6069328340d3148cbc05b4dfad1fc78a755fc`
  (`docs: record verification evidence and harden read-only proof`) — docs,
  frozen example timestamps, and the two dev scripts only.
- Shipped CLI code (`src/`, `bin/`), tests and fixtures are identical in both.
  QA should verify the final HEAD and treat any later docs-only commit as
  documentation, not behaviour.
- Reproduce everything below from a clean checkout:

```bash
git checkout cec6069328340d3148cbc05b4dfad1fc78a755fc
node --test
node scripts/verify-local.js
node scripts/gen-examples.js
```

## Acceptance criteria

### 1. Runs from a clean checkout, runtime recorded

```text
$ node bin/enchanted-agent-audit.js --version
0.1.0

$ node bin/enchanted-agent-audit.js --help
enchanted-agent-audit v0.1.0
...
Exit codes: 0 ok, 1 CI triggered, 2 usage error, 3 internal error.
```

No install step and no dependencies (`package.json` has no `dependencies`).

### 2. Real machine: table and JSON for every agent

```text
$ node bin/enchanted-agent-audit.js
enchanted-agent-audit v0.1.0
host: win32 10.0.19045 x64  |  generated: 2026-10-18T14:17:54.602Z
platform capability: processes=yes services=yes tasks=yes autostart=yes

Agent                Installed Daemon          Auto-update  Decoupled  Tel.
-------------------- --------- --------------- ------------ ---------- ----
Codex CLI            yes       1 auto-start    enabled*     yes*       -
Claude Code          traces    none            enabled*     unknown    -
GitHub Copilot CLI   traces    none            unknown      unknown    -
OpenCode             yes       none            enabled*     yes~       -
legend: yes/no = observed on this host; * = vendor-documented default, not measured; ~ = inferred from observed files/processes; unknown = not statically established.
```

Observed facts behind the table (from `--json`):

| Agent | Evidence level | Daemon | Auto-update | Decoupling | Install locations |
| --- | --- | --- | --- | --- | --- |
| Codex CLI | installed | `true` / `observed` / `registry-read` | `enabled` / `documented` | `true` / `documented` | 3 |
| Claude Code | traces-only | `false` / `observed` / `registry-read` | `enabled` / `documented` | `null` / `unknown` | 0 |
| GitHub Copilot CLI | traces-only | `false` / `observed` / `registry-read` | `null` / `unknown` | `null` / `unknown` | 0 |
| OpenCode | installed | `false` / `observed` / `registry-read` | `enabled` / `documented` | `true` / `inferred` | 5 |

Concrete Codex finding:

```text
persistent daemon: yes [observed/registry-read]
  - windows-service: CodexSandboxService.OpenAI.Codex (start=auto, state=running)
      ~\Program Files\WindowsApps\OpenAI.Codex_26.1013.4894.0_x64__2p2nqsd0c76g0\app\resources\codex-windows-sandbox-service.exe
```

Verified independently with the same read-only commands the tool uses:

```text
$ reg query HKLM\SYSTEM\CurrentControlSet\Services\CodexSandboxService.OpenAI.Codex
    Start    REG_DWORD    0x2

$ sc query CodexSandboxService.OpenAI.Codex
STATE              : 4  RUNNING
```

Missing/unreadable items are `unknown` with a reason; e.g. Claude Code decoupling
is `unknown` because no package-manager install of it was observed.

`platformCapabilities` records that all four enumeration paths worked on this
host. On a host where they do not, dependent findings become `unknown`
(covered by the `enumeration-unavailable` fixture).

### 3. CI mode: non-zero when detected, zero when not

Real machine (persistent daemon observed):

```text
$ node bin/enchanted-agent-audit.js --ci --quiet
...
CI: FAIL (1 reason(s))
  - codex: persistent-daemon ["windows-service:CodexSandboxService.OpenAI.Codex"]
exit code: 1
```

Deterministic scenarios (no agents installed required):

| Scenario | Fixture | Expected | Actual |
| --- | --- | --- | --- |
| Persistent auto-start service | `codex-daemon` | 1 | 1 |
| Explicitly enabled background auto-update | `autoupdate-on` | 1 | 1 |
| Auto-update explicitly disabled | `autoupdate-off` | 0 | 0 |
| Nothing installed | `clean` | 0 | 0 |

### 4. Read-only proof

```text
$ node scripts/readonly-proof.js --settle-ms 1200
read-only proof: baseline -> ambient window -> run audit -> compare

SAME  C:\Users\IsaacHuo\.codex
       files=222  ambient-writes=0  skipped-volatile=6dirs/66files
SAME  C:\Users\IsaacHuo\.claude
       files=0  ambient-writes=0  skipped-volatile=0dirs/0files
SAME  C:\Users\IsaacHuo\.copilot
       files=1  ambient-writes=0  skipped-volatile=1dirs/1files
SAME  C:\Users\IsaacHuo\.config\opencode
       files=1045  ambient-writes=0  skipped-volatile=0dirs/0files
SAME  C:\Users\IsaacHuo\.local\share\opencode
       files=218  ambient-writes=0  skipped-volatile=1dirs/793files

audit exit code: 1 (0 = clean, 1 = CI gate triggered)
verdict: PASS - no audited state was modified by the audit
```

Method: hash baseline, wait, hash again (ambient churn), run the audit, hash a
third time. Only paths that changed in the post-audit window **and** were stable
in the ambient window count against the audit.

Two categories are counted and excluded, because the agents under audit are
running and append to them continuously:

- volatile directories: `log`, `logs`, `cache`, `tmp`, `crashpad`, `GPUCache`, …;
- volatile files: SQLite databases and `-wal`/`-shm` sidecars, `.log`, `.out`,
  `.pid`, `.lock`, shell transcripts.

On this host that is 793 such files under `~/.local/share/opencode` alone, which
is exactly why a naive "hash the whole directory" check is noisy. The gap is
closed by the static proof below, which cannot be disturbed by other processes.

Independent static proof (does not depend on a quiet machine):

```text
$ node --test test/readonly-static.test.js
# shipped source contains no write/delete/rename/chmod API
# files are only opened read-only
# no mutating system command is passed to execFile
```

### 5. Support matrix and per-answer methods

[docs/support-matrix.md](support-matrix.md) lists each agent as Supported /
Partial / Not supported and states the method behind each answer. The
confidence/method vocabulary is in [docs/methodology.md](methodology.md).

### 6. Copyable CI gate + README examples

- Gate snippets: [docs/ci-gate.md](ci-gate.md) (GitHub Actions, GitLab CI,
  generic shell, plus fixture self-tests).
- Runnable workflow: `.github/workflows/ci.yml`.
- Captured outputs: `examples/table.txt`, `examples/report.json`,
  `examples/report-clean.json`, `examples/ci-fail.txt`,
  `examples/ci-fail-autoupdate.txt`, `examples/ci-pass.txt`.
- `README.md` and `README.zh-CN.md` include the table and the four exit codes.

## Test suite

```text
$ node --test
tests 32
pass 32
fail 0
```

Coverage highlights:

- finding vocabulary invariants;
- credential-store refusal and secret-key redaction (a planted secret never
  reaches the report);
- registry parsing and START-type mapping;
- Codex auto-start service → gate fails, live state `running`;
- OpenCode `autoupdate: true/false` → observed enabled/disabled;
- regression: `electron-internal-update-cdn-enabled` is **not** treated as an
  auto-update verdict;
- unavailable enumeration → `unknown`, gate stays open;
- fixture runs never fall back to the real home directory;
- ASCII-only table output on the Windows console;
- CLI exit codes 0/1/2.

## Local acceptance runner

```text
$ node scripts/verify-local.js
PASS  runtime records Node version - v24.19.0 on win32
PASS  --version exits 0 - 0.1.0
PASS  --help exits 0 and documents exit codes - help ok
PASS  default table on this machine exits 0 or 1 - 15 lines
PASS  --json is valid, schema-tagged and every finding is labelled - 4 agents, 4 installed, ci=true
PASS  --ci exit code matches report.ci.triggered - exit 1
PASS  fixture gate: persistent daemon -> 1 - exit 1
PASS  fixture gate: enabled background auto-update -> 1 - exit 1
PASS  fixture gate: auto-update disabled -> 0 - exit 0
PASS  fixture gate: nothing installed -> 0 - exit 0
PASS  read-only proof passes - 5 roots, 0 audit writes

11/11 checks passed
```

## Defects found and fixed during self-review

These were real correctness bugs, each now covered by a regression test:

1. Windows global npm packages were classified as side-loaded because
   `execFile('npm')` cannot run a `.cmd` shim. Fixed by locating the npm root
   from `.npmrc`/the default prefix instead of executing npm.
2. Codex's ~593 KB global state file was truncated at 512 KB, so JSON parsing
   failed and update keys were missed. Read bound raised to 4 MB for config
   files; bulk text scanning keeps its 512 KB cap.
3. Any non-npm process was treated as "version decoupled". Fixed: decoupling
   requires an observed package-manager install **and** a side-loaded copy, or a
   documented vendor statement.
4. The table used a non-ASCII ellipsis (mangled by the Windows console code page)
   and truncated strings that exactly filled a column. Fixed with ASCII-only
   truncation and an explicit `>` comparison.
5. A key named `electron-internal-update-cdn-enabled` was read as "auto-update
   disabled". Fixed with an explicit decision-key allowlist; adjacent keys are
   reported but never drive a verdict.
6. Fixture runs inherited the real machine's `%LOCALAPPDATA%`/`%APPDATA%` globs.
   Fixed with fixture-scoped environment and `%FIXTURE_HOME%` expansion, which
   also keeps examples free of real host paths.

## Known limitations (also reported by the tool)

- Switch effectiveness is never verified at runtime (`effectVerified: false`).
- Telemetry endpoints compiled into binaries are not extracted.
- Full Windows service enumeration needs elevation; only matched services are
  queried by name.
- Linux `systemctl is-enabled` is bounded to 400 units.
- Claude Code / Copilot CLI binaries are only looked up via PATH and known
  install globs; unusual installs appear as `traces-only` or `absent`.
