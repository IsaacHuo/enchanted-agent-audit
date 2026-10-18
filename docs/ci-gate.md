# CI gate

The gate fails only on **observed** evidence:

- a persistent auto-start daemon/service/scheduled task/autostart entry, or
- an explicitly enabled background auto-update read from a config file.

Documented vendor defaults never fail the gate. Unreadable or unavailable
enumeration produces `unknown` and does not fail the gate.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Audit ran; no observed persistent daemon or enabled background auto-update. |
| `1` | CI gate triggered (a finding was observed). |
| `2` | Usage error (bad flag, unknown agent id, unreadable fixture). |
| `3` | Internal error. |

## GitHub Actions

```yaml
name: agent-runtime-audit

on:
  push:
  pull_request:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Run audit
        run: node bin/enchanted-agent-audit.js --ci
      - name: Upload JSON report
        if: always()
        run: node bin/enchanted-agent-audit.js --json > agent-audit.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: agent-audit
          path: agent-audit.json
```

## GitLab CI

```yaml
agent-audit:
  image: node:22
  script:
    - node bin/enchanted-agent-audit.js --ci
  artifacts:
    when: always
    paths:
      - agent-audit.json
  after_script:
    - node bin/enchanted-agent-audit.js --json > agent-audit.json || true
```

## Generic shell / pre-commit

```bash
node bin/enchanted-agent-audit.js --ci || {
  echo "Persistent agent daemon or background auto-update detected."
  echo "Re-run with --json for evidence and confidence labels."
  exit 1
}
```

## Deterministic gate self-test (no agent installs required)

Fixtures replay captured enumeration data, so the gate logic can be tested on a
clean CI runner:

```bash
# exit 1: auto-start Windows service for Codex
node bin/enchanted-agent-audit.js --fixture test/fixtures/codex-daemon/fixture.json --ci

# exit 1: explicitly enabled OpenCode auto-update, no daemon
node bin/enchanted-agent-audit.js --fixture test/fixtures/autoupdate-on/fixture.json --ci

# exit 0: auto-update explicitly disabled
node bin/enchanted-agent-audit.js --fixture test/fixtures/autoupdate-off/fixture.json --ci

# exit 0: nothing installed
node bin/enchanted-agent-audit.js --fixture test/fixtures/clean/fixture.json --ci
```

`npm test` asserts all four outcomes, plus:
- enumeration unavailable → `unknown`, gate stays open;
- a non-decision key (`electron-internal-update-cdn-enabled`) never becomes an
  "auto-update disabled" verdict.

## Reading a failure

```text
CI: FAIL (1 reason(s))
  - codex: persistent-daemon ["windows-service:CodexSandboxService.OpenAI.Codex"]
```

The JSON report has the full evidence pointer:

```json
{
  "agent": "codex",
  "kind": "persistent-daemon",
  "detail": ["windows-service:CodexSandboxService.OpenAI.Codex"]
}
```

For per-finding evidence, use `--json` and read `agents[].daemons.entries[]`
(`startType`, `state`, `imagePath`, `method`, `evidence`).
