import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { CliError, errorObject } from "../src/errors.js";
import { writeFailure } from "../src/output.js";
import { runCli } from "../src/program.js";
import { connectionStore, jsonResult } from "./agent-fixture.js";
import { msg, page, run, state } from "./follow-fixture.js";
import { captureIO } from "./helpers.js";

test("全面审查L2: repeated diagnostics on fully closed stderr keep zero listeners and the original CLI error", async () => {
  let writes = 0;
  const stderr = new Writable({ write(_chunk, _encoding, done) { writes++; done(); } });
  const closed = once(stderr, "close"); stderr.destroy(); await closed;
  assert.equal(stderr.closed, true); assert.equal(stderr.listenerCount("error"), 0); assert.equal(stderr.listenerCount("close"), 0);
  const capture = captureIO(); const io = { ...capture.io, stderr };
  const original = new CliError(4, "fixture auth required", { code: "AUTH_REQUIRED", phase: "history", effect: "rejected", context: { workspaceId: "w", sessionId: "s", runId: "r" } });
  const evidence = errorObject(original); const start = performance.now();
  for (let index = 0; index < 3; index++) {
    await writeFailure(io, true, original);
    assert.equal(await runCli(["session", "show", "-w", "w", "-s", "s", "--json"], {
      io, createConfigStore: () => connectionStore(), http: { request: async () => { throw original; } }
    }), 4);
    await setImmediate();
    assert.equal(stderr.listenerCount("error"), 0); assert.equal(stderr.listenerCount("close"), 0);
    assert.deepEqual(errorObject(original), evidence);
  }
  assert.ok(performance.now() - start < 1000); assert.equal(writes, 0); assert.equal(capture.output(), "");
});

test("全面审查L2: closing stderr retains its late-error guard, including a pending error with closed already true", async () => {
  const capture = captureIO();
  const original = new CliError(10, "fixture timeout", { code: "FOLLOW_TIMEOUT", phase: "follow", context: { runId: "r" } });
  let finishDestroy!: (error?: Error | null) => void;
  const closing = new Writable({ write(_chunk, _encoding, done) { done(); }, destroy(_error, done) { finishDestroy = done; } });
  closing.destroy(); assert.equal(closing.destroyed, true); assert.equal(closing.closed, false);
  await writeFailure({ ...capture.io, stderr: closing }, true, original);
  assert.equal(closing.closed, false); assert.equal(closing.listenerCount("error"), 1); assert.equal(closing.listenerCount("close"), 1);
  finishDestroy(new Error("late fixture destruction failure")); await setImmediate();
  assert.equal(closing.closed, true); assert.equal(closing.listenerCount("error"), 0); assert.equal(closing.listenerCount("close"), 0);

  const pendingError = new Writable({ write(_chunk, _encoding, done) { done(); }, destroy(_error, done) { done(new Error("pending fixture destruction failure")); } });
  pendingError.destroy(); assert.equal(pendingError.closed, true);
  // closed can become true before Node emits its queued destruction error/close.
  // Do not replace the explicit cleanup with an unguarded closed-only early return.
  await writeFailure({ ...capture.io, stderr: pendingError }, true, original); await setImmediate();
  assert.equal(pendingError.listenerCount("error"), 0); assert.equal(pendingError.listenerCount("close"), 0);
  assert.equal(original.exitCode, 10); assert.equal(original.details.code, "FOLLOW_TIMEOUT"); assert.deepEqual(original.details.context, { runId: "r" });
});

test("全面审查H1: final diagnostic has a fixed budget and late callbacks/errors are safe without leaked handlers", async () => {
  for (const lateError of [false, true]) {
    let callback!: (error?: Error | null) => void; let writes = 0;
    const stderr = new Writable({ write(_chunk, _encoding, done) { writes++; callback = done; } });
    const capture = captureIO(); const start = performance.now();
    await writeFailure({ ...capture.io, stderr }, true, new CliError(10, "fixture timeout", { context: { runId: "r" } }));
    assert.ok(performance.now() - start < 1000); assert.equal(writes, 1); assert.equal(stderr.destroyed, true);
    await setImmediate(); assert.equal(stderr.listenerCount("error"), 0); assert.equal(stderr.listenerCount("close"), 0);
    callback(lateError ? new Error("late fixture write failure") : undefined);
    await setImmediate(); assert.equal(writes, 1); assert.equal(capture.output(), "");
  }
});

test("全面审查H1: runCli returns the original follow timeout despite an unfinished stderr callback", async () => {
  const capture = captureIO(); let callback!: (error?: Error | null) => void; let writes = 0; let diagnostic = "";
  let diagnosticStarted!: () => void; const started = new Promise<void>((resolve) => { diagnosticStarted = resolve; });
  const stderr = new Writable({ write(chunk, _encoding, done) { writes++; diagnostic += chunk.toString(); callback = done; diagnosticStarted(); } });
  const requests: string[] = [];
  const operation = runCli(["session", "messages", "-w", "w", "-s", "s", "-n", "1", "-f", "--follow-timeout", "1s", "--json"], {
    io: { ...capture.io, stderr }, createConfigStore: () => connectionStore(), http: { request: async (_origin, path, request) => {
      requests.push(path); const url = new URL(path, "http://fixture.test");
      if (url.pathname.endsWith("/run-state")) return jsonResult(state("r"));
      if (url.pathname.endsWith("/runs/r")) return jsonResult(run("r", "running"));
      if (url.searchParams.get("mode") === "delta") return new Promise((_resolve, reject) => request!.signal!.addEventListener("abort", () => reject(new CliError(5, "fixture body aborted", { code: "TRANSPORT_FAILED" })), { once: true }));
      return jsonResult(page([msg("a", 0, null)]));
    } }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await started;
    const code = await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Error("unbounded failure diagnostic")), 1000); })]);
    assert.equal(code, 10); assert.equal(writes, 1);
    const error = JSON.parse(diagnostic).error;
    assert.equal(error.code, "FOLLOW_TIMEOUT"); assert.equal(error.context.runId, "r");
    const terminal = JSON.parse(capture.output().trim().split("\n").at(-1)!);
    assert.equal(terminal.exitCode, 10); assert.equal(terminal.complete, false);
    assert.equal(requests.some((path) => path.includes("/cancel")), false);
  } finally { clearTimeout(timer); callback(); await operation; }
});
