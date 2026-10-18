'use strict';

/**
 * Read-only command execution helper.
 *
 * Every external command this tool runs is a *query*: file listing, process
 * listing, service/task enumeration. We never pass user-controlled strings and
 * never use a shell, so there is no injection surface and no way to accidentally
 * mutate system state through quoting.
 */

const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Run a read-only command and always resolve (never reject).
 * @returns {Promise<{ok:boolean, code:number|null, error:string|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
function run(cmd, args = [], options = {}) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : DEFAULT_TIMEOUT_MS;
  const maxBuffer = Number.isFinite(options.maxBuffer) ? options.maxBuffer : DEFAULT_MAX_BUFFER;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      execFile(
        cmd,
        args,
        { timeout, maxBuffer, windowsHide: true, encoding: 'utf8', shell: false },
        (err, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : '';
          const errOut = typeof stderr === 'string' ? stderr : '';
          if (err) {
            const timedOut = Boolean(err.killed) || err.signal === 'SIGTERM';
            let error = 'error';
            if (timedOut) error = 'timeout';
            else if (err.code === 'ENOENT') error = 'not-found';
            else if (err.code === 'EACCES' || err.code === 'EPERM') error = 'permission-denied';
            done({
              ok: false,
              code: typeof err.code === 'number' ? err.code : null,
              error,
              stdout: out,
              stderr: errOut,
              timedOut,
            });
          } else {
            done({ ok: true, code: 0, error: null, stdout: out, stderr: errOut, timedOut: false });
          }
        },
      );
    } catch (e) {
      done({
        ok: false,
        code: null,
        error: 'spawn-failed',
        stdout: '',
        stderr: String((e && e.message) || e),
        timedOut: false,
      });
    }
  });
}

/** True when a command exists on PATH (query only). */
async function which(cmd) {
  const isWin = process.platform === 'win32';
  const finder = isWin ? 'where.exe' : 'which';
  const res = await run(finder, [cmd], { timeout: 4000 });
  if (!res.ok) return null;
  const first = res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return first || null;
}

module.exports = { run, which };
