'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRegValues, WIN_START_TYPES } = require('../src/platform.js');

test('registry query output parses typed values', () => {
  const text = [
    '',
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Example',
    '    DisplayName    REG_SZ    Example Service',
    '    Start    REG_DWORD    0x2',
    '    ImagePath    REG_EXPAND_SZ    C:\\Program Files\\Example\\svc.exe',
    '',
  ].join('\r\n');
  const values = parseRegValues(text);
  assert.equal(values.DisplayName.data, 'Example Service');
  assert.equal(values.Start.type, 'REG_DWORD');
  assert.equal(Number.parseInt(values.Start.data, 16), 2);
});

test('start type 2 means auto-start and is what the gate keys on', () => {
  assert.equal(WIN_START_TYPES[2], 'auto');
  assert.equal(WIN_START_TYPES[3], 'manual');
});
