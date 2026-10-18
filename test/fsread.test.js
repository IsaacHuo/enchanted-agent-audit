'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const F = require('../src/fsread.js');

test('credential stores are refused by name', () => {
  for (const name of ['auth.json', 'credentials.json', 'service.json', '.env', '.env.local', 'id_rsa', 'key.pem', 'x.tokens.json']) {
    assert.equal(F.isSecretFile(path.join('/home/u/.codex', name)), true, name);
  }
});

test('credential directories are refused even with an innocent file name', () => {
  assert.equal(F.isSecretFile('/home/u/.ssh/config'), true);
  assert.equal(F.isSecretFile('/home/u/project/.aws/credentials'), true);
  assert.equal(F.isSecretFile('/home/u/.codex/config.toml'), false);
});

test('secret-looking keys never carry a value', () => {
  for (const key of ['apiKey', 'api_key', 'secret', 'access_token', 'Authorization', 'client_secret', 'password']) {
    assert.equal(F.isSecretKey(key), true, key);
  }
  assert.equal(F.isSecretKey('autoupdate'), false);
});

test('readTextSafe returns null instead of reading a credential store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaa-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, '{"token":"super-secret"}');
  assert.equal(F.readTextSafe(file), null);
});

test('parseTomlShallow reads tables, arrays and scalar types', () => {
  const parsed = F.parseTomlShallow(
    ['[daemon]', 'auto_start = false', 'note = "keep # hash"', '', '[model]', 'providers = ["a", "b"]', ''].join('\n'),
  );
  assert.equal(parsed.daemon.auto_start, false);
  assert.equal(parsed.model.providers[0], 'a');
});
