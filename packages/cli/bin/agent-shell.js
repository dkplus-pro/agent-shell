#!/usr/bin/env node
// Entry point for the published bin: everything is in dist (docs/03 §1).
import("../dist/index.js")
  .then(({ main }) => main(process.argv.slice(2)))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${(error && error.stack) || (error && error.message) || String(error)}\n`);
    process.exitCode = 1;
  });
