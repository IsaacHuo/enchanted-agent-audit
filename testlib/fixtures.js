'use strict';

const { loadFixtureFile } = require('../src/fixture.js');

/**
 * Load a captured-enumeration fixture and resolve its home directory the same
 * way the CLI's `--fixture` option does.
 */
function loadFixture(name) {
  const file = require('node:path').join(__dirname, '..', 'test', 'fixtures', name, 'fixture.json');
  const { fixture, home } = loadFixtureFile(file);
  return { file, fixture, home };
}

module.exports = { loadFixture };
