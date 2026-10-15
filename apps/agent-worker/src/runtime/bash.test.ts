import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildBashEnvironment, runBashCommand } from "./bash.js";

const cwd = process.cwd();

test("bash environment copies own values, preserves literal overrides, and strips only AWB_", () => {
  const base = Object.freeze(Object.assign(Object.create(null), { NORMAL: "system", KEEP: "keep", EMPTY: "system", AWB_PRIVATE: "internal", awb_lower: "ordinary", OMIT: undefined }));
  const extra = Object.freeze(Object.assign(Object.create({ INHERITED: "not-own" }), {
    NORMAL: "workspace", EMPTY: "", HTTP_PROXY: "upper", http_proxy: "lower", LITERAL: "  $PATH\r\n$(touch nope)  ",
    AWB_PRIVATE: "injected", __proto__: "ignored by object initializer", constructor: "constructor-value", toString: "toString-value"
  }));
  const special = Object.freeze(Object.fromEntries([...Object.entries(extra as NodeJS.ProcessEnv), ["__proto__", "prototype-value"]]));
  const result = buildBashEnvironment(special, base);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual({ ...result }, { NORMAL: "workspace", KEEP: "keep", EMPTY: "", awb_lower: "ordinary", HTTP_PROXY: "upper", http_proxy: "lower", LITERAL: "  $PATH\r\n$(touch nope)  ", constructor: "constructor-value", toString: "toString-value", ["__proto__"]: "prototype-value" });
  assert.equal(Object.hasOwn(result, "AWB_PRIVATE"), false);
  assert.equal(Object.hasOwn(result, "OMIT"), false);
  assert.equal(Object.hasOwn(buildBashEnvironment(extra, base), "INHERITED"), false);
  assert.equal(base.NORMAL, "system");
  assert.equal(base.AWB_PRIVATE, "internal");
  assert.equal(special.NORMAL, "workspace");
});

test("bash child receives literal empty/multiline values without modifying process.env", async () => {
  const previous = process.env.AWB_BASH_TEST_CONTROL;
  process.env.AWB_BASH_TEST_CONTROL = "private-control-fixture";
  const extra = Object.freeze({ BASH_TEST_VALUE: "  $PATH\r\n$(printf interpreted)  ", BASH_TEST_EMPTY: "", AWB_BASH_TEST_CONTROL: "must-not-pass" });
  try {
    const result = await runBashCommand({ cwd, timeoutMs: 5000, command: "printf '%s|%s|%s' \"$BASH_TEST_VALUE\" \"${BASH_TEST_EMPTY-unset}\" \"${AWB_BASH_TEST_CONTROL-unset}\"", extraEnv: extra });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "  $PATH\r\n$(printf interpreted)  ||unset");
    assert.equal(process.env.AWB_BASH_TEST_CONTROL, "private-control-fixture");
    assert.equal(process.env.BASH_TEST_VALUE, undefined);
    // The same helper is used without Workspace context by bashTools probes.
    const probe = await runBashCommand({ cwd, timeoutMs: 5000, command: "printf '%s|%s' \"${BASH_TEST_VALUE-unset}\" \"${AWB_BASH_TEST_CONTROL-unset}\"" });
    assert.equal(probe.stdout, "unset|unset");
  } finally {
    if (previous === undefined) delete process.env.AWB_BASH_TEST_CONTROL; else process.env.AWB_BASH_TEST_CONTROL = previous;
  }
});

test("already cancelled bash does not create a child", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-abort-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runBashCommand({ cwd: dir, command: "printf started > marker", timeoutMs: 5000, signal: controller.signal }), /aborted/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test("spawn and E2BIG failures have fixed safe errors without argv or environment", async () => {
  const marker = "private-command-environment-fixture";
  await assert.rejects(runBashCommand({ cwd: path.join(cwd, "missing-directory-fixture"), command: marker, timeoutMs: 5000 }), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal((error as NodeJS.ErrnoException).code, "BASH_SPAWN_FAILED");
    assert.equal(error.message, "Bash could not be started.");
    assert(!JSON.stringify(error).includes(marker));
    assert(!("spawnargs" in error));
    return true;
  });
  await assert.rejects(runBashCommand({ cwd, command: marker, timeoutMs: 5000, extraEnv: { TOO_LARGE: marker.repeat(20_000) } }), (error: unknown) => {
    assert(error instanceof Error);
    assert.equal((error as NodeJS.ErrnoException).code, "BASH_ENV_TOO_LARGE");
    assert.equal(error.message, "Bash environment exceeds the operating system limit.");
    assert(!JSON.stringify(error).includes(marker));
    assert(!("spawnargs" in error));
    return true;
  });
});
