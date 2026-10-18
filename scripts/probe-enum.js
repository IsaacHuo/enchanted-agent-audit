const { run } = require('../src/exec.js');
(async () => {
  const tests = [
    ['sc-query-all', 'sc.exe', ['query', 'type=', 'service', 'state=', 'all']],
    ['sc-query-one', 'sc.exe', ['query', 'codex-windows-sandbox-service']],
    ['powershell-cim', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Service | Where-Object { $_.Name -match "codex|opencode|copilot|claude" } | Select-Object Name,State,StartMode,PathName | ConvertTo-Json -Compress']],
    ['tasklist', 'tasklist.exe', ['/fo', 'csv', '/nh']],
    ['schtasks', 'schtasks.exe', ['/query', '/fo', 'csv', '/nh']],
  ];
  for (const [name, cmd, args] of tests) {
    const started = Date.now();
    const res = await run(cmd, args, { timeout: 25000 });
    const dt = Date.now() - started;
    console.log(`### ${name}: ok=${res.ok} code=${res.code} err=${res.error} ${dt}ms outBytes=${res.stdout.length}`);
    console.log(res.stdout.split(/\r?\n/).slice(0, 6).join('\n'));
    if (res.stderr) console.log('STDERR:', res.stderr.slice(0, 300));
  }
})();
