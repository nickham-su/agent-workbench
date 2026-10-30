import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { CliError, errorObject, withErrorDetails, type ErrorDetails } from "../src/errors.js";
import { FollowLifetime } from "../src/follow-lifetime.js";
import { HttpClient } from "../src/http.js";
import { httpServer } from "./helpers.js";

const stops = [
  { reason: "SIGINT", exitCode: 130, category: "INTERRUPTED", code: "INTERRUPTED" },
  { reason: "SIGTERM", exitCode: 143, category: "INTERRUPTED", code: "INTERRUPTED" },
  { reason: "EPIPE", exitCode: 141, category: "OUTPUT", code: "OUTPUT_CLOSED" },
  { reason: "deadline", exitCode: 10, category: "FOLLOW_TIMEOUT", code: "FOLLOW_TIMEOUT" }
] as const;
function stop(reason: typeof stops[number]["reason"], lifetime: FollowLifetime, stdout: PassThrough, external: AbortController) {
  if (reason === "SIGINT") external.abort();
  else if (reason === "SIGTERM") process.emit("SIGTERM");
  else if (reason === "EPIPE") stdout.emit("error", Object.assign(new Error("fixture pipe closed"), { code: "EPIPE" }));
  else lifetime.begin(0);
}
function assertStopped(error: unknown, expected: typeof stops[number], evidence: ErrorDetails) {
  assert.ok(error instanceof CliError);
  assert.equal(error.exitCode, expected.exitCode);
  const diagnostic = errorObject(error).error;
  assert.equal(diagnostic.category, expected.category);
  assert.equal(diagnostic.code, expected.code);
  assert.equal(diagnostic.phase, evidence.phase);
  assert.equal(diagnostic.effect, evidence.effect);
  assert.deepEqual(diagnostic.context, evidence.context);
  assert.equal(diagnostic.help, evidence.help ?? "awb --help");
  assert.doesNotMatch(diagnostic.message, /superseded fixture/);
}

test("M1: unstopped lifetime preserves the original error and classification", () => {
  const stdout = new PassThrough(); const lifetime = new FollowLifetime(stdout);
  try {
    const error = new CliError(5, "superseded fixture", { code: "REQUEST_TIMEOUT" });
    assert.equal(lifetime.failure(error), error);
    assert.equal(errorObject(error).error.code, "REQUEST_TIMEOUT");
  } finally { lifetime.dispose(); stdout.destroy(); }
});

test("M1: stop reason owns exit/category/code while accepted, unknown-effect and published evidence survives", () => {
  const identity = { workspaceId: "w", sessionId: "s", agentId: "a", messageId: "m", runId: "r", clientRequestId: "request" };
  const evidence: ErrorDetails[] = [
    { phase: "follow", effect: "accepted", context: identity, help: "awb session send --help" },
    { phase: "send", effect: "unknown", context: identity, help: "awb session send --help" },
    { phase: "publish", effect: "not_applicable", context: { workspaceId: "w", published: true }, help: "awb file download --help" }
  ];
  for (const expected of stops) for (const details of evidence) for (const code of ["TRANSPORT_FAILED", "REQUEST_TIMEOUT", "HTTP_REJECTED", "LOCAL_IO_FAILED"]) {
    const stdout = new PassThrough(); const external = new AbortController(); const lifetime = new FollowLifetime(stdout, external.signal);
    try {
      stop(expected.reason, lifetime, stdout, external);
      const original = new CliError(5, "superseded fixture", { ...details, code });
      assertStopped(lifetime.failure(original), expected, details);
      assert.equal(original.details.code, code, "the superseded error must not be mutated");
    } finally { lifetime.dispose(); stdout.destroy(); }
  }
});

test("M1: real HTTP partial body abort replaces TRANSPORT_FAILED for all four local stop reasons without cancel", async (t) => {
  for (const expected of stops) {
    const requests: string[] = [];
    const server = await httpServer((request, response) => {
      requests.push(request.url!); response.writeHead(200, { "content-type": "application/json" }); response.write('{"partial":');
    });
    t.after(server.close);
    const stdout = new PassThrough(); const external = new AbortController(); const lifetime = new FollowLifetime(stdout, external.signal);
    let receivedHeaders!: () => void; const headersReady = new Promise<void>((resolve) => { receivedHeaders = resolve; });
    const http = new HttpClient(async (input, options) => {
      const response = await fetch(input, options); receivedHeaders(); return response;
    });
    try {
      const operation = http.request(server.origin, "/api/poll", { signal: lifetime.signal }).catch((error: unknown) => error);
      await headersReady; await setImmediate();
      stop(expected.reason, lifetime, stdout, external);
      const original = await operation;
      assert.ok(original instanceof CliError); assert.equal(original.exitCode, 5);
      assert.equal(original.details.code, "TRANSPORT_FAILED", "exercise an actual in-flight HTTP body failure");
      const evidence: ErrorDetails = { phase: "follow", effect: "not_applicable", context: { workspaceId: "w", sessionId: "s", runId: "r" } };
      assertStopped(lifetime.failure(withErrorDetails(original, evidence)), expected, evidence);
      assert.deepEqual(requests, ["/api/poll"], "a local stop must not send a remote cancel");
    } finally { lifetime.dispose(); stdout.destroy(); }
  }
});
