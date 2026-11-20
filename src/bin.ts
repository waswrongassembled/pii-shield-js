#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // Name only: a message may quote request data.
    process.stderr.write(`pii-shield: unexpected ${e instanceof Error ? e.name : 'error'}\n`);
    process.exitCode = 1;
  },
);
