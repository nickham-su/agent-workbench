import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { AUTH_REMEMBER_TTL_MS, createSessionCookieValue, readSessionCookiePayload } from "../../../infra/auth/sessionCookie.js";
import { createMessageSession } from "../agent-message.store.js";
import { createAgentTestFixture, createTestWorkspace } from "../testkit/agent-testkit.js";

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));
const cliEntry = path.join(repoRoot, "packages/cli/src/cli.ts");
const loader = import.meta.resolve("tsx");

// Exercise the real CLI entry without requiring an ignored dist file in API's
// standalone gate. The separately tested CJS artifact uses this same entry.
async function runCli(home: string, args: string[], input = "", timezone = "UTC") {
  const child = spawn(process.execPath, ["--import", loader, cliEntry, ...args], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, NODE_PATH: "", TSX_DISABLE_CACHE: "1", TZ: timezone },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdin.end(input);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  try {
    const [code] = await once(child, "close");
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: TestContext, authToken: string | null) {
  const f = await createAgentTestFixture({ repoRoot, dataDirPrefix: "cli-session-production-", withApp: true, authToken, agentWorkerConcurrency: 0 });
  t.after(() => f.dispose());
  const workspace = await createTestWorkspace(f);
  const home = path.join(f.dataDir, "cli-home");
  await fs.mkdir(home);
  const app = f.app!;
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const file = path.join(home, ".config/awb/config.json");
  const args = ["session", "list", "--workspace", workspace.id, "--updated-within", "1h"];
  return { ...f, workspaceId: workspace.id, home, origin, file, args };
}

function privateOutput(result: { stdout: string; stderr: string }, secrets: string[]) {
  for (const secret of secrets) {
    assert.equal(result.stdout.includes(secret), false, "stdout must not contain generated credentials");
    assert.equal(result.stderr.includes(secret), false, "stderr must not contain generated credentials");
  }
}

test("production CLI initializes auth-off API and returns all records and native counts in UTC", async (t) => {
  const f = await fixture(t, null);
  const createdAt = Date.now() - 2 * 3600_000;
  const createdIso = new Date(createdAt).toISOString();
  for (let i = 0; i < 165; i++) {
    createMessageSession(f.db, { id: `cli-session-${String(i).padStart(3, "0")}`, workspaceId: f.workspaceId,
      title: i === 0 ? "" : "通用会话", kind: i % 2 === 0 ? "primary" : "subtask", createdAt });
  }
  f.db.prepare("update agent_session set updated_at = ? where workspace_id = ?").run(Date.now() - 1000, f.workspaceId);
  for (const [id, type] of [["native-user", "user"], ["native-assistant", "assistant"], ["summary", "compaction"]]) {
    f.db.prepare(`insert into agent_message
      (id, workspace_id, depth, type, status, origin_session_id, updated_revision, created_at, updated_at)
      values (?, ?, 0, ?, 'completed', 'cli-session-000', 0, 1, 1)`).run(id, f.workspaceId, type);
  }
  const initialized = await runCli(f.home, ["login", "--url", f.origin]);
  assert.equal(initialized.code, 0);
  assert.equal(initialized.stderr, "");
  assert.equal(JSON.parse(await fs.readFile(f.file, "utf8")).cookie, null);
  const before = await fs.stat(f.file);
  const result = await runCli(f.home, f.args, "", "America/New_York");
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal((result.stdout.match(/^Session ID：/gm) ?? []).length, 165);
  assert.match(result.stdout, /匹配总数：165/);
  assert.match(result.stdout, /标题：（空标题）/);
  assert.match(result.stdout, /用户消息累计数：1\n已完成助手消息累计数：1/);
  assert.equal(result.stdout.split(`创建时间：${createdIso}\n`).length - 1, 165);
  assert.ok(result.stdout.includes(`创建时间：${createdIso}\n最近更新时间：`));
  assert.match(result.stdout, /最近更新时间：[^\n]+Z\n/);
  assert.match(result.stdout, /查询结束：已输出 165 个 Session。\n$/);
  assert.equal(result.stdout.length > 8_000 && result.stdout.length < 200_000, true);
  const after = await fs.stat(f.file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const filtered = await runCli(f.home, [...f.args, "--kind", "subtask", "--status", "idle"]);
  assert.equal(filtered.code, 0);
  assert.equal(filtered.stderr, "");
  assert.equal((filtered.stdout.match(/^Session ID：/gm) ?? []).length, 82);
});

test("production CLI persists actual threshold renewals before success and business errors, but leaves rejected credentials unchanged", async (t) => {
  const authToken = randomUUID();
  const f = await fixture(t, authToken);
  createMessageSession(f.db, { id: "native-session", workspaceId: f.workspaceId, title: "通用会话", kind: "primary", createdAt: Date.now() - 1000 });
  const loggedIn = await runCli(f.home, ["login", "--url", f.origin, "--token-stdin"], `${authToken}\n`);
  assert.equal(loggedIn.code, 0);
  assert.equal(loggedIn.stderr, "");
  privateOutput(loggedIn, [authToken]);
  const config = JSON.parse(await fs.readFile(f.file, "utf8"));
  const initialPayload = readSessionCookiePayload({ authToken, value: config.cookie.value, nowMs: Date.now() });
  assert.ok(initialPayload);
  assert.equal(initialPayload.exp - initialPayload.iat, AUTH_REMEMBER_TTL_MS);
  assert.deepEqual(Object.keys(config).sort(), ["apiOrigin", "cookie", "version"]);

  const oldValue = createSessionCookieValue({ authToken, nowMs: Date.now() - 24 * 24 * 60 * 60 * 1000, ttlMs: AUTH_REMEMBER_TTL_MS });
  const setCookie = async (value: string) => {
    await fs.writeFile(f.file, JSON.stringify({ ...config, cookie: { ...config.cookie, value } }), { mode: 0o600 });
  };
  await setCookie(oldValue);
  const beforeRenewal = Date.now();
  const renewed = await runCli(f.home, f.args);
  assert.equal(renewed.code, 0);
  assert.equal(renewed.stderr, "");
  assert.match(renewed.stdout, /查询结束：已输出 1 个 Session。\n$/);
  const persisted = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.equal(persisted.cookie.value !== oldValue, true);
  const payload = readSessionCookiePayload({ authToken, value: persisted.cookie.value, nowMs: Date.now() });
  assert.ok(payload);
  assert.equal(payload.exp - payload.iat, AUTH_REMEMBER_TTL_MS);
  assert.equal(payload.iat >= beforeRenewal, true);
  privateOutput(renewed, [authToken, oldValue, persisted.cookie.value]);

  const stats = await fs.stat(f.file);
  const polling = await runCli(f.home, f.args);
  assert.equal(polling.code, 0);
  assert.equal(polling.stderr, "");
  const unchanged = await fs.stat(f.file);
  assert.equal(unchanged.ino, stats.ino);
  assert.equal(unchanged.mtimeMs, stats.mtimeMs);

  await setCookie(oldValue);
  const businessError = await runCli(f.home, ["session", "list", "--workspace", "unknown-workspace", "--updated-within", "1h"]);
  assert.equal(businessError.code, 6);
  assert.equal(businessError.stdout, "");
  assert.match(businessError.stderr, /HTTP 404.*WORKSPACE_NOT_FOUND/);
  const errorCookie = JSON.parse(await fs.readFile(f.file, "utf8")).cookie.value as string;
  assert.equal(errorCookie !== oldValue, true);
  assert.ok(readSessionCookiePayload({ authToken, value: errorCookie, nowMs: Date.now() }));
  privateOutput(businessError, [authToken, oldValue, errorCookie]);

  for (const rejected of [
    createSessionCookieValue({ authToken, nowMs: Date.now() - AUTH_REMEMBER_TTL_MS - 1000, ttlMs: AUTH_REMEMBER_TTL_MS }),
    createSessionCookieValue({ authToken: randomUUID(), nowMs: Date.now(), ttlMs: AUTH_REMEMBER_TTL_MS })
  ]) {
    await setCookie(rejected);
    const before = await fs.readFile(f.file, "utf8");
    const denied = await runCli(f.home, f.args);
    assert.equal(denied.code, 4);
    assert.equal(denied.stdout, "");
    assert.match(denied.stderr, /HTTP 401/);
    assert.equal((await fs.readFile(f.file, "utf8")) === before, true);
    privateOutput(denied, [authToken, rejected]);
  }
});
