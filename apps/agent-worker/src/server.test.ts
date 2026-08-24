import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer } from "node:net";
import { afterEach, test } from "node:test";
import { AgentWorkerEndpoints } from "@agent-workbench/shared/internal-contracts/endpoints";
import { createWorkerServer, normalizeWorkspaceRepoDirNames } from "./server.js";

const servers: Array<Awaited<ReturnType<typeof createWorkerServer>>> = [];

const validEnqueuePayload = {
  workspaceId: "ws_test",
  sessionId: "sess_test",
  runId: "run_test",
  workspacePath: "/workspace"
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function requestRaw(params: {
  port: number;
  method: string;
  path: string;
  token?: string;
  body?: string;
}) {
  return await new Promise<{ statusCode: number; body: unknown }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: params.port,
      method: params.method,
      path: params.path,
      headers: {
        ...(params.body === undefined ? {} : { "content-type": "application/json" }),
        ...(params.token === undefined ? {} : { "x-awb-agent-internal-token": params.token })
      }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode ?? 0, body: body ? JSON.parse(body) : null });
      });
    });
    req.on("error", reject);
    req.end(params.body);
  });
}

async function postJson(params: { port: number; token: string; body: unknown }) {
  return await requestRaw({
    port: params.port,
    method: AgentWorkerEndpoints.enqueueRun.method,
    path: AgentWorkerEndpoints.enqueueRun.path,
    token: params.token,
    body: JSON.stringify(params.body)
  });
}

async function getFreePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (!address || typeof address === "string") throw new Error("failed to allocate test port");
  return address.port;
}

async function createTestServer() {
  const runs: unknown[] = [];
  const cancelledSessions: string[] = [];
  const port = await getFreePort();
  const server = createWorkerServer({
    host: "127.0.0.1",
    port,
    socketPath: null,
    internalToken: "test-token",
    runner: {
      enqueueRun(run: unknown) {
        runs.push(run);
      },
      cancelSession(sessionId: string) {
        cancelledSessions.push(sessionId);
      }
    } as any
  });
  servers.push(server);
  await server.listen();
  return { port, runs, cancelledSessions };
}

test("normalizeWorkspaceRepoDirNames 兼容旧 payload 并过滤不安全目录名", () => {
  assert.deepEqual(normalizeWorkspaceRepoDirNames(undefined), []);
  assert.deepEqual(normalizeWorkspaceRepoDirNames(null), []);
  assert.deepEqual(normalizeWorkspaceRepoDirNames("repo-a"), []);
  assert.deepEqual(
    normalizeWorkspaceRepoDirNames([
      "repo-a",
      "repo-a",
      "",
      " repo-b",
      "repo/c",
      "repo\\c",
      ".",
      "..",
      "/absolute",
      "C:\\absolute",
      "line\nbreak",
      1,
      { dirName: "repo-object" },
      "repo-b"
    ]),
    ["repo-a", "repo-b"]
  );
});

test("normalizeWorkspaceRepoDirNames 稳定去重并限制为 100 项", () => {
  const names = Array.from({ length: 105 }, (_, index) => `repo-${index}`);
  assert.deepEqual(normalizeWorkspaceRepoDirNames(["repo-first", ...names, "repo-first"]), ["repo-first", ...names.slice(0, 99)]);
});

test("worker health 返回 200 和 ok 响应", async () => {
  const { port } = await createTestServer();
  const response = await requestRaw({
    port,
    method: AgentWorkerEndpoints.health.method,
    path: AgentWorkerEndpoints.health.path,
    token: "test-token"
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true });
});

test("worker 拒绝错误 token 并保持 message-only 响应", async () => {
  const { port, runs } = await createTestServer();
  const response = await postJson({ port, token: "wrong-token", body: validEnqueuePayload });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { message: "Unauthorized" });
  assert.deepEqual(runs, []);
});

test("worker 对 malformed JSON 保持 500 message-only 响应且不调用 Runner", async () => {
  const { port, runs } = await createTestServer();
  const response = await requestRaw({
    port,
    method: AgentWorkerEndpoints.enqueueRun.method,
    path: AgentWorkerEndpoints.enqueueRun.path,
    token: "test-token",
    body: "{"
  });

  assert.equal(response.statusCode, 500);
  assert.deepEqual(Object.keys(response.body as object), ["message"]);
  assert.equal(typeof (response.body as { message: unknown }).message, "string");
  assert.deepEqual(runs, []);
});

test("worker 拒绝非法 enqueue payload 且不调用 Runner", async () => {
  const { port, runs } = await createTestServer();
  const response = await postJson({
    port,
    token: "test-token",
    body: { ...validEnqueuePayload, runId: 1 }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { message: "invalid enqueue payload" });
  assert.deepEqual(runs, []);
});

test("worker enqueue 接受旧 payload 并将缺失 repo 名称归一化为必有空数组", async () => {
  const { port, runs } = await createTestServer();
  const response = await postJson({ port, token: "test-token", body: validEnqueuePayload });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(runs, [{
    ...validEnqueuePayload,
    inputText: undefined,
    workspaceRepoDirNames: []
  }]);
});

test("worker enqueue 将 inputText:null 归一化为 undefined", async () => {
  const { port, runs } = await createTestServer();
  const response = await postJson({
    port,
    token: "test-token",
    body: { ...validEnqueuePayload, inputText: null }
  });

  assert.equal(response.statusCode, 202);
  assert.equal((runs[0] as { inputText?: string }).inputText, undefined);
});

test("worker enqueue 过滤不安全名称、稳定去重并限制为 100 项", async () => {
  const { port, runs } = await createTestServer();
  const names = Array.from({ length: 105 }, (_, index) => `repo-${index}`);
  const response = await postJson({
    port,
    token: "test-token",
    body: {
      ...validEnqueuePayload,
      workspaceRepoDirNames: ["repo-first", "repo-first", "../outside", "repo/a", 1, ...names]
    }
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual((runs[0] as { workspaceRepoDirNames: string[] }).workspaceRepoDirNames, [
    "repo-first",
    ...names.slice(0, 99)
  ]);
});

test("worker cancel 拒绝非法 payload 且不调用 Runner", async () => {
  const { port, cancelledSessions } = await createTestServer();
  const response = await requestRaw({
    port,
    method: AgentWorkerEndpoints.cancelSession.method,
    path: AgentWorkerEndpoints.cancelSession.path,
    token: "test-token",
    body: JSON.stringify({ sessionId: 1 })
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { message: "invalid sessionId" });
  assert.deepEqual(cancelledSessions, []);
});

test("worker cancel 接受合法 payload", async () => {
  const { port, cancelledSessions } = await createTestServer();
  const response = await requestRaw({
    port,
    method: AgentWorkerEndpoints.cancelSession.method,
    path: AgentWorkerEndpoints.cancelSession.path,
    token: "test-token",
    body: JSON.stringify({ sessionId: "sess_test" })
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.body, { ok: true });
  assert.deepEqual(cancelledSessions, ["sess_test"]);
});

test("worker 未知路径返回 404 message-only 响应", async () => {
  const { port } = await createTestServer();
  const response = await requestRaw({
    port,
    method: "GET",
    path: "/internal/unknown",
    token: "test-token"
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { message: "Not Found" });
});
