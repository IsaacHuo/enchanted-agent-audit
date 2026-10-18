'use strict';

/**
 * Cross-platform, read-only enumeration.
 *
 * Each platform adapter exposes the same four queries:
 *   listProcesses()      -> [{ name, pid, path }]
 *   listServices()       -> [{ name, displayName?, startType?, state?, imagePath? }]
 *   listScheduledTasks() -> [{ name }]
 *   listAutostart()      -> [{ scope, name, command }]
 *
 * Every query reports whether it actually worked. A query that fails (no
 * systemd, no elevation, missing binary) returns `available: false` with a
 * reason, and the caller must label dependent findings `unknown`. Nothing here
 * mutates state: only `query`/`list` style commands are used.
 */

const os = require('node:os');
const { run } = require('./exec.js');
const { listDir, exists } = require('./fsread.js');
const { expandPath, listMatches, displayPath } = require('./paths.js');

const POWERSHELL = 'powershell.exe';

function ok(items) {
  return { available: true, reason: null, items };
}

function unavailable(reason) {
  return { available: false, reason, items: [] };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const WIN_START_TYPES = {
  0: 'boot',
  1: 'system',
  2: 'auto',
  3: 'manual',
  4: 'disabled',
};

function parseRegValues(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{4}(.+?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/.exec(line);
    if (m) values[m[1].trim()] = { type: m[2], data: m[3] };
  }
  return values;
}

function windowsApi(ctx) {
  const caps = {
    processes: { available: false, method: 'process-enum', reason: null },
    services: { available: false, method: 'registry-read', reason: null },
    scheduledTasks: { available: false, method: 'scheduled-task-enum', reason: null },
    autostart: { available: false, method: 'registry-read', reason: null },
    launchd: { available: false, method: null, reason: 'not applicable on Windows' },
  };

  async function listProcesses() {
    const ps = await run(
      POWERSHELL,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process | ForEach-Object { [pscustomobject]@{ Id = $_.Id; Name = $_.ProcessName; Path = $_.Path } } | ConvertTo-Json -Compress -Depth 3',
      ],
      { timeout: 20000 },
    );
    if (ps.ok && ps.stdout.trim()) {
      try {
        const parsed = JSON.parse(ps.stdout);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        caps.processes.available = true;
        return ok(
          arr.map((p) => ({
            name: String(p.Name || ''),
            pid: Number(p.Id) || null,
            path: p.Path ? String(p.Path) : null,
          })),
        );
      } catch {
        /* fall through to tasklist */
      }
    }
    const tl = await run('tasklist.exe', ['/fo', 'csv', '/nh'], { timeout: 20000 });
    if (!tl.ok) {
      caps.processes.reason = `Get-Process and tasklist both failed (${ps.error || 'error'})`;
      return unavailable(caps.processes.reason);
    }
    caps.processes.available = true;
    caps.processes.method = 'process-enum';
    const items = [];
    for (const line of tl.stdout.split(/\r?\n/)) {
      const m = /^"([^"]*)","(\d+)"/.exec(line.trim());
      if (m) items.push({ name: m[1], pid: Number(m[2]), path: null });
    }
    caps.processes.reason = 'process paths unavailable (Get-Process failed); names only';
    return ok(items);
  }

  let serviceNamesCache = null;
  async function serviceNames() {
    if (serviceNamesCache) return serviceNamesCache;
    const res = await run('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services'], { timeout: 15000 });
    if (!res.ok) {
      serviceNamesCache = unavailable(`registry read failed (${res.error})`);
      return serviceNamesCache;
    }
    const names = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = /CurrentControlSet[\\/]Services[\\/](.+?)\s*$/i.exec(line.trim());
      if (m && m[1] && !m[1].includes('\\')) names.push(m[1]);
    }
    serviceNamesCache = ok(names);
    return serviceNamesCache;
  }

  async function listServices() {
    const names = await serviceNames();
    if (!names.available) {
      caps.services.reason = names.reason;
      return unavailable(names.reason);
    }
    caps.services.available = true;
    let stateAvailable = false;
    // `sc query` gives live state but needs elevation for full enumeration.
    const sc = await run('sc.exe', ['query', 'type=', 'service', 'state=', 'all'], { timeout: 15000 });
    const states = new Map();
    if (sc.ok) {
      stateAvailable = true;
      const blocks = sc.stdout.split(/\r?\n\r?\n/);
      for (const block of blocks) {
        const nameM = /SERVICE_NAME:\s*(\S+)/.exec(block);
        const stateM = /STATE\s*:\s*\d+\s+([A-Z_]+)/.exec(block);
        if (nameM) states.set(nameM[1], stateM ? stateM[1].toLowerCase() : null);
      }
    } else if (sc.code === 5) {
      caps.services.reason = 'live service state needs elevation; START type read from the registry instead';
    }
    caps.services.stateAvailable = stateAvailable;
    return ok(names.items.map((name) => ({ name, state: states.get(name) || null })));
  }

  async function serviceDetail(name) {
    const res = await run('reg.exe', ['query', `HKLM\\SYSTEM\\CurrentControlSet\\Services\\${name}`], { timeout: 10000 });
    if (!res.ok) return null;
    const values = parseRegValues(res.stdout);
    const start = values.Start ? Number.parseInt(values.Start.data, 16) : null;
    // `sc query <name>` works without elevation even though `sc query` over all
    // services does not, so live state is available for the few matches we need.
    let state = null;
    const sc = await run('sc.exe', ['query', name], { timeout: 8000 });
    if (sc.ok) {
      const m = /STATE\s*:\s*\d+\s+([A-Z_]+)/.exec(sc.stdout);
      if (m) {
        state = m[1].toLowerCase();
        caps.services.stateAvailable = true;
      }
    }
    return {
      name,
      displayName: values.DisplayName ? values.DisplayName.data : null,
      startType: Number.isFinite(start) ? WIN_START_TYPES[start] || `code:${start}` : null,
      imagePath: values.ImagePath ? values.ImagePath.data : null,
      objectName: values.ObjectName ? values.ObjectName.data : null,
      state,
    };
  }

  async function listScheduledTasks() {
    const res = await run('schtasks.exe', ['/query', '/fo', 'csv', '/nh'], { timeout: 25000 });
    if (!res.ok) {
      caps.scheduledTasks.reason = `schtasks failed (${res.error})`;
      return unavailable(caps.scheduledTasks.reason);
    }
    caps.scheduledTasks.available = true;
    const items = [];
    for (const raw of res.stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || !line.startsWith('"')) continue;
      const m = /^"([^"]*)"/.exec(line);
      if (!m) continue;
      const name = m[1];
      if (!name || /^taskname$/i.test(name)) continue;
      items.push({ name });
    }
    return ok(items);
  }

  async function listAutostart() {
    const items = [];
    const keys = [
      ['HKCU', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'],
      ['HKLM', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'],
      ['HKLM', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'],
    ];
    let any = false;
    for (const [scope, key] of keys) {
      const res = await run('reg.exe', ['query', key], { timeout: 10000 });
      if (!res.ok) continue;
      any = true;
      for (const line of res.stdout.split(/\r?\n/)) {
        const m = /^\s{4}(.+?)\s{4}REG_[A-Z_]+\s{4}(.*)$/.exec(line);
        if (m) items.push({ scope, name: m[1].trim(), command: m[2].trim() });
      }
    }
    const startupDirs = [
      ctx.expandPath('%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup'),
      ctx.expandPath('%PROGRAMDATA%/Microsoft/Windows/Start Menu/Programs/Startup'),
    ];
    for (const dir of startupDirs) {
      if (!dir || dir.includes('%')) continue;
      for (const entry of listDir(dir)) {
        if (entry.name.toLowerCase() === 'desktop.ini') continue;
        any = true;
        items.push({ scope: 'startup-folder', name: entry.name, command: dir });
      }
    }
    if (!any) {
      caps.autostart.reason = 'no readable autostart registry key or Startup folder';
      return unavailable(caps.autostart.reason);
    }
    caps.autostart.available = true;
    return ok(items);
  }

  return {
    capabilities: caps,
    listProcesses,
    listServices,
    serviceDetail,
    listScheduledTasks,
    listAutostart,
    async listLaunchDaemons() {
      return unavailable('not applicable on Windows');
    },
  };
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

function darwinApi(ctx) {
  const caps = {
    processes: { available: false, method: 'process-enum', reason: null },
    services: { available: false, method: 'service-enum', reason: null },
    scheduledTasks: { available: false, method: 'service-enum', reason: null },
    autostart: { available: false, method: 'dir-enum', reason: null },
    launchd: { available: false, method: 'dir-enum', reason: null },
  };

  async function listProcesses() {
    const res = await run('ps', ['-Ao', 'pid=,comm=,args='], { timeout: 10000 });
    if (!res.ok) {
      caps.processes.reason = `ps failed (${res.error})`;
      return unavailable(caps.processes.reason);
    }
    caps.processes.available = true;
    const items = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (m) items.push({ pid: Number(m[1]), name: m[2].split('/').pop(), path: m[2], args: m[3] });
    }
    return ok(items);
  }

  async function launchdEntries() {
    const dirs = [
      '~/Library/LaunchAgents',
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
      '/System/Library/LaunchAgents',
      '/System/Library/LaunchDaemons',
    ];
    const entries = [];
    for (const dir of dirs) {
      const resolved = ctx.expandPath(dir);
      if (!exists(resolved)) continue;
      for (const entry of listDir(resolved)) {
        if (entry.name.endsWith('.plist')) {
          entries.push({ name: entry.name.replace(/\.plist$/, ''), dir: resolved, scope: dir.startsWith('/Library') || dir.startsWith('/System') ? 'system' : 'user' });
        }
      }
    }
    return entries;
  }

  async function listLaunchDaemons() {
    const res = await run('launchctl', ['list'], { timeout: 10000 });
    const entries = await launchdEntries();
    const running = new Map();
    if (res.ok) {
      for (const line of res.stdout.split(/\r?\n/).slice(1)) {
        const parts = line.split(/\s+/).filter(Boolean);
        if (parts.length >= 3) running.set(parts[2], parts[0]);
      }
    }
    const combined = entries.map((e) => ({
      name: e.name,
      scope: e.scope,
      state: running.has(e.name) ? 'loaded' : 'present-on-disk',
      pid: running.get(e.name) === '-' ? null : running.get(e.name) || null,
    }));
    if (!res.ok && combined.length === 0) {
      caps.launchd.reason = 'launchctl unavailable and no launchd plist directories readable';
      return unavailable(caps.launchd.reason);
    }
    caps.launchd.available = true;
    return ok(combined);
  }

  async function listServices() {
    const res = await run('brew', ['services', 'list'], { timeout: 15000 });
    if (!res.ok) {
      caps.services.reason = 'brew services unavailable';
      return unavailable(caps.services.reason);
    }
    caps.services.available = true;
    const items = [];
    for (const line of res.stdout.split(/\r?\n/).slice(1)) {
      const parts = line.split(/\s{2,}/).filter(Boolean);
      if (parts.length >= 2) items.push({ name: parts[0], state: parts[1], startType: 'auto' });
    }
    return ok(items);
  }

  return {
    capabilities: caps,
    listProcesses,
    listServices,
    async serviceDetail() {
      return null;
    },
    async listScheduledTasks() {
      const res = await run('launchctl', ['list'], { timeout: 10000 });
      if (!res.ok) return unavailable('launchctl unavailable');
      const tasks = [];
      for (const line of res.stdout.split(/\r?\n/).slice(1)) {
        const parts = line.split(/\s+/).filter(Boolean);
        if (parts.length >= 3) tasks.push({ name: parts[2] });
      }
      return ok(tasks);
    },
    listAutostart: listLaunchDaemons,
    listLaunchDaemons,
  };
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

function linuxApi(ctx) {
  const caps = {
    processes: { available: false, method: 'process-enum', reason: null },
    services: { available: false, method: 'service-enum', reason: null },
    scheduledTasks: { available: false, method: 'scheduled-task-enum', reason: null },
    autostart: { available: false, method: 'service-enum', reason: null },
    launchd: { available: false, method: null, reason: 'not applicable on Linux' },
  };

  async function listProcesses() {
    const res = await run('ps', ['-eo', 'pid=,comm=,args='], { timeout: 10000 });
    if (!res.ok) {
      caps.processes.reason = `ps failed (${res.error})`;
      return unavailable(caps.processes.reason);
    }
    caps.processes.available = true;
    const items = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (m) items.push({ pid: Number(m[1]), name: m[2].split('/').pop(), path: m[2], args: m[3] });
    }
    return ok(items);
  }

  async function listServices() {
    const res = await run(
      'systemctl',
      ['list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend'],
      { timeout: 15000 },
    );
    const items = [];
    let any = false;
    if (res.ok) {
      any = true;
      for (const line of res.stdout.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4 && parts[0].endsWith('.service')) {
          items.push({ name: parts[0], state: parts[2], startType: parts[1] === 'enabled' ? 'auto' : 'manual' });
        }
      }
    }
    const dirs = ['/etc/systemd/system', '/usr/lib/systemd/system', '/etc/systemd/user', '~/.config/systemd/user'];
    for (const dir of dirs) {
      const resolved = ctx.expandPath(dir);
      if (!exists(resolved)) continue;
      any = true;
      for (const entry of listDir(resolved)) {
        if (entry.name.endsWith('.service')) items.push({ name: entry.name, startType: null, dir: resolved });
      }
    }
    if (!any) {
      caps.services.reason = 'systemd not available and no systemd unit directories readable';
      return unavailable(caps.services.reason);
    }
    caps.services.available = true;
    // `systemctl is-enabled` gives the persistent auto-start state on a per-unit basis.
    const uniq = [...new Map(items.map((i) => [i.name, i])).values()];
    for (const unit of uniq.slice(0, 400)) {
      if (/\.(timer|socket|mount|target)$/.test(unit.name)) continue;
      const enabled = await run('systemctl', ['is-enabled', unit.name], { timeout: 4000 });
      if (enabled.ok) {
        const v = enabled.stdout.trim();
        if (v === 'enabled' || v === 'enabled-runtime') unit.startType = 'auto';
        else if (v) unit.startType = unit.startType || 'manual';
      }
    }
    return ok(uniq);
  }

  async function listScheduledTasks() {
    const items = [];
    const res = await run('crontab', ['-l'], { timeout: 8000 });
    if (res.ok) {
      for (const line of res.stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (t && !t.startsWith('#')) items.push({ name: t });
      }
    }
    for (const dir of ['/etc/cron.d', '/etc/cron.hourly', '/etc/cron.daily']) {
      if (exists(dir)) for (const entry of listDir(dir)) items.push({ name: entry.name, dir });
    }
    if (items.length === 0) {
      caps.scheduledTasks.reason = 'no readable cron entries';
      return unavailable(caps.scheduledTasks.reason);
    }
    caps.scheduledTasks.available = true;
    return ok(items);
  }

  return {
    capabilities: caps,
    listProcesses,
    listServices,
    async serviceDetail() {
      return null;
    },
    listScheduledTasks,
    listAutostart: listServices,
    async listLaunchDaemons() {
      return unavailable('not applicable on Linux');
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture adapter
// ---------------------------------------------------------------------------

/**
 * Deterministic adapter backed by a JSON fixture. Used by tests, by the CI-gate
 * demos in `examples/`, and by anyone who needs to reproduce a gate decision on
 * a machine that does not have the agents installed. It performs no enumeration
 * and no I/O of its own: the caller passes already-captured data.
 */
function createFixturePlatform(fixture = {}) {
  const capOverrides = fixture.capabilities || {};
  const cap = (key, method, available) => ({
    available: available !== false,
    method,
    reason: available === false ? `fixture declares ${key} unavailable` : null,
  });
  const capabilities = {
    processes: { ...cap('processes', 'process-enum', capOverrides.processes), method: 'process-enum' },
    services: {
      ...cap('services', 'service-enum', capOverrides.services),
      stateAvailable: capOverrides.servicesState !== false,
    },
    scheduledTasks: cap('scheduledTasks', 'scheduled-task-enum', capOverrides.scheduledTasks),
    autostart: cap('autostart', 'registry-read', capOverrides.autostart),
    launchd: cap('launchd', 'dir-enum', capOverrides.launchd),
  };
  const answer = (key, items) =>
    capabilities[key].available ? ok(items) : unavailable(capabilities[key].reason);
  const services = fixture.services || [];
  const osPlatform = (fixture.os && fixture.os.platform) || process.platform;

  return {
    os: {
      platform: osPlatform,
      release: (fixture.os && fixture.os.release) || 'fixture',
      arch: (fixture.os && fixture.os.arch) || process.arch,
      fixture: fixture.name || 'unnamed',
    },
    capabilities,
    npmRoot: fixture.npmRoot === undefined ? null : fixture.npmRoot,
    npmRootSource: 'fixture',
    async listProcesses() {
      return answer('processes', fixture.processes || []);
    },
    async listServices() {
      return answer(
        'services',
        services.map((s) => ({ ...s })),
      );
    },
    async serviceDetail(name) {
      const found = services.find((s) => s.name === name);
      return found ? { ...found } : null;
    },
    async listScheduledTasks() {
      return answer('scheduledTasks', fixture.tasks || []);
    },
    async listAutostart() {
      return answer('autostart', fixture.autostart || []);
    },
    async listLaunchDaemons() {
      return answer('launchd', fixture.launchDaemons || []);
    },
  };
}

/** Build the platform adapter for the running OS. */
function createPlatform(home, pathMode) {
  const ctx = {
    home,
    // `pathMode` only affects display; expansion always returns a real path.
    expandPath: (p) => expandPath(p, home),
    display: (p) => displayPath(p, home, pathMode),
    listMatches: (pattern) => listMatches(pattern, home),
  };
  const api =
    process.platform === 'win32' ? windowsApi(ctx) : process.platform === 'darwin' ? darwinApi(ctx) : linuxApi(ctx);
  return {
    os: { platform: process.platform, release: os.release(), arch: os.arch() },
    ctx,
    ...api,
  };
}

module.exports = { createPlatform, createFixturePlatform, parseRegValues, WIN_START_TYPES };
