import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { FileConfigStore } from "../src/config.js";
import { agentSession } from "./agent-fixture.js";
import { msg, page, run, state } from "./follow-fixture.js";
import { httpServer, repository, temporaryDirectory } from "./helpers.js";

function launch(home: string, args: string[]) {
  return spawn(process.execPath, [join(repository, "packages/cli/dist/cli.cjs"), "session", ...args, "--json"], {
    cwd: home, env: { HOME: home, USERPROFILE: home, TMPDIR: home, PATH: dirname(process.execPath), NODE_PATH: "" }, stdio: ["pipe", "pipe", "pipe"]
  });
}
async function finish(child: ChildProcessWithoutNullStreams) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([once(child, "close"), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("fixture CLI did not stop")); }, 8_000); })]);
  } finally { clearTimeout(timer); }
}

test("A-FOLLOW-SIGNALS: real SIGINT/SIGTERM after accepted send and during final drain return 130/143 without cancel", async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) for (const phase of ["accepted", "drain"] as const) {
    const home = await temporaryDirectory(`follow-${signal}-${phase}`); t.after(() => fs.rm(home, { recursive: true, force: true }));
    let child: ChildProcessWithoutNullStreams | undefined; let writes = 0; let cancels = 0; let deltas = 0;
    const user = msg("u", 0, null, { type: "user", originRunId: null });
    const server = await httpServer(async (request, response) => {
      const url = new URL(request.url!, "http://fixture.test"); response.setHeader("content-type", "application/json");
      if (request.method === "POST") { writes++; for await (const _chunk of request) { /* consume only fixture input */ } }
      let body: unknown;
      if (url.pathname.endsWith("/agents/available")) body = { agents: [{ id: "a", name: "a", summary: "" }] };
      else if (url.pathname === "/api/agent/sessions/s") body = agentSession();
      else if (url.pathname.endsWith("/messages")) body = { sessionId: "s", messageId: "u", runId: "r", deduplicated: false };
      else if (url.pathname.endsWith("/cancel")) { cancels++; body = {}; }
      else if (url.pathname.endsWith("/runs/r")) body = run();
      else if (url.pathname.endsWith("/timeline")) {
        if (url.searchParams.get("mode") === "delta" && ++deltas === 2 && phase === "drain") {
          response.write('{"session":'); child!.kill(signal); return;
        }
        body = url.searchParams.get("mode") === "snapshot" ? page([user]) : page([], 10, { session: agentSession({ headMessageId: "u", revision: 10 }) });
      } else throw Error("unexpected fixture route");
      response.end(JSON.stringify(body));
    });
    try {
      await new FileConfigStore(home).save({ version: 1, apiOrigin: server.origin, cookie: null });
      child = launch(home, ["send", "-w", "w", "-s", "s", "--prompt", "fixture", "-f"]);
      let stdout = ""; let stderr = ""; let signalled = false;
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (phase === "accepted" && !signalled && stdout.includes('"type":"metadata"')) { signalled = true; child!.kill(signal); } });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.stdin.end();
      const [code, killedBy] = await finish(child);
      assert.equal(killedBy, null); assert.equal(code, signal === "SIGINT" ? 130 : 143, stderr); assert.equal(writes, 1); assert.equal(cancels, 0);
      const events = stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(events[0].type, "metadata"); assert.equal(events.at(-1).complete, false); assert.equal(events.at(-1).outcome, "interrupted");
      const error = JSON.parse(stderr).error;
      assert.equal(error.category, "INTERRUPTED"); assert.equal(error.code, "INTERRUPTED");
      assert.equal(error.phase, "follow"); assert.equal(error.effect, "accepted");
      assert.deepEqual(error.context, { workspaceId: "w", sessionId: "s", agentId: "a", messageId: "u", runId: "r", clientRequestId: events[0].clientRequestId });
      assert.equal(typeof error.context.clientRequestId, "string"); assert.ok(error.context.clientRequestId.length > 0);
      if (phase === "drain") assert.equal(events.at(-1).runStatus, "completed");
    } finally { child?.kill("SIGKILL"); await server.close(); }
  }
});

test("A-FOLLOW-SIGNALS: real closed stdout EPIPE stops reads with 141 and no remote cancel", async (t) => {
  const home = await temporaryDirectory("follow-epipe"); t.after(() => fs.rm(home, { recursive: true, force: true }));
  let cancels = 0;
  const user = msg("u", 0, null, { type: "user", originRunId: null });
  const server = await httpServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.test"); response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/cancel")) cancels++;
    const body = url.pathname.endsWith("/run-state") ? state("r") : url.pathname.endsWith("/runs/r") ? run() : url.searchParams.get("mode") === "snapshot"
      ? page([user]) : page([msg("large", 1, "u", { updatedRevision: 11, parts: [{ id: "p", messageId: "large", position: 0, updatedRevision: 11, createdAt: 1, updatedAt: 2, type: "text", text: "x".repeat(300_000) }] })], 11);
    response.end(JSON.stringify(body));
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await new FileConfigStore(home).save({ version: 1, apiOrigin: server.origin, cookie: null });
    child = launch(home, ["messages", "-w", "w", "-s", "s", "-n", "1", "-f"]);
    child.stdout.once("data", () => child!.stdout.destroy()); let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.stdin.end();
    const [code, signal] = await finish(child); assert.equal(signal, null); assert.equal(code, 141, stderr); assert.equal(cancels, 0);
    const error = JSON.parse(stderr).error;
    assert.equal(error.category, "OUTPUT"); assert.equal(error.code, "OUTPUT_CLOSED");
    assert.deepEqual(error.context, { workspaceId: "w", sessionId: "s", runId: "r" });
  } finally { child?.kill("SIGKILL"); await server.close(); }
});

