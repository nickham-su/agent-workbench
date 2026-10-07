import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { runCli } from "../src/program.js";
import { FileConfigStore } from "../src/config.js";
import { HttpClient } from "../src/http.js";
import { CliError } from "../src/errors.js";
import { captureIO, healthBody, httpServer, repository, temporaryDirectory } from "./helpers.js";

test("layered help/version and bare groups succeed without config or network", async () => {
  for (const args of [[], ["--help"], ["--version"], ["login", "--help"], ["session"], ["session", "--help"], ["session", "list", "--help"]]) {
    const capture = captureIO();
    let reads = 0;
    const result = await runCli(args, {
      io: capture.io,
      createConfigStore: () => { reads++; throw new Error("Must not read configuration"); },
      http: { request: async () => { throw new Error("Must not request network"); } }
    });
    assert.equal(result, 0);
    assert.equal(reads, 0);
    assert.ok(capture.output().length > 0);
    assert.equal(capture.diagnostic(), "");
    if (args.length === 0 || args[0] === "--help") assert.ok(!capture.output().includes("--workspace"));
    if (args[0] === "session" && args[1] !== "list") assert.ok(!capture.output().includes("--url"));
  }
});

test("usage errors, unknown and duplicate options never echo offending values", async () => {
  const bad = [
    ["login"], ["session", "list"], ["unknown-test-secret"],
    ["login", "--url", "http://example.test", "extra-test-secret"],
    ["login", "--url", "http://example.test", "--token", "test-secret"],
    ["login", "--url", "http://example.test", "--test-secret"],
    ["login", "--url=http://example.test", "--url", "http://other.test"],
    ["login", "--url", "http://example.test", "--token-stdin", "--token-stdin"],
    ["session", "list", "--workspace", "id", "--workspace=id", "--updated-within", "24h"],
    ["session", "list", "--workspace", "id", "--updated-within", "24h", "--json"]
  ];
  for (const args of bad) {
    const capture = captureIO();
    const result = await runCli(args, { io: capture.io, createConfigStore: () => { throw new Error("No config for invalid usage"); } });
    assert.equal(result, 2);
    assert.equal(capture.output(), "");
    assert.match(capture.diagnostic(), /\[USAGE\]/);
    assert.ok(!capture.diagnostic().includes("test-secret"));
    assert.ok(!capture.diagnostic().includes("http://other.test"));
  }
});

test("program passes initialization through login and converts persistence errors safely", async (t) => {
  const home = await temporaryDirectory("program-login");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const server = await httpServer((_request, response) => { response.end(healthBody(false)); });
  t.after(server.close);
  const capture = captureIO();
  const store = new FileConfigStore(home);
  assert.equal(await runCli(["login", "--url", server.origin], { io: capture.io, createConfigStore: () => store, http: new HttpClient() }), 0);
  assert.deepEqual(await store.load(), { version: 1, apiOrigin: server.origin, cookie: null });
  assert.equal(capture.diagnostic(), "");
  const failure = captureIO();
  assert.equal(await runCli(["login", "--url", server.origin], {
    io: failure.io,
    createConfigStore: () => ({ load: () => store.load(), save: async () => { throw new CliError(7, "测试持久化失败。"); } }),
    http: new HttpClient()
  }), 7);
  assert.equal(failure.output(), "");
  assert.match(failure.diagnostic(), /\[PERSISTENCE\]/);
});

test("built CommonJS entry has a single shebang and usable help/version without a user cache", async (t) => {
  const home = await temporaryDirectory("built-home");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = join(repository, "packages/cli/dist/cli.cjs");
  const bundle = await fs.readFile(file, "utf8");
  assert.ok(bundle.startsWith("#!/usr/bin/env node\n"));
  assert.equal((bundle.match(/#!\/usr\/bin\/env node/g) ?? []).length, 1);
  for (const args of [["--help"], ["--version"], ["session", "list", "--help"]]) {
    const child = spawnSync(process.execPath, [file, ...args], { encoding: "utf8", cwd: home, env: { ...process.env, HOME: home, NODE_PATH: "" } });
    assert.equal(child.status, 0);
    assert.equal(child.stderr, "");
    assert.ok(child.stdout.length > 0);
  }
  await assert.rejects(fs.stat(join(home, ".config")));
});
