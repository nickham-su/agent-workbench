import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { FileConfigStore, type CliConfigV1 } from "../src/config.js";
import { CliError } from "../src/errors.js";
import { normalizeOrigin } from "../src/origin.js";
import { cookieValue, temporaryDirectory } from "./helpers.js";

const config: CliConfigV1 = { version: 1, apiOrigin: "https://example.test", cookie: { name: "awb_session", value: cookieValue, secure: true } };
const exitCode = (code: number) => (error: unknown) => error instanceof CliError && error.exitCode === code;

test("origin normalization accepts only HTTP(S) origins and never echoes input", () => {
  for (const [input, expected] of [
    ["HTTPS://EXAMPLE.TEST:443/", "https://example.test"],
    ["http://localhost:80", "http://localhost"],
    ["http://127.0.0.1:3123/", "http://127.0.0.1:3123"],
    ["http://[::1]:3123", "http://[::1]:3123"]
  ]) assert.equal(normalizeOrigin(input), expected);
  for (const input of ["", "ftp://example.test", "http://", "https://example.test/api", "https://example.test/a/..", "https://example.test?", "https://example.test#", "https://user:test-secret@example.test", "https://@example.test", " https://example.test", "http://example.test\\api", "http://example.test:99999"]) {
    assert.throws(() => normalizeOrigin(input), exitCode(2));
    try { normalizeOrigin(input); } catch (error) { assert.ok(!String(error).includes("test-secret")); }
  }
});

test("configuration round-trip, canonical shape and POSIX permissions", async (t) => {
  const home = await temporaryDirectory("config");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const parent = join(home, ".config");
  await fs.mkdir(parent, { mode: 0o755 });
  const store = new FileConfigStore(home);
  await store.save(config);
  assert.deepEqual(await store.load(), config);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(store.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(store.filePath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(parent)).mode & 0o777, 0o755);
  }
  await store.save({ version: 1, apiOrigin: "http://localhost", cookie: null });
  assert.deepEqual(await store.load(), { version: 1, apiOrigin: "http://localhost", cookie: null });
  assert.deepEqual(await fs.readdir(store.directory), ["config.json"]);
});

test("missing, unreadable and invalid configuration are exit 3, without partial recovery", async (t) => {
  const home = await temporaryDirectory("invalid-config");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = new FileConfigStore(home);
  await assert.rejects(store.load(), exitCode(3));
  await fs.mkdir(store.directory, { recursive: true });
  const bad = ["{", "null", "[]", JSON.stringify({ ...config, version: 2 }), JSON.stringify({ ...config, apiOrigin: "https://example.test/" }), JSON.stringify({ ...config, extra: true }), JSON.stringify({ ...config, cookie: { ...config.cookie, value: "test-secret;wrong" } }), JSON.stringify({ ...config, cookie: { ...config.cookie, secure: "false" } })];
  for (const value of bad) {
    await fs.writeFile(store.filePath, value);
    await assert.rejects(store.load(), exitCode(3));
  }
  const unreadable = new FileConfigStore(home, { ...fs, readFile: async () => { throw new Error("simulated test-secret permission error"); } });
  await assert.rejects(unreadable.load(), (error: unknown) => exitCode(3)(error) && !String(error).includes("test-secret"));
});

test("atomic rename failure preserves old configuration and cleans unique temporary file", async (t) => {
  const home = await temporaryDirectory("atomic-config");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = new FileConfigStore(home);
  await store.save(config);
  const original = await fs.readFile(store.filePath, "utf8");
  const failing = new FileConfigStore(home, { ...fs, rename: async () => { throw new Error("simulated test-secret rename failure"); } });
  await assert.rejects(failing.save({ version: 1, apiOrigin: "http://localhost", cookie: null }), (error: unknown) => exitCode(7)(error) && !String(error).includes("test-secret"));
  assert.equal(await fs.readFile(store.filePath, "utf8"), original);
  assert.deepEqual(await fs.readdir(store.directory), ["config.json"]);
});

test("write failure and invalid config are exit 7 and do not damage old file", async (t) => {
  const home = await temporaryDirectory("write-config");
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const store = new FileConfigStore(home);
  await store.save(config);
  const original = await fs.readFile(store.filePath, "utf8");
  const failing = new FileConfigStore(home, { ...fs, open: async () => { throw new Error("simulated permission failure"); } });
  await assert.rejects(failing.save(config), exitCode(7));
  const writeFailure = new FileConfigStore(home, {
    ...fs,
    open: async (path, flags, mode) => {
      const handle = await fs.open(path, flags, mode);
      handle.writeFile = async () => { throw new Error("simulated write failure"); };
      return handle;
    }
  });
  await assert.rejects(writeFailure.save(config), exitCode(7));
  await assert.rejects(store.save({ ...config, apiOrigin: "bad" }), exitCode(7));
  assert.equal(await fs.readFile(store.filePath, "utf8"), original);
  assert.deepEqual(await fs.readdir(store.directory), ["config.json"]);
});