test("A-FOLLOW-DEADLINE: real final JSON body stalls under whole deadline, reports known terminal without cancellation", async (t) => {
  const home = await temporaryDirectory("follow-whole-body"); t.after(() => fs.rm(home, { recursive: true, force: true }));
  let deltas = 0; let cancels = 0;
  const a = msg("a", 0, null);
  const server = await httpServer((request, response) => {
    const url = new URL(request.url!, "http://fixture.test"); response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/cancel")) cancels++;
    if (url.searchParams.get("mode") === "delta" && ++deltas === 2) { response.write('{"session":'); return; }
    response.end(JSON.stringify(url.pathname.endsWith("/run-state") ? state("r") : url.pathname.endsWith("/runs/r") ? run() : url.searchParams.get("mode") === "snapshot" ? page([a]) : page([], 10, { session: agentSession({ headMessageId: "a", revision: 10 }) })));
  });
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    await new FileConfigStore(home).save({ version: 1, apiOrigin: server.origin, cookie: null });
    child = launch(home, ["messages", "-w", "w", "-s", "s", "-n", "1", "-f", "--follow-timeout", "1s"]);
    let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.stdin.end();
    const [code] = await finish(child); assert.equal(code, 10, stderr); assert.equal(cancels, 0); assert.equal(deltas, 2);
    const terminal = JSON.parse(stdout.trim().split("\n").at(-1)!); assert.equal(terminal.complete, false); assert.equal(terminal.runStatus, "completed");
    const error = JSON.parse(stderr).error;
    assert.equal(error.category, "FOLLOW_TIMEOUT"); assert.equal(error.code, "FOLLOW_TIMEOUT");
    assert.deepEqual(error.context, { workspaceId: "w", sessionId: "s", runId: "r" });
  } finally { child?.kill("SIGKILL"); await server.close(); }
});

test("A-FOLLOW-SIGNALS/UNKNOWN-SEND: SIGINT after POST dispatch before complete acceptance preserves unknown result", async (t) => {
  const home = await temporaryDirectory("follow-interrupted-acceptance"); t.after(() => fs.rm(home, { recursive: true, force: true }));
  let child: ChildProcessWithoutNullStreams | undefined; let writes = 0; let cancels = 0;
  const server = await httpServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture.test"); response.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/agents/available")) response.end(JSON.stringify({ agents: [{ id: "a", name: "a", summary: "" }] }));
    else if (url.pathname === "/api/agent/sessions/s") response.end(JSON.stringify(agentSession()));
    else if (url.pathname.endsWith("/messages")) {
      writes++; for await (const _chunk of request) { /* server has received the single POST */ }
      response.write('{"sessionId":"s"'); child!.kill("SIGINT");
    } else { cancels++; response.end("{}"); }
  });
  try {
    await new FileConfigStore(home).save({ version: 1, apiOrigin: server.origin, cookie: null });
    child = launch(home, ["send", "-w", "w", "-s", "s", "--prompt", "fixture", "-f"]);
    let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); }); child.stdin.end();
    const [code, signal] = await finish(child); assert.equal(code, 130, stderr); assert.equal(signal, null); assert.equal(stdout, ""); assert.equal(writes, 1); assert.equal(cancels, 0);
    const error = JSON.parse(stderr).error; assert.equal(error.phase, "send"); assert.equal(error.effect, "unknown"); assert.equal(error.context.sessionId, "s"); assert.equal(error.context.runId, undefined);
    assert.equal(error.category, "INTERRUPTED"); assert.equal(error.code, "INTERRUPTED");
    assert.equal(error.context.workspaceId, "w"); assert.equal(typeof error.context.clientRequestId, "string"); assert.ok(error.context.clientRequestId.length > 0);
  } finally { child?.kill("SIGKILL"); await server.close(); }
});

test("全面审查M2: real messages SIGINT/SIGTERM retain captured Run in stderr after stdout is lost", async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const home = await temporaryDirectory(`messages-context-${signal}`); t.after(() => fs.rm(home, { recursive: true, force: true }));
    let bodyStarted!: () => void; const body = new Promise<void>((resolve) => { bodyStarted = resolve; }); let cancels = 0;
    const server = await httpServer((request, response) => {
      const url = new URL(request.url!, "http://fixture.test"); response.setHeader("content-type", "application/json");
      if (url.pathname.endsWith("/cancel")) cancels++;
      if (url.pathname.endsWith("/run-state")) response.end(JSON.stringify(state("target-run")));
      else if (url.searchParams.get("mode") === "delta") { response.write('{"session":'); bodyStarted(); }
      else response.end(JSON.stringify(page([msg("a", 0, null)])));
    }); t.after(server.close);
    await new FileConfigStore(home).save({ version: 1, apiOrigin: server.origin, cookie: null });
    const child = launch(home, ["messages", "-w", "w", "-s", "s", "-n", "1", "-f"]); t.after(() => { child.kill("SIGKILL"); });
    let metadataSeen!: () => void; const metadata = new Promise<void>((resolve) => { metadataSeen = resolve; });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.includes('"type":"metadata"')) metadataSeen(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; }); child.stdin.end();
    await Promise.all([body, metadata]); child.stdout.destroy(); child.kill(signal);
    const [code, terminatedBy] = await finish(child);
    assert.equal(terminatedBy, null); assert.equal(code, signal === "SIGINT" ? 130 : 143, stderr);
    const error = JSON.parse(stderr).error;
    assert.equal(error.category, "INTERRUPTED"); assert.equal(error.code, "INTERRUPTED"); assert.equal(error.phase, "follow"); assert.equal(error.effect, "not_applicable");
    assert.deepEqual(error.context, { workspaceId: "w", sessionId: "s", runId: "target-run" }); assert.equal(cancels, 0);
  }
});
