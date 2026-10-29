import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { parseFollowOptions, FollowLifetime } from "../src/follow-lifetime.js";
import { runCli } from "../src/program.js";
import { captureIO } from "./helpers.js";

test("A-HELP-LAYERS/PRIORITY: all follow/control help remains offline despite missing fields, invalid files and never-ending stdin", async () => {
  for (const action of ["send", "messages", "compact", "cancel"]) for (const help of ["-h", "--help"]) {
    const capture = captureIO(); const forever = new PassThrough(); let factories = 0;
    const code = await runCli(["session", action, help, "--json", ...(action === "send" ? ["--image", "/not-present", "--stdin"] : [])], {
      io: { ...capture.io, stdin: forever }, createConfigStore: () => { factories++; throw Error("must not load"); }
    });
    assert.equal(code, 0, capture.diagnostic()); assert.equal(factories, 0); assert.match(capture.output(), new RegExp(`Usage: awb session ${action}`)); forever.destroy();
    if (action !== "cancel") assert.match(capture.output(), /--follow-timeout/);
    if (action === "cancel") { assert.match(capture.output(), /竞态/); assert.match(capture.output(), /不回滚/); }
  }
});

test("A-PARSE-ALIASES/DEADLINE: follow aliases and timeout combinations reject locally", async () => {
  for (const extra of [["-f", "--follow"], ["--follow-timeout", "1s"], ["-f", "--follow-timeout", "0s"], ["-f", "--follow-timeout", "91d"], ["-f", "--follow-timeout", "1.5h"], ["-f", "--follow-timeout", "1s", "--follow-timeout", "2s"]]) {
    const capture = captureIO(); let config = 0;
    const code = await runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "1", ...extra, "--json"], { io: capture.io, createConfigStore: () => { config++; throw Error("must not load"); } });
    assert.equal(code, 2); assert.equal(config, 0); assert.equal(capture.output(), "");
  }
  const capture = captureIO(); const code = await runCli(["session", "compact", "-w", "w", "-s", "s", "-a", "a"], { io: capture.io });
  assert.equal(code, 2);
});

test("A-FOLLOW-DEADLINE: 90d deadline uses bounded timers without overflow and cleans handlers", async () => {
  const capture = captureIO(); const before = process.listenerCount("SIGINT");
  const scope = new FollowLifetime(capture.io.stdout);
  const warnings: Error[] = []; const warning = (error: Error) => warnings.push(error); process.on("warning", warning);
  try {
    scope.begin(parseFollowOptions({ follow: true, followTimeout: "90d" }).followTimeoutMs);
    await scope.delay(5); scope.check(); assert.equal(warnings.length, 0);
  } finally { scope.dispose(); process.removeListener("warning", warning); }
  assert.equal(process.listenerCount("SIGINT"), before);
});
