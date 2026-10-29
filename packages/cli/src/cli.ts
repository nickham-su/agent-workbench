#!/usr/bin/env node
import { runCli } from "./program.js";

void runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
  // Best-effort failure output must not let either unread pipe keep the CLI alive.
  // Successful output still drains normally under Writable backpressure.
  if (code !== 0 && (process.stdout.writableLength > 0 || process.stderr.writableLength > 0)) process.exit(code);
});
