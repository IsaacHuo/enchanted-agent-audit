#!/usr/bin/env node
'use strict';

/**
 * Read-only proof.
 *
 * Takes a baseline manifest, waits briefly, takes a second baseline to measure
 * ambient churn (other agent processes may be writing logs right now), then runs
 * the CLI and takes a third manifest. Any path that changed between the second
 * baseline and the post-audit manifest AND was stable during the ambient window
 * was changed by the audit. The run fails if such a path exists.
 *
 * Content hashes cover files up to 1 MB. Larger files and credential stores are
 * compared by size + mtime only; their contents are deliberately never read.
 *
 * Usage:
 *   node scripts/readonly-proof.js
 *   node scripts/readonly-proof.js --root ~/.codex --root ~/.config/opencode
 *   node scripts/readonly-proof.js --json
 *   node scripts/readonly-proof.js -- <extra cli args>
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { isSecretFile } = require('../src/fsread.js');

const BIN = path.join(__dirname, '..', 'bin', 'enchanted-agent-audit.js');
const MAX_DEPTH = 3;
const MAX_FILES = 2000;
const MAX_CONTENT_BYTES = 1024 * 1024;

/**
 * Directories that the running agents themselves append to (session logs, caches).
 * They are excluded from the runtime comparison because an unrelated live process
 * writes them continuously; `test/readonly-static.test.js` proves separately that
 * the audit source contains no write API at all.
 */
const VOLATILE_DIR_RE = /^(logs?|tmp|temp|cache|caches|crashpad|gpucache|code cache|daemon)$/i;

/**
 * Files that belong to a running process rather than to configuration: SQLite
 * WAL/SHM sidecars, databases, logs, shell transcripts, pid/lock files. The
 * agents being audited (including the one running this proof) append to these
 * continuously, so they cannot attribute a change to the audit. They are counted
 * and excluded; `test/readonly-static.test.js` proves separately that the shipped
 * source contains no write API at all.
 */
const VOLATILE_FILE_RE = /(\.(sqlite3?|db|log|out|pid|lock|tmp)$|-(wal|shm)$)/i;
const VOLATILE_PATH_RE = /(^|[\\/])(shell|logs?|cache|caches|tmp|temp|crashpad|gpucache|code cache)([\\/]|$)/i;

