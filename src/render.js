'use strict';

/**
 * Human-readable rendering. The table is intentionally narrow; the detail
 * sections carry the evidence and confidence labels.
 */

function pad(text, width) {
  const s = String(text ?? '');
  // ASCII-only truncation: an ellipsis character is mangled by the legacy
  // Windows console code page, and `>=` used to truncate strings that exactly
  // filled the column (e.g. "GitHub Copilot CLI").
  if (s.length > width) return `${s.slice(0, Math.max(0, width - 2))}..`;
  return s + ' '.repeat(width - s.length);
}

function badge(finding) {
  if (!finding) return 'unknown';
  if (finding.confidence === 'unknown') return 'unknown';
  const v = finding.value;
  if (v === true) return 'yes';
  if (v === false) return 'no';
  return String(v);
}

function daemonCell(agent) {
  const det = agent.daemons.persistenceDetected;
  if (!det || det.confidence === 'unknown') return 'unknown';
  if (det.value === false) return 'none';
  const names = agent.daemons.entries
    .filter((e) => e.startType === 'auto' || e.startType === 'scheduled' || e.startType === 'logon' || e.state === 'loaded')
    .map((e) => e.name);
  return names.length ? `${names.length} auto-start` : 'detected';
}

function endpointCell(agent) {
  const n = agent.telemetry.endpoints.length;
  return n === 0 ? '-' : `${n}`;
}

/** Table cell with an explicit provenance marker. */
function statusCell(finding) {
  if (!finding || finding.confidence === 'unknown') return 'unknown';
  const label = badge(finding);
  if (finding.confidence === 'documented') return `${label}*`;
  if (finding.confidence === 'inferred') return `${label}~`;
  return label;
}

function renderTable(report) {
  const cols = [
    ['Agent', 20],
    ['Installed', 9],
    ['Daemon', 15],
    ['Auto-update', 12],
    ['Decoupled', 10],
    ['Tel.', 4],
  ];
  const lines = [];
  lines.push(cols.map(([h, w]) => pad(h, w)).join(' '));
  lines.push(cols.map(([, w]) => '-'.repeat(w)).join(' '));
  for (const agent of report.agents) {
    const row = [
      pad(agent.name, cols[0][1]),
      pad(agent.installed ? (agent.evidenceLevel === 'traces-only' ? 'traces' : 'yes') : 'no', cols[1][1]),
      pad(daemonCell(agent), cols[2][1]),
      pad(statusCell(agent.autoUpdate.status), cols[3][1]),
      pad(statusCell(agent.autoUpdate.decoupledFromPackageManager), cols[4][1]),
      pad(endpointCell(agent), cols[5][1]),
    ];
    lines.push(row.join(' '));
  }
  return lines.join('\n');
}

function bullets(items, indent = '    ') {
  return items.map((i) => `${indent}- ${i}`).join('\n');
}

