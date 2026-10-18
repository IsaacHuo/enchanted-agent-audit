'use strict';

/**
 * Detector: turns read-only evidence gathered from the platform and the
 * filesystem into a structured, honest report.
 *
 * Rules of the house:
 *   - Nothing is reported as observed unless it was read on this machine now.
 *   - Vendor behaviour is reported as `documented` with a source URL.
 *   - Anything that could not be established is `unknown` with a reason.
 */

const os = require('node:os');
const path = require('node:path');

const { createPlatform, createFixturePlatform } = require('./platform.js');
const {
  AGENTS,
  byId,
  sourceList,
  ENDPOINT_KEY_RE,
  UPDATE_KEY_RE,
  AUTOUPDATE_DECISION_KEY_RE,
  DAEMON_KEY_RE,
} = require('./rules.js');
const { observed, inferred, documented, unknown, ev } = require('./finding.js');
const F = require('./fsread.js');
const { expandPath, displayPath, listMatches } = require('./paths.js');
const { which } = require('./exec.js');

const TOOL_VERSION = require('../package.json').version;

function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

function parseConfig(filePath) {
  const text = F.readTextSafe(filePath);
  if (text == null) return null;
  const base = path.basename(filePath).toLowerCase();
  if (base.endsWith('.json') || base.endsWith('.jsonc')) {
    if (base.endsWith('.jsonl')) return { kind: 'jsonl', data: null };
    try {
      return { kind: 'json', data: JSON.parse(stripJsonComments(text)) };
    } catch {
      return { kind: 'json', data: null, parseError: true };
    }
  }
  if (base.endsWith('.toml')) {
    const data = F.parseTomlShallow(text);
    return { kind: 'toml', data };
  }
  return { kind: 'text', data: null };
}

function sanitizeValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? `[array:${value.length}]` : '[object]';
}

/** Walk a parsed config and return dotted keys matching a regex. */
function scanKeys(data, re, out = [], prefix = '', depth = 0) {
  if (depth > 8 || data === null || typeof data !== 'object') return out;
  if (Array.isArray(data)) {
    data.forEach((item) => scanKeys(item, re, out, prefix, depth + 1));
    return out;
  }
  for (const [key, value] of Object.entries(data)) {
    if (F.isSecretKey(key)) continue;
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (re.test(key)) out.push({ key: dotted, value: sanitizeValue(value) });
    if (value && typeof value === 'object') scanKeys(value, re, out, dotted, depth + 1);
  }
  return out;
}

function matchesAny(patterns, value) {
  if (!value) return false;
  return patterns.some((re) => re.test(value));
}

const VERSION_SEGMENT_RE = /^v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)$/;

/** Known telemetry/analytics hosts worth surfacing when found in readable files. */
const TELEMETRY_HOST_RE =
  /(telemetry|statsig|sentry|posthog|segment\.io|amplitude|mixpanel|datadog|honeycomb|newrelic|open ?telemetry|otel|ingest|analytics|tracking)/i;

const SCAN_TEXT_EXT_RE = /\.(json|jsonc|toml|jsonl|ya?ml|mjs?|cjs|js|ts|md|txt|env|conf|cfg|ini)$/i;

