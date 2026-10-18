#!/usr/bin/env node
'use strict';

const { main, EXIT } = require('../src/main.js');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`unexpected failure: ${(err && err.stack) || err}\n`);
    process.exitCode = EXIT.ERROR;
  });
