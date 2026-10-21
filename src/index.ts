#!/usr/bin/env node
import * as dotenv from 'dotenv';
import { runCli } from './cli';

// Load .env here (the process entry point) rather than inside the CLI
// module, so that library use and tests never pick up a developer's local
// .env file by accident. `quiet` suppresses dotenv's start-up banner.
dotenv.config({ quiet: true });

runCli(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nUnexpected error: ${message}\n`);
    process.exitCode = 1;
  },
);