/** Bounded, read-only scan of small text files for telemetry-looking hostnames. */
function scanTelemetryHosts(rule, home, env) {
  const found = new Map();
  const dirs = (rule.configDirs || []).map((d) => expandPath(d, home, env)).filter((d) => F.isDir(d));
  const visit = (dir, depth) => {
    if (depth > 1 || found.size >= 20) return;
    for (const entry of F.listDir(dir)) {
      if (found.size >= 20) return;
      const full = path.join(dir, entry.name);
      if (entry.dir) {
        if (/^(node_modules|cache|logs?|tmp|history|backups|sessions|storage|archived_sessions|\.git)$/i.test(entry.name)) continue;
        visit(full, depth + 1);
        continue;
      }
      if (!SCAN_TEXT_EXT_RE.test(entry.name)) continue;
      const size = F.sizeOf(full);
      if (size === null || size > 512 * 1024) continue;
      const text = F.readTextSafe(full);
      if (!text) continue;
      const matches = text.match(/https?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}[^\s"'<>)]*/gi) || [];
      for (const url of matches) {
        if (!TELEMETRY_HOST_RE.test(url)) continue;
        const key = url.replace(/["'`].*$/, '');
        if (!found.has(key)) {
          found.set(key, { url: key, file: displayPath(full, home) });
        }
      }
    }
  };
  for (const dir of dirs) visit(dir, 0);
  return [...found.values()];
}

function versionFromPath(p) {
  for (const seg of p.split(/[\\/]/).reverse()) {
    const m = VERSION_SEGMENT_RE.exec(seg);
    if (m) return m[1];
  }
  return null;
}

function readPackageJson(dir) {
  const pkgPath = path.join(dir, 'package.json');
  const text = F.readTextSafe(pkgPath);
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return { name: data.name, version: data.version };
  } catch {
    return null;
  }
}

function readNpmPrefixFromNpmrc(home) {
  const text = F.readTextSafe(path.join(home, '.npmrc'));
  if (!text) return null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * Locate the npm global package root without executing npm.
 *
 * `npm` on Windows is a .cmd shim, which `execFile` cannot run without a shell.
 * Rather than introduce a shell, we read the two sources npm itself uses: the
 * `prefix` setting in ~/.npmrc, then npm's documented default prefix. If none of
 * the candidates exist we return null and package-manager locations stay
 * unclassified (reported as unknown, never guessed).
 */
async function detectNpmRoot(home) {
  const candidates = [];
  if (process.env.ENCHANTED_NPM_ROOT) candidates.push([process.env.ENCHANTED_NPM_ROOT, 'env']);
  const npmrcPrefix = readNpmPrefixFromNpmrc(home);
  if (npmrcPrefix) candidates.push([path.join(expandPath(npmrcPrefix, home), 'node_modules'), 'npmrc-prefix']);
  if (process.env.APPDATA) candidates.push([path.join(process.env.APPDATA, 'npm', 'node_modules'), 'npm-default-prefix']);
  candidates.push([path.join(path.dirname(process.execPath), 'node_modules'), 'node-install']);
  for (const [candidate, source] of candidates) {
    const resolved = path.normalize(candidate);
    if (F.isDir(resolved)) return { path: resolved, source };
  }
  return { path: null, source: null };
}

const GENERIC_CONTAINER_RE = /^(bin|lib|plugins|node_modules|dist|out|resources|build)$/i;

/**
 * A path inside the npm global root is an installed package, not a free-standing
 * copy. Walk up to the nearest directory that actually owns a package.json so the
 * report names `@opencode/cli` instead of its `bin` folder.
 */
function normalizeInstallPath(p, npmRoot) {
  if (!p) return null;
  const norm = path.normalize(p);
  if (!npmRoot) return norm;
  const root = path.normalize(npmRoot);
  if (!norm.toLowerCase().startsWith(root.toLowerCase())) return norm;
  const rel = norm.slice(root.length).split(path.sep).filter(Boolean);
  let candidate = null;
  let acc = root;
  for (const part of rel) {
    acc = path.join(acc, part);
    if (F.isFile(path.join(acc, 'package.json'))) candidate = acc;
  }
  return candidate || norm;
}

// ---------------------------------------------------------------------------
// Per-agent detection
// ---------------------------------------------------------------------------

function collectConfigSignals(rule, home, env) {
  const files = [];
  const endpointKeys = [];
  const updateKeys = [];
  const daemonKeys = [];
  for (const rel of rule.configFiles || []) {
    const file = expandPath(rel, home, env);
    if (!F.exists(file)) {
      files.push({ path: displayPath(file, home), exists: false });
      continue;
    }
    const parsed = parseConfig(file);
    files.push({ path: displayPath(file, home), exists: true, parsed: Boolean(parsed && parsed.data) });
    if (parsed && parsed.data) {
      endpointKeys.push(...scanKeys(parsed.data, ENDPOINT_KEY_RE).map((k) => ({ ...k, file: displayPath(file, home) })));
      updateKeys.push(...scanKeys(parsed.data, UPDATE_KEY_RE).map((k) => ({ ...k, file: displayPath(file, home) })));
      daemonKeys.push(...scanKeys(parsed.data, DAEMON_KEY_RE).map((k) => ({ ...k, file: displayPath(file, home) })));
    }
  }
  return { files, endpointKeys, updateKeys, daemonKeys };
}

function buildTelemetry(rule, signals, home, env) {
  const endpoints = [];
  const otherEndpoints = [];
  const TELEMETRY_KEY_RE = /(telemetry|otel|exporter|collector|ingest|track|analytics|report|crash|sentry|statsig)/i;
  const PROVIDER_KEY_RE = /(base[_-]?url|provider|api[_-]?url|gateway|upstream)/i;
  for (const hit of signals.endpointKeys.slice(0, 40)) {
    if (typeof hit.value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(hit.value)) {
      const f = observed(
        hit.value,
        'file-read',
        [ev('config-key', `${hit.file}#${hit.key}`)],
        'endpoint-looking config value; read from a config file, not a traffic capture',
      );
      if (TELEMETRY_KEY_RE.test(hit.key)) endpoints.push({ ...f, category: 'telemetry' });
      else if (PROVIDER_KEY_RE.test(hit.key)) otherEndpoints.push({ ...f, category: 'provider' });
      else otherEndpoints.push({ ...f, category: 'unknown' });
    }
  }
  for (const doc of rule.documented.telemetry.endpoints || []) {
    endpoints.push({ ...documented(doc.url, [ev('url', doc.source || doc.url, doc.note)]), category: 'telemetry' });
  }
  const switches = (rule.documented.telemetry.switches || []).map((s) =>
    documented(
      { name: s.name, kind: s.kind, effectVerified: false },
      sourceList(rule.documented.telemetry.sources),
      `${s.note} This tool does not verify the switch actually takes effect at runtime.`,
    ),
  );
  const staticScanHosts = scanTelemetryHosts(rule, home, env).map((hit) => ({
    ...observed(hit.url, 'file-read', [ev('file', hit.file)], 'host matched telemetry keywords in a readable file; this is a static text match, not a traffic capture'),
    category: 'static-scan',
  }));
  return {
    endpoints,
    otherEndpoints,
    staticScanHosts,
    disableSwitches: switches,
    configSignals: signals.endpointKeys.slice(0, 40).map((k) => ({ key: k.key, value: k.value, file: k.file })),
    networkTrafficObserved: false,
    note: 'No network traffic is captured or inspected. Endpoints are configuration/documentation only.',
  };
}

function leafKey(dotted) {
  return String(dotted).split('.').pop();
}

/** Interpret an explicit auto-update config value; null means "not understood". */
function interpretUpdateValue(value) {
  if (value === false) return 'disabled';
  if (value === true) return 'enabled';
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (/^(false|off|disabled|none|never)$/.test(v)) return 'disabled';
    if (v === 'notify') return 'notify';
    if (/^(true|on|enabled|auto|always)$/.test(v)) return 'enabled';
  }
  return null;
}

function buildAutoUpdate(rule, signals, installLocations, runningFromSideLoaded, runningEvidence) {
  const configured = signals.updateKeys.slice(0, 40).map((k) => ({
    key: k.key,
    value: k.value,
    file: k.file,
    decidesAutoUpdate: AUTOUPDATE_DECISION_KEY_RE.test(leafKey(k.key)),
  }));
  const decision = configured.find((k) => k.decidesAutoUpdate);

  let status;
  if (decision) {
    const verdict = interpretUpdateValue(decision.value);
    if (verdict) {
      status = observed(
        verdict,
        'file-read',
        [ev('config-key', `${decision.file}#${decision.key}`, String(decision.value))],
        'explicit auto-update setting read from a config file; whether it takes effect at runtime is not verified',
      );
    } else {
      status = unknown(`auto-update key ${decision.key} has a value this tool does not interpret: ${JSON.stringify(decision.value)}`);
    }
  } else if (rule.documented.autoUpdate.defaultStatus === 'enabled') {
    status = documented(
      'enabled',
      sourceList(rule.documented.autoUpdate.sources),
      'vendor default; no explicit local override found in readable config',
    );
  } else if (rule.documented.autoUpdate.defaultStatus === 'disabled') {
    status = documented(
      'disabled',
      sourceList(rule.documented.autoUpdate.sources),
      'vendor default; no explicit local override found in readable config',
    );
  } else {
    status = unknown('no explicit auto-update setting found and the vendor default is not documented');
  }

  const pm = installLocations.filter((l) => l.kind === 'package-manager');
  const side = installLocations.filter((l) => l.kind === 'sideloaded');
  let decoupled;
  if (pm.length > 0 && side.length > 0) {
    const evidence = [...pm, ...side].map((l) => ev('dir', l.path, l.kind));
    if (runningFromSideLoaded) evidence.push(...runningEvidence);
    decoupled = inferred(
      true,
      'dir-enum',
      evidence,
      runningFromSideLoaded
        ? 'a running process executes from a side-loaded copy while a package-manager install of the same agent also exists'
        : 'a package-manager install and at least one side-loaded copy of the same agent were both observed',
    );
  } else if (pm.length > 0) {
    decoupled = inferred(
      false,
      'dir-enum',
      pm.map((l) => ev('dir', l.path, l.kind)),
      'only package-manager install locations were observed for this agent',
    );
  } else if (rule.documented.versionDecoupling) {
    decoupled = documented(
      true,
      sourceList(rule.documented.versionDecoupling.sources),
      rule.documented.versionDecoupling.summary,
    );
  } else {
    decoupled = unknown('no package-manager install was observed, so decoupling could not be measured');
  }

  const background = status.confidence === 'observed' ? status.value === 'enabled' : null;

  return {
    status,
    backgroundAutoUpdate: background,
    decoupledFromPackageManager: decoupled,
    configuredKeys: configured,
    installLocations,
    documented: {
      summary: rule.documented.autoUpdate.summary,
      switches: (rule.documented.autoUpdate.switches || []).map((s) =>
        documented({ name: s.name, kind: s.kind, effectVerified: false }, sourceList(rule.documented.autoUpdate.sources), s.note),
      ),
      sources: sourceList(rule.documented.autoUpdate.sources),
    },
  };
}

function buildDaemons(rule, platformData, home) {
  const entries = [];
  const notes = [];
  const serviceMethod = platformData.serviceMethod || 'service-enum';
  const persistenceMethod = platformData.persistenceMethod || serviceMethod;

  for (const svc of platformData.matchedServices) {
    const evidence = [ev(serviceMethod === 'registry-read' ? 'registry' : 'service', svc.name)];
    if (svc.state) evidence.push(ev('service-state', svc.name, svc.state));
    entries.push({
      kind: platformData.serviceKind,
      name: svc.name,
      displayName: svc.displayName || null,
      startType: svc.startType || null,
      state: svc.state || null,
      imagePath: svc.imagePath ? displayPath(svc.imagePath, home) : null,
      objectName: svc.objectName || null,
      confidence: 'observed',
      method: serviceMethod,
      evidence,
    });
  }
  for (const task of platformData.matchedTasks) {
    entries.push({
      kind: 'scheduled-task',
      name: task.name,
      startType: 'scheduled',
      state: null,
      confidence: 'observed',
      method: platformData.taskMethod,
      evidence: [ev('task', task.name)],
    });
  }
  for (const auto of platformData.matchedAutostart) {
    entries.push({
      kind: 'autostart',
      name: auto.name,
      displayName: null,
      startType: 'logon',
      state: null,
      imagePath: auto.command || null,
      confidence: 'observed',
      method: 'registry-read',
      evidence: [ev('autostart', `${auto.scope}:${auto.name}`, auto.command)],
    });
  }

  const persistent = entries.filter((e) => e.startType === 'auto' || e.startType === 'scheduled' || e.startType === 'logon' || e.state === 'loaded');

  let persistenceDetected;
  if (persistent.length > 0) {
    persistenceDetected = observed(
      true,
      persistenceMethod,
      persistent.map((e) => ev('service', e.name, e.startType || e.state)),
      'persistent auto-start or scheduled entry matched this agent',
    );
  } else if (platformData.servicesAvailable === false && platformData.tasksAvailable === false) {
    persistenceDetected = unknown('service and scheduled-task enumeration both unavailable on this platform/session');
  } else {
    persistenceDetected = observed(false, persistenceMethod, [], 'enumeration succeeded and no matching persistent entry was found');
  }

  if (rule.documented.daemon.persistence && !/^none/i.test(rule.documented.daemon.persistence)) {
    notes.push(`Vendor documentation: ${rule.documented.daemon.persistence}.`);
  }
  return {
    persistenceDetected,
    entries,
    documented: {
      summary: rule.documented.daemon.summary,
      switches: (rule.documented.daemon.switches || []).map((s) =>
        documented({ name: s.name, kind: s.kind, effectVerified: false }, sourceList(rule.documented.daemon.sources), s.note),
      ),
      sources: sourceList(rule.documented.daemon.sources),
    },
    notes,
  };
}

async function detectAgent(rule, ctx) {
  const { home, platform, processes, services, tasks, autostart, launchDaemons, npmRoot, pathEnv } = ctx;
  const signals = collectConfigSignals(rule, home, pathEnv);

  const matchedProcesses = processes.filter((p) => matchesAny(rule.processPatterns, p.name) || matchesAny(rule.processPatterns, p.path ? path.basename(p.path) : ''));
  const matchedServices = services.filter((s) => matchesAny(rule.servicePatterns, s.name) || matchesAny(rule.servicePatterns, s.displayName || ''));
  // enrich matched services with start type / image path where possible
  const enrichedServices = [];
  for (const svc of matchedServices) {
    if (platform.serviceDetail && (svc.startType == null || svc.imagePath == null)) {
      const detail = await platform.serviceDetail(svc.name);
      enrichedServices.push(detail ? { ...svc, ...detail } : svc);
    } else {
      enrichedServices.push(svc);
    }
  }
  const matchedTasks = tasks.filter((t) => matchesAny(rule.taskPatterns, t.name));
  const matchedAutostart = autostart.filter((a) => matchesAny(rule.autostartPatterns, a.name) || matchesAny(rule.autostartPatterns, a.command || ''));
  const matchedLaunch = launchDaemons.filter((l) => matchesAny(rule.servicePatterns, l.name));

  const serviceEntries = enrichedServices.concat(
    matchedLaunch.map((l) => ({ name: l.name, startType: l.state === 'loaded' ? 'auto' : null, state: l.state, scope: l.scope })),
  );

  const configDirPresent = (rule.configDirs || []).some((d) => F.isDir(expandPath(d, home, pathEnv)));
  let binaryPath = null;
  if (!ctx.isFixture) {
    for (const bin of rule.binaries) {
      // eslint-disable-next-line no-await-in-loop
      const found = await which(bin);
      if (found) {
        binaryPath = found;
        break;
      }
    }
  }

  const installLocations = [];
  const sideAbs = [];
  const seen = new Set();
  const addLocation = (rawPath, sourceLabel) => {
    const p = normalizeInstallPath(rawPath, npmRoot);
    if (!p) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    if (npmRoot) {
      const root = npmRoot.toLowerCase();
      if (key === root) return;
      // The npm prefix itself (the folder holding npm.cmd) is not an install.
      if (root.startsWith(key.endsWith(path.sep) ? key : key + path.sep)) return;
    }
    if (GENERIC_CONTAINER_RE.test(path.basename(p)) && !F.isFile(path.join(p, 'package.json'))) return;
    seen.add(key);
    const pkg = readPackageJson(p);
    const kind = npmRoot && key.startsWith(npmRoot.toLowerCase()) ? 'package-manager' : 'sideloaded';
    if (kind === 'sideloaded') sideAbs.push(p);
    installLocations.push({
      path: displayPath(p, home),
      kind,
      version: (pkg && pkg.version) || versionFromPath(p) || null,
      source: sourceLabel,
    });
  };
  for (const pattern of [...(rule.installGlobs || []), ...(rule.versionedGlobs || [])]) {
    for (const p of listMatches(pattern, home, pathEnv)) addLocation(p, 'install-glob');
  }
  for (const p of matchedProcesses) {
    if (p.path) addLocation(path.dirname(p.path), 'running-process');
  }
  if (binaryPath) addLocation(path.dirname(binaryPath), 'path-binary');

  const isUnder = (child, parent) => {
    const c = path.normalize(child).toLowerCase();
    const p = path.normalize(parent).toLowerCase();
    return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
  };
  const runningSideLoaded = matchedProcesses.filter((p) => p.path && sideAbs.some((sp) => isUnder(p.path, sp)));
  const runningFromSideLoaded = runningSideLoaded.length > 0;
  const runningEvidence = runningSideLoaded.map((p) => ev('process', displayPath(p.path, home), `pid ${p.pid}`));

  const detectionSignals = [];
  if (matchedProcesses.length) detectionSignals.push(ev('process', matchedProcesses.map((p) => p.name).join(', ')));
  if (binaryPath) detectionSignals.push(ev('binary', displayPath(binaryPath, home)));
  if (configDirPresent) detectionSignals.push(ev('dir', rule.configDirs.join(', ')));
  if (serviceEntries.length) detectionSignals.push(ev('service', serviceEntries.map((s) => s.name).join(', ')));
  if (matchedTasks.length) detectionSignals.push(ev('task', matchedTasks.map((t) => t.name).join(', ')));
  if (matchedAutostart.length) detectionSignals.push(ev('autostart', matchedAutostart.map((a) => a.name).join(', ')));

  const installed = detectionSignals.length > 0;
  // Anything that proves the agent is actually present (process, binary, service,
  // scheduled task, autostart) counts as installed; a bare config directory is
  // only a trace of a past/partial install.
  const strongEvidence =
    matchedProcesses.length > 0 ||
    Boolean(binaryPath) ||
    serviceEntries.length > 0 ||
    matchedTasks.length > 0 ||
    matchedAutostart.length > 0;
  const evidenceLevel = strongEvidence ? 'installed' : installed ? 'traces-only' : 'absent';

  const osPlatform = (platform.os && platform.os.platform) || process.platform;
  const isWindows = osPlatform === 'win32';
  const daemons = buildDaemons(
    rule,
    {
      matchedServices: serviceEntries,
      serviceKind: isWindows ? 'windows-service' : osPlatform === 'darwin' ? 'launchd' : 'systemd',
      serviceMethod: isWindows ? 'registry-read' : 'service-enum',
      persistenceMethod: isWindows ? 'registry-read' : 'service-enum',
      matchedTasks,
      taskMethod: isWindows ? 'scheduled-task-enum' : 'service-enum',
      matchedAutostart,
      servicesAvailable: ctx.servicesAvailable,
      tasksAvailable: ctx.tasksAvailable,
    },
    home,
  );

  const telemetry = buildTelemetry(rule, signals, home, pathEnv);
  const autoUpdate = buildAutoUpdate(rule, signals, installLocations, runningFromSideLoaded, runningEvidence);

  const dangerousDefaults = (rule.documented.dangerousDefaults || []).map((d) => ({
    id: d.id,
    description: d.description,
    status: 'documented',
    sources: sourceList(d.sources),
  }));

  return {
    id: rule.id,
    name: rule.name,
    vendor: rule.vendor,
    homepage: rule.homepage,
    installed,
    evidenceLevel,
    detection: { configDirPresent, binaryPath: binaryPath ? displayPath(binaryPath, home) : null, signals: detectionSignals },
    daemons,
    autoUpdate,
    telemetry,
    dangerousDefaults,
    configFiles: signals.files,
    limitations: rule.limitations || [],
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function audit(options = {}) {
  const home = options.home || os.homedir();
  const pathMode = options.pathMode || 'home-relative';
  const only = options.only && options.only.length ? new Set(options.only) : null;

  const platform = options.fixture ? createFixturePlatform(options.fixture) : createPlatform(home, pathMode);
  const [processesRes, servicesRes, tasksRes, autostartRes, launchRes] = await Promise.all([
    platform.listProcesses(),
    platform.listServices(),
    platform.listScheduledTasks(),
    platform.listAutostart(),
    platform.listLaunchDaemons(),
  ]);
  // A fixture declares the npm root it wants; a real run discovers it.
  const npmInfo =
    platform.npmRoot !== undefined
      ? { path: platform.npmRoot, source: platform.npmRootSource || 'fixture' }
      : await detectNpmRoot(home);
  const npmRoot = npmInfo.path;

  const ctx = {
    home,
    platform,
    processes: processesRes.items,
    services: servicesRes.items,
    tasks: tasksRes.items,
    autostart: autostartRes.items,
    launchDaemons: launchRes.items,
    npmRoot,
    isFixture: Boolean(options.fixture),
    pathEnv: (options.fixture && options.fixture.env) || process.env,
    servicesAvailable: servicesRes.available,
    tasksAvailable: tasksRes.available,
  };

  const selected = AGENTS.filter((a) => !only || only.has(a.id));
  const agents = [];
  for (const rule of selected) {
    // eslint-disable-next-line no-await-in-loop
    agents.push(await detectAgent(rule, ctx));
  }

  const ciReasons = [];
  for (const agent of agents) {
    if (agent.daemons.persistenceDetected && agent.daemons.persistenceDetected.value === true) {
      const kinds = agent.daemons.entries
        .filter((e) => e.startType === 'auto' || e.startType === 'scheduled' || e.startType === 'logon' || e.state === 'loaded')
        .map((e) => `${e.kind}:${e.name}`);
      ciReasons.push({ agent: agent.id, kind: 'persistent-daemon', detail: kinds });
    }
    if (agent.autoUpdate.status && agent.autoUpdate.status.confidence === 'observed' && agent.autoUpdate.status.value === 'enabled') {
      const keys = agent.autoUpdate.configuredKeys.filter((k) => k.decidesAutoUpdate).map((k) => `${k.file}#${k.key}`);
      ciReasons.push({ agent: agent.id, kind: 'background-auto-update', detail: keys });
    }
  }

  return {
    schema: 'enchanted.agent-audit/v1',
    tool: { name: 'enchanted-agent-audit', version: TOOL_VERSION },
    generatedAt: new Date().toISOString(),
    host: { ...platform.os, pathMode },
    platformCapabilities: {
      processes: platform.capabilities.processes,
      services: { ...platform.capabilities.services, stateAvailable: platform.capabilities.services.stateAvailable ?? null },
      scheduledTasks: platform.capabilities.scheduledTasks,
      autostart: platform.capabilities.autostart,
      launchd: platform.capabilities.launchd,
    },
    installEnumeration: {
      npmGlobalRoot: npmRoot ? displayPath(npmRoot, home) : null,
      npmGlobalRootSource: npmInfo.source,
      note: 'Used only to tell package-manager installs apart from side-loaded copies of the same agent.',
    },
    agents,
    summary: {
      agentsChecked: agents.length,
      installed: agents.filter((a) => a.installed).map((a) => a.id),
      tracesOnly: agents.filter((a) => a.evidenceLevel === 'traces-only').map((a) => a.id),
      persistentDaemons: ciReasons.filter((r) => r.kind === 'persistent-daemon').map((r) => r.agent),
      backgroundAutoUpdate: ciReasons.filter((r) => r.kind === 'background-auto-update').map((r) => r.agent),
    },
    ci: {
      triggered: ciReasons.length > 0,
      reasons: ciReasons,
      policy:
        'Non-zero when an observed persistent auto-start daemon or an observed enabled background auto-update is found. Documented-only defaults never fail the gate.',
    },
  };
}

module.exports = { audit, stripJsonComments, scanKeys, versionFromPath };
