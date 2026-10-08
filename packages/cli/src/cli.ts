#!/usr/bin/env node
import { runCli } from "./program.js";

void runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
