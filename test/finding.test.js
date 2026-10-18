'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { observed, inferred, documented, unknown, ev, CONFIDENCE, METHOD } = require('../src/finding.js');

test('observed/inferred/documented carry the right confidence and method', () => {
  assert.equal(observed(true, 'file-read', []).confidence, CONFIDENCE.OBSERVED);
  assert.equal(inferred(true, 'dir-enum', []).confidence, CONFIDENCE.INFERRED);
  const doc = documented('enabled', [ev('url', 'https://example.test')]);
  assert.equal(doc.confidence, CONFIDENCE.DOCUMENTED);
  assert.equal(doc.method, METHOD.EXTERNAL_DOC);
});

test('unknown always has a null value and a reason', () => {
  const u = unknown('not statically observable');
  assert.equal(u.value, null);
  assert.equal(u.confidence, CONFIDENCE.UNKNOWN);
  assert.match(u.note, /not statically observable/);
});

test('evidence pointers keep type and ref, and only add detail when present', () => {
  assert.deepEqual(ev('service', 'S'), { type: 'service', ref: 'S' });
  assert.deepEqual(ev('service', 'S', 'running'), { type: 'service', ref: 'S', detail: 'running' });
});