function parseArgs(argv) {
  const options = { roots: [], json: false, settleMs: 1000, cliArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      options.cliArgs = argv.slice(i + 1);
      break;
    } else if (arg === '--root') {
      const value = argv[++i];
      if (!value) throw new Error('--root requires a directory');
      options.roots.push(value);
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--settle-ms') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) throw new Error('--settle-ms requires a non-negative number');
      options.settleMs = value;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function defaultRoots() {
  const home = os.homedir();
  return ['~/.codex', '~/.claude', '~/.copilot', '~/.config/opencode', '~/.local/share/opencode'].map((p) =>
    path.join(home, p.slice(2)),
  );
}

function expandRoot(root) {
  if (root === '~') return os.homedir();
  if (root.startsWith('~/') || root.startsWith('~\\')) return path.join(os.homedir(), root.slice(2));
  return path.resolve(root);
}

/** Build a deterministic manifest of a directory tree. */
function manifest(root) {
  const files = [];
  const byPath = new Map();
  let truncated = false;
  let skippedVolatileDirs = 0;
  let skippedVolatileFiles = 0;
  const walk = (dir, depth) => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        if (VOLATILE_DIR_RE.test(entry.name)) {
          skippedVolatileDirs += 1;
          continue;
        }
        if (depth < MAX_DEPTH) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (VOLATILE_FILE_RE.test(entry.name) || VOLATILE_PATH_RE.test(rel)) {
        skippedVolatileFiles += 1;
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      const record = { path: rel, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
      const readable = stat.size <= MAX_CONTENT_BYTES && !isSecretFile(full);
      if (readable) {
        try {
          record.sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        } catch {
          record.sha256 = null;
        }
      }
      files.push(record);
      byPath.set(rel, record);
    }
  };
  if (fs.existsSync(root)) walk(root, 0);
  const digest = crypto.createHash('sha256');
  for (const f of files) digest.update(`${f.path}\0${f.size}\0${f.mtimeMs}\0${f.sha256 || ''}\n`);
  return {
    root,
    exists: fs.existsSync(root),
    fileCount: files.length,
    truncated,
    skippedVolatileDirs,
    skippedVolatileFiles,
    digest: digest.digest('hex'),
    byPath,
  };
}

function fingerprint(record) {
  return record ? `${record.size}\0${record.mtimeMs}\0${record.sha256 || ''}` : null;
}

/** Paths that differ between two manifests. */
function diffPaths(a, b) {
  const out = new Set();
  for (const [p, record] of a.byPath) {
    if (fingerprint(record) !== fingerprint(b.byPath.get(p))) out.add(p);
  }
  for (const p of b.byPath.keys()) {
    if (!a.byPath.has(p)) out.add(p);
  }
  return out;
}

function runAudit(cliArgs) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, '--quiet', '--ci', ...cliArgs], {
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
    });
    return { code: 0, bytes: stdout.length };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : null,
      bytes: typeof err.stdout === 'string' ? err.stdout.length : 0,
      error: err.message,
    };
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const roots = (options.roots.length ? options.roots : defaultRoots()).map(expandRoot);
  const existing = roots.filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });

  const beforeA = existing.map(manifest);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.settleMs);
  const beforeB = existing.map(manifest);
  const audit = runAudit(options.cliArgs);
  const after = existing.map(manifest);

  const rows = existing.map((root, i) => {
    const ambient = diffPaths(beforeA[i], beforeB[i]);
    const postAudit = diffPaths(beforeB[i], after[i]);
    const byAudit = [...postAudit].filter((p) => !ambient.has(p));
    return {
      root,
      fileCount: beforeA[i].fileCount,
      truncated: beforeA[i].truncated,
      skippedVolatileDirs: beforeA[i].skippedVolatileDirs,
      skippedVolatileFiles: beforeA[i].skippedVolatileFiles,
      digestBefore: beforeA[i].digest,
      digestAfter: after[i].digest,
      ambientChangedPaths: ambient.size,
      changedByAudit: byAudit,
      unchanged: byAudit.length === 0,
    };
  });
  const unchanged = rows.every((r) => r.unchanged) && audit.code !== null && audit.code <= 1;

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          command: `node bin/enchanted-agent-audit.js --quiet --ci ${options.cliArgs.join(' ')}`.trim(),
          auditExitCode: audit.code,
          settleMs: options.settleMs,
          roots: rows,
          unchanged,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write('read-only proof: baseline -> ambient window -> run audit -> compare\n\n');
    for (const r of rows) {
      process.stdout.write(`${r.unchanged ? 'SAME' : 'CHANGED'}  ${r.root}\n`);
      process.stdout.write(
        `       files=${r.fileCount}${r.truncated ? ' (capped)' : ''}  ambient-writes=${r.ambientChangedPaths}` +
          `  skipped-volatile=${r.skippedVolatileDirs}dirs/${r.skippedVolatileFiles}files\n`,
      );
      process.stdout.write(`       digest before=${r.digestBefore}\n`);
      process.stdout.write(`       digest after =${r.digestAfter}\n`);
      if (r.changedByAudit.length) process.stdout.write(`       changed by audit: ${r.changedByAudit.join(', ')}\n`);
    }
    if (rows.length === 0) process.stdout.write('no audited directories exist on this machine\n');
    process.stdout.write(`\naudit exit code: ${audit.code} (0 = clean, 1 = CI gate triggered)\n`);
    process.stdout.write(
      `verdict: ${unchanged ? 'PASS - no audited state was modified by the audit' : 'FAIL - audited state changed or the audit errored'}\n`,
    );
  }
  return unchanged ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`readonly-proof failed: ${(err && err.message) || err}\n`);
    process.exitCode = 3;
  }
}

module.exports = { manifest, diffPaths };