function renderDetail(report) {
  const blocks = [];
  for (const agent of report.agents) {
    if (!agent.installed && agent.evidenceLevel === 'absent') {
      blocks.push(`\n[${agent.name}] not detected on this machine.`);
      continue;
    }
    const b = [];
    b.push(`\n[${agent.name}] ${agent.vendor} - ${agent.homepage}`);
    b.push(`  installed: ${agent.installed} (${agent.evidenceLevel}); detection: ${agent.detection.signals.map((s) => s.type).join(', ') || 'none'}`);
    if (agent.detection.binaryPath) b.push(`  binary: ${agent.detection.binaryPath}`);

    const det = agent.daemons.persistenceDetected;
    b.push(`  persistent daemon: ${badge(det)} [${det.confidence}/${det.method}]${det.note ? ` - ${det.note}` : ''}`);
    for (const e of agent.daemons.entries) {
      b.push(`    - ${e.kind}: ${e.name} (start=${e.startType || 'unknown'}, state=${e.state || 'unknown'}) [${e.confidence}/${e.method}]`);
      if (e.imagePath) b.push(`        ${e.imagePath}`);
    }

    const au = agent.autoUpdate;
    b.push(`  auto-update: ${badge(au.status)} [${au.status.confidence}/${au.status.method}]${au.status.note ? ` - ${au.status.note}` : ''}`);
    b.push(`  version decoupled from package manager: ${badge(au.decoupledFromPackageManager)} [${au.decoupledFromPackageManager.confidence}]${au.decoupledFromPackageManager.note ? ` - ${au.decoupledFromPackageManager.note}` : ''}`);
    for (const loc of au.installLocations) {
      b.push(`    - install: ${loc.path} (${loc.kind}${loc.version ? `, v${loc.version}` : ''})`);
    }
    if (au.configuredKeys.length) {
      for (const k of au.configuredKeys) {
        const note = k.decidesAutoUpdate ? '' : ' (adjacent key; not treated as an auto-update switch)';
        b.push(`    - config: ${k.file}#${k.key} = ${JSON.stringify(k.value)}${note}`);
      }
    }
    if (au.documented.switches.length) {
      b.push('    documented update switches (effect not verified):');
      for (const s of au.documented.switches) b.push(`      - ${s.value.name} (${s.value.kind})`);
    }

    b.push(`  telemetry endpoints: ${agent.telemetry.endpoints.length} (no traffic capture)`);
    for (const e of agent.telemetry.endpoints.slice(0, 12)) {
      b.push(`    - ${e.value} [${e.confidence}/${e.method}]`);
    }
    if (agent.telemetry.otherEndpoints.length) {
      b.push(`  other configured endpoints (provider/unknown, not telemetry): ${agent.telemetry.otherEndpoints.length}`);
      for (const e of agent.telemetry.otherEndpoints.slice(0, 12)) {
        b.push(`    - ${e.value} (${e.category}) [${e.confidence}]`);
      }
    }
    if (agent.telemetry.staticScanHosts && agent.telemetry.staticScanHosts.length) {
      b.push('  telemetry-looking hosts found in config files (static text match, not traffic):');
      for (const e of agent.telemetry.staticScanHosts.slice(0, 12)) {
        b.push(`    - ${e.value} [${e.confidence}/${e.method}]`);
      }
    }
    if (agent.telemetry.disableSwitches.length) {
      b.push('  telemetry disable switches (effect not verified):');
      for (const s of agent.telemetry.disableSwitches) b.push(`    - ${s.value.name} (${s.value.kind})`);
    }

    if (agent.dangerousDefaults.length) {
      b.push('  known dangerous defaults (documented):');
      for (const d of agent.dangerousDefaults) {
        b.push(`    - ${d.id}: ${d.description}`);
        if (d.sources && d.sources.length) b.push(`      source: ${d.sources[0].url}`);
      }
    }
    if (agent.limitations.length) {
      b.push('  limitations:');
      b.push(bullets(agent.limitations, '      '));
    }
    blocks.push(b.join('\n'));
  }
  return blocks.join('\n');
}

function renderReport(report, options = {}) {
  const out = [];
  out.push(`enchanted-agent-audit v${report.tool.version}`);
  out.push(`host: ${report.host.platform} ${report.host.release} ${report.host.arch}  |  generated: ${report.generatedAt}`);
  const caps = report.platformCapabilities;
  out.push(
    `platform capability: processes=${caps.processes.available ? 'yes' : 'no'} services=${caps.services.available ? 'yes' : 'no'}` +
      `${caps.services.available && caps.services.stateAvailable === false ? ' (no live service state read)' : ''}` +
      ` tasks=${caps.scheduledTasks.available ? 'yes' : 'no'} autostart=${caps.autostart.available ? 'yes' : 'no'}`,
  );
  if (report.summary.installed.length === 0) out.push('No target agent was detected on this machine.');
  out.push('');
  out.push(renderTable(report));
  out.push('legend: yes/no = observed on this host; * = vendor-documented default, not measured; ~ = inferred from observed files/processes; unknown = not statically established.');
  if (options.detail !== false) out.push(renderDetail(report));
  out.push('');
  if (report.ci.triggered) {
    out.push(`CI: FAIL (${report.ci.reasons.length} reason(s))`);
    for (const r of report.ci.reasons) out.push(`  - ${r.agent}: ${r.kind} ${JSON.stringify(r.detail)}`);
  } else {
    out.push('CI: PASS (no observed persistent daemon or background auto-update)');
  }
  return out.join('\n');
}

module.exports = { renderReport, renderTable, renderDetail, pad };
