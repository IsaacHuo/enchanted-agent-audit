'use strict';

/**
 * Per-agent knowledge base.
 *
 * Two kinds of information live here and are kept strictly separate:
 *   1. Detection rules  - where to look on disk / in processes / in services.
 *   2. Documented facts - vendor-documented behaviour and cited user issues.
 *
 * Documented facts are NEVER emitted as observations. They are attached to a
 * report as `documented` findings with a source URL so a reader can tell the
 * difference between "we saw this on your machine" and "the vendor says this".
 */

const SOURCES = {
  codexDaemonIssue: {
    url: 'https://github.com/openai/codex/issues/48195',
    title: 'Codex CLI starts a persistent, self-updating background daemon by default',
  },
  codexWindowsFlashes: {
    url: 'https://github.com/openai/codex/issues/48074',
    title: 'Windows regressions caused by the default daemon',
  },
  codexUpdaterRestart: {
    url: 'https://github.com/openai/codex/issues/51763',
    title: 'Auto-update restarts the backend mid-session',
  },
  codexHnThread: {
    url: 'https://news.ycombinator.com/item?id=50060694',
    title: 'HN discussion: package-manager updates vs a self-updating daemon',
  },
  claudeTelemetryIssue: {
    url: 'https://github.com/anthropics/claude-code/issues/45381',
    title: 'DISABLE_TELEMETRY silently broke the 1-hour prompt cache TTL',
  },
  claudeUpdaterIssue: {
    url: 'https://github.com/anthropics/claude-code/issues/52192',
    title: 'DISABLE_AUTOUPDATER is weaker than DISABLE_UPDATES',
  },
  claudeEnvDocs: {
    url: 'https://code.claude.com/docs/en/env-vars',
    title: 'Claude Code environment variables reference',
  },
  copilotTelemetryIssue: {
    url: 'https://github.com/github/copilot-cli/issues/3387',
    title: 'Add option to disable sending usage telemetry',
  },
  copilotPlaintextTokens: {
    url: 'https://github.com/github/copilot-cli/issues/2783',
    title: 'Copilot CLI writes MCP OAuth tokens in plaintext JSON on disk',
  },
  copilotManagedPolicy: {
    url: 'https://github.com/github/copilot-cli/issues/4782',
    title: 'Desktop client ignores enterprise-managed telemetry policy',
  },
  copilotOfflineDocs: {
    url: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli',
    title: 'COPILOT_OFFLINE=true disables telemetry (and also GitHub auth)',
  },
  opencodeConfigDocs: {
    url: 'https://opencode.ai/docs/config',
    title: 'OpenCode autoupdate config option',
  },
  opencodeAutoupdateEnvBug: {
    url: 'https://github.com/anomalyco/opencode/issues/21083',
    title: 'autoupdate ignored when set via OPENCODE_CONFIG / OPENCODE_CONFIG_DIR',
  },
};

/** Keys whose presence in a config file suggest an endpoint/host setting. */
const ENDPOINT_KEY_RE = /(url|endpoint|host|exporter|otel|telemetry|collector|ingest)/i;

/** Keys that describe auto-update behaviour. */
const UPDATE_KEY_RE = /(autoupdate|auto[_-]?update|update[_-]?check|updater|internal[_-]?update)/i;

/**
 * Only these leaf keys actually decide whether auto-update runs. Adjacent keys
 * such as Codex's `electron-internal-update-cdn-enabled` describe a CDN, not the
 * update policy, and must never be promoted into an enabled/disabled verdict.
 */
const AUTOUPDATE_DECISION_KEY_RE =
  /^(auto[_-]?update|update[_-]?check|disable[_-]?auto[_-]?updater?|disable[_-]?updates?|updates?)$/i;

/** Keys that describe a daemon/service. */
const DAEMON_KEY_RE = /(daemon|service|background|autostart|auto[_-]?start|keepalive)/i;

