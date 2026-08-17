import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer } from "node:net";
import { afterEach, test } from "node:test";
import { createWorkerServer, normalizeWorkspaceRepoDirNames } from "./server.js";

const servers: Array<Awaited<ReturnType<typeof createWorkerServer>>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function postJson(params: { port: number; token: string; body: unknown }) {
  return await new Promise<{ statusCode: number; body: unknown }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port: params.port,
      method: "POST",
      path: "/internal/runs/enqueue",
      headers: {
        "content-type": "application/json",
        "x-awb-agent-internal-token": params.token
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
    req.end(JSON.stringify(params.body));
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

async function createEnqueueServer() {
  const runs: unknown[] = [];
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
      cancelSession() {}
    } as any
  });
  servers.push(server);
  await server.listen();
  return { port, runs };
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

test("worker enqueue 接受旧 payload 并将缺失 repo 名称归一化为必有空数组", async () => {
  const { port, runs } = await createEnqueueServer();
  const response = await postJson({
    port,
    token: "test-token",
    body: {
      workspaceId: "ws_test",
      sessionId: "sess_test",
      runId: "run_test",
      workspacePath: "/workspace"
    }
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual(runs, [{
    workspaceId: "ws_test",
    sessionId: "sess_test",
    runId: "run_test",
    inputText: undefined,
    workspacePath: "/workspace",
    workspaceRepoDirNames: []
  }]);
});

test("worker enqueue 过滤不安全名称、稳定去重并限制为 100 项", async () => {
  const { port, runs } = await createEnqueueServer();
  const names = Array.from({ length: 105 }, (_, index) => `repo-${index}`);
  const response = await postJson({
    port,
    token: "test-token",
    body: {
      workspaceId: "ws_test",
      sessionId: "sess_test",
      runId: "run_test",
      workspacePath: "/workspace",
      workspaceRepoDirNames: ["repo-first", "repo-first", "../outside", "repo/a", 1, ...names]
    }
  });

  assert.equal(response.statusCode, 202);
  assert.deepEqual((runs[0] as { workspaceRepoDirNames: string[] }).workspaceRepoDirNames, [
    "repo-first",
    ...names.slice(0, 99)
  ]);
});