const AGENTS = [
  {
    id: 'codex',
    name: 'Codex CLI',
    vendor: 'OpenAI',
    homepage: 'https://github.com/openai/codex',
    binaries: ['codex'],
    configDirs: ['~/.codex'],
    configFiles: ['~/.codex/config.toml', '~/.codex/.codex-global-state.json'],
    processPatterns: [/^codex(\.exe)?$/i, /^codex(-|$)/i, /codex-code-mode-host/i, /codex-windows-sandbox-service/i],
    servicePatterns: [/codex/i, /openai/i],
    taskPatterns: [/codex/i, /openai/i],
    autostartPatterns: [/codex/i, /openai/i],
    installGlobs: [
      '~/.codex/packages',
      '%LOCALAPPDATA%/OpenAI/Codex',
      '%LOCALAPPDATA%/OpenAI/Codex/bin/*',
      '%LOCALAPPDATA%/Programs/OpenAI/Codex',
    ],
    versionedGlobs: ['%LOCALAPPDATA%/OpenAI/Codex/bin/*', '~/.codex/packages/*'],
    documented: {
      daemon: {
        summary:
          'Since 0.157.0 Codex starts a persistent, self-updating background daemon by default; daemon_auto_start is not opt-in.',
        persistence: 'a per-platform installer service (systemd / launchd / Windows service)',
        sources: ['codexDaemonIssue', 'codexWindowsFlashes'],
        switches: [
          { name: '--no-daemon', kind: 'flag', note: 'Documented CLI escape hatch; verified to exist, effect not verified by this tool.' },
          { name: 'daemon_auto_start = false', kind: 'config', note: 'Reported in config.toml; whether it fully prevents daemon start is not verified here.' },
          { name: 'codex app-server daemon stop', kind: 'command', note: 'Stops a running daemon but does not change the default for new sessions.' },
        ],
      },
      autoUpdate: {
        summary:
          'A detached updater checks 5 minutes after start and hourly thereafter and can restart the backend mid-conversation.',
        sources: ['codexDaemonIssue', 'codexUpdaterRestart'],
        defaultStatus: 'enabled',
        switches: [],
      },
      versionDecoupling: {
        summary:
          'The platform package (~374MB) is copied into ~/.codex/packages and the backend runs from that copy, decoupled from the package manager.',
        sources: ['codexDaemonIssue', 'codexHnThread'],
      },
      telemetry: {
        summary:
          'Codex supports OpenTelemetry export and ships no single documented cross-cutting telemetry kill switch equivalent to DISABLE_TELEMETRY.',
        endpoints: [],
        sources: ['codexDaemonIssue'],
        switches: [],
      },
      dangerousDefaults: [
        {
          id: 'daemon-inherits-first-session-env',
          description:
            "The daemon pins the first session's proxy/environment variables, so later sessions silently inherit the wrong network configuration.",
          sources: ['codexDaemonIssue'],
        },
        {
          id: 'self-upgrading-package-copy',
          description:
            'The backend runs from a user-directory copy that upgrades itself, so the running version drifts from the package-manager version.',
          sources: ['codexDaemonIssue'],
        },
      ],
    },
    limitations: [
      'Full Windows service enumeration needs elevation; this tool reads START type from the registry and queries only matched services by name, so live state is available for matched services but an unreadable service is reported unknown.',
    ],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    homepage: 'https://github.com/anthropics/claude-code',
    binaries: ['claude'],
    configDirs: ['~/.claude', '~/.config/claude'],
    configFiles: ['~/.claude/settings.json', '~/.claude.json'],
    processPatterns: [/^claude(\.exe)?$/i, /claude-code/i],
    servicePatterns: [/claude/i],
    taskPatterns: [/claude/i],
    autostartPatterns: [/claude/i],
    installGlobs: ['~/.local/bin', '~/.claude/local', '~/.claude/versions'],
    versionedGlobs: ['~/.claude/versions/*'],
    documented: {
      daemon: {
        summary: 'Vendor documentation describes auto-update and telemetry but no persistent OS daemon installed by default.',
        persistence: 'none documented',
        sources: ['claudeEnvDocs'],
        switches: [],
      },
      autoUpdate: {
        summary:
          'Auto-update is on by default through a native updater; DISABLE_AUTOUPDATER=1 is cumulative with, and weaker than, DISABLE_UPDATES=1.',
        sources: ['claudeUpdaterIssue', 'claudeEnvDocs'],
        defaultStatus: 'enabled',
        switches: [
          { name: 'DISABLE_AUTOUPDATER=1', kind: 'env', note: 'Documented but strictly weaker than DISABLE_UPDATES.' },
          { name: 'DISABLE_UPDATES=1', kind: 'env', note: 'Blocks all update paths including manual update (v2.1.118+).' },
          { name: 'autoUpdatesChannel', kind: 'config', note: 'Selects latest vs beta channel; does not disable updates.' },
        ],
      },
      telemetry: {
        summary:
          'Telemetry/error reporting is on by default and gated by DISABLE_TELEMETRY / DO_NOT_TRACK / DISABLE_ERROR_REPORTING; disabling it once silently broke the 1-hour prompt cache TTL.',
        endpoints: [],
        sources: ['claudeTelemetryIssue', 'claudeEnvDocs'],
        switches: [
          { name: 'DISABLE_TELEMETRY=1', kind: 'env', note: 'Known to have side effects on unrelated behaviour (#45381).' },
          { name: 'DO_NOT_TRACK=1', kind: 'env', note: 'Community convention honoured by Claude Code.' },
          { name: 'DISABLE_ERROR_REPORTING=1', kind: 'env', note: 'Disables error reporting only.' },
          { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', kind: 'env', note: 'Disables auto-updates, telemetry, error reporting and release-note checks (v2.1.281+).' },
          { name: 'CLAUDE_CODE_ENABLE_TELEMETRY=1', kind: 'env', note: 'Enables OpenTelemetry export (opposite direction).' },
        ],
      },
      dangerousDefaults: [
        {
          id: 'telemetry-switch-side-effects',
          description:
            'DISABLE_TELEMETRY also silently disabled the 1-hour prompt cache TTL, so the documented off switch changes unrelated behaviour.',
          sources: ['claudeTelemetryIssue'],
        },
      ],
    },
    limitations: [
      'Vendor telemetry endpoints are not statically verified by this tool; they are reported as unknown unless present in your config or vendor docs.',
    ],
  },
  {
    id: 'copilot-cli',
    name: 'GitHub Copilot CLI',
    vendor: 'GitHub',
    homepage: 'https://github.com/github/copilot-cli',
    binaries: ['copilot', 'github-copilot', 'copilot-cli'],
    configDirs: ['~/.copilot'],
    configFiles: ['~/.copilot/config.json', '~/.copilot/settings.json'],
    credentialArtifacts: ['~/.copilot/mcp-oauth-config'],
    processPatterns: [/^copilot(\.exe)?$/i, /copilot-cli/i],
    servicePatterns: [/copilot/i],
    taskPatterns: [/copilot/i],
    autostartPatterns: [/copilot/i],
    installGlobs: ['%APPDATA%/npm/node_modules/@github/copilot', '~/.local/share/copilot'],
    versionedGlobs: [],
    documented: {
      daemon: {
        summary: 'No persistent OS daemon is documented for Copilot CLI.',
        persistence: 'none documented',
        sources: [],
        switches: [],
      },
      autoUpdate: {
        summary: 'Copilot CLI ships an auto-update path; the exact background behaviour is not documented in the cited sources.',
        sources: [],
        defaultStatus: 'unknown',
        switches: [],
      },
      telemetry: {
        summary:
          'Usage telemetry is sent to GitHub by default. There is no plain settings flag; users have asked for one (#3387). COPILOT_OFFLINE=true disables telemetry but also disables GitHub auth and requires a BYOK provider.',
        endpoints: [],
        sources: ['copilotTelemetryIssue', 'copilotOfflineDocs'],
        switches: [
          { name: 'COPILOT_OFFLINE=true', kind: 'env', note: 'Disables all telemetry, but also GitHub auth; needs a BYOK/local provider.' },
        ],
      },
      dangerousDefaults: [
        {
          id: 'plaintext-oauth-tokens',
          description:
            'MCP OAuth tokens are written as plaintext JSON under ~/.copilot/mcp-oauth-config/*.tokens.json (existence is reported; contents are never read).',
          sources: ['copilotPlaintextTokens'],
        },
        {
          id: 'desktop-ignores-managed-telemetry-policy',
          description: 'The desktop client has been reported to ignore enterprise-managed telemetry policy.',
          sources: ['copilotManagedPolicy'],
        },
      ],
    },
    limitations: ['Copilot CLI switches are partly undocumented; unverified switches are reported as documented-but-effect-unknown.'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    vendor: 'OpenCode (anomalyco)',
    homepage: 'https://github.com/anomalyco/opencode',
    binaries: ['opencode', 'opencode2'],
    configDirs: ['~/.config/opencode', '~/.local/share/opencode'],
    configFiles: [
      '~/.config/opencode/opencode.json',
      '~/.config/opencode/opencode.jsonc',
      '~/.local/share/opencode/opencode.json',
    ],
    processPatterns: [/^opencode(\.exe)?$/i, /opencode-cli/i],
    servicePatterns: [/opencode/i],
    taskPatterns: [/opencode/i],
    autostartPatterns: [/opencode/i],
    installGlobs: [
      '~/.obsidian-copilot/opencode/*',
      '%LOCALAPPDATA%/Programs/@opencode-aidesktop',
      '%APPDATA%/ai.opencode.desktop',
    ],
    versionedGlobs: ['~/.obsidian-copilot/opencode/*', '%APPDATA%/ai.opencode.desktop/cli/*'],
    documented: {
      daemon: {
        summary:
          'OpenCode runs a local server process (opencode serve) and its desktop build ships a local service; no OS-level auto-start daemon is documented.',
        persistence: 'local server process (not an OS service by default)',
        sources: ['opencodeConfigDocs'],
        switches: [],
      },
      autoUpdate: {
        summary:
          'Auto-update is controlled by the global `autoupdate` config key (true | false | "notify"); it does not apply to package-manager installs, and is ignored when set through OPENCODE_CONFIG / OPENCODE_CONFIG_DIR.',
        sources: ['opencodeConfigDocs', 'opencodeAutoupdateEnvBug'],
        defaultStatus: 'enabled',
        switches: [
          { name: 'autoupdate: false', kind: 'config', note: 'Global config only; ignored for package-manager installs.' },
          { name: 'autoupdate: "notify"', kind: 'config', note: 'Notify without installing.' },
        ],
      },
      telemetry: {
        summary: 'No vendor-documented telemetry kill switch was found; reported as unknown rather than guessed.',
        endpoints: [],
        sources: [],
        switches: [],
      },
      dangerousDefaults: [
        {
          id: 'autoupdate-env-bypass',
          description:
            'Setting autoupdate via OPENCODE_CONFIG / OPENCODE_CONFIG_DIR is ignored, so a config that looks pinned can still auto-upgrade.',
          sources: ['opencodeAutoupdateEnvBug'],
        },
      ],
    },
    limitations: ['opencode may run several differently-versioned installs side by side; each is reported separately.'],
  },
];

function byId(id) {
  return AGENTS.find((a) => a.id === id) || null;
}

function sourceList(keys) {
  return (keys || []).map((k) => ({ key: k, ...SOURCES[k] })).filter((s) => s.url);
}

module.exports = { AGENTS, SOURCES, ENDPOINT_KEY_RE, UPDATE_KEY_RE, AUTOUPDATE_DECISION_KEY_RE, DAEMON_KEY_RE, byId, sourceList };
