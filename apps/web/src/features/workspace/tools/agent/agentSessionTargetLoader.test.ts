import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionRecord } from "@agent-workbench/shared";
import { createAgentSessionMetadataReads } from "./agentSessionMetadataReadContext";
import { classifyTargetReadError, createAgentSessionTargetLoader } from "./agentSessionTargetLoader";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const record: AgentSessionRecord = { id: "s", workspaceId: "ws", kind: "primary", title: "Title", headMessageId: "head", contextRootMessageId: null, revision: 0, forkedFromSessionId: null, forkedFromMessageId: null, createdAt: 1, updatedAt: 1 };
function fixture() {
  let generation = 1;
  let confirmationEpoch = 0;
  const context = () => ({ workspaceId: "ws", workspaceGeneration: generation });
  const reads = createAgentSessionMetadataReads(context);
  const requests: Array<ReturnType<typeof deferred<AgentSessionRecord>> & { signal: AbortSignal }> = [];
  const committed: AgentSessionRecord[] = [];
  const loader = createAgentSessionTargetLoader({
    context, capture: (id) => reads.captureReadToken("ws", id),
    request: (_token, signal) => {
      const pending = deferred<AgentSessionRecord>();
      requests.push({ ...pending, signal });
      signal.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
      return pending.promise;
    },
    accept: reads.accept, commit: (value) => committed.push(value), epoch: reads.epoch,
    confirmationEpoch: () => confirmationEpoch,
  });
  return { loader, reads, requests, committed, switch: () => { generation++; }, confirm: () => { confirmationEpoch++; } };
}

test("concurrent consumers share one transport and one read token", async () => {
  const f = fixture();
  const first = f.loader.read("s", { valid: () => true });
  const second = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  assert.equal(f.requests.length, 1);
  f.requests[0]!.resolve(record);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, "accepted");
  assert.equal(b.status, "accepted");
  if (a.status === "accepted" && b.status === "accepted") assert.equal(a.token, b.token);
  assert.equal(f.committed.length, 1);
});

test("a local mutation protects the full record; a fresh retry can converge", async () => {
  const f = fixture();
  const first = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  f.reads.mutation("s");
  f.requests[0]!.resolve(record);
  assert.equal((await first).status, "protected");
  assert.equal(f.committed.length, 0);
  const second = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  f.requests[1]!.resolve({ ...record, title: "Updated" });
  assert.equal((await second).status, "accepted");
  assert.equal(f.requests.length, 2);
});

test("late 404 after a newer visibility confirmation is protected; current 404 terminates", async () => {
  const f = fixture();
  const first = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  f.confirm();
  f.requests[0]!.reject({ status: 404, code: "SESSION_NOT_FOUND" });
  assert.equal((await first).status, "protected");
  const second = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  f.requests[1]!.reject({ status: 404, code: "SESSION_NOT_FOUND" });
  const result = await second;
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.classification, "sessionNotFound");
});

test("cancelling one subscription keeps another alive; cancelling the last releases transport", async () => {
  const f = fixture();
  const abortA = new AbortController();
  const first = f.loader.read("s", { valid: () => true, signal: abortA.signal });
  const second = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  abortA.abort();
  assert.equal((await first).status, "cancelled");
  assert.equal(f.requests[0]!.signal.aborted, false);
  f.requests[0]!.resolve(record);
  assert.equal((await second).status, "accepted");
  const abortB = new AbortController();
  const third = f.loader.read("s", { valid: () => true, signal: abortB.signal });
  await Promise.resolve();
  abortB.abort();
  assert.equal((await third).status, "cancelled");
  assert.equal(f.requests[1]!.signal.aborted, true);
});

test("timeout/protocol failure releases the slot without retry; explicit retry starts a fresh read", async () => {
  const f = fixture();
  const first = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  f.requests[0]!.reject({ code: "AGENT_METADATA_GET_TIMEOUT" });
  const failed = await first;
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.equal(failed.classification, "transportTimeout");
  assert.equal(f.requests.length, 1);
  const second = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  f.requests[1]!.resolve({ ...record, workspaceId: "other" });
  const protocol = await second;
  assert.equal(protocol.status, "failed");
  if (protocol.status === "failed") assert.equal(protocol.classification, "protocol");
  assert.equal(f.committed.length, 0);
});


test("last cancellation immediately frees the slot for a synchronous retry", async () => {
  const f = fixture();
  const abort = new AbortController();
  const first = f.loader.read("s", { valid: () => true, signal: abort.signal });
  await Promise.resolve();
  abort.abort();
  const retry = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  assert.equal((await first).status, "cancelled");
  assert.equal(f.requests.length, 2);
  f.requests[1]!.resolve(record);
  assert.equal((await retry).status, "accepted");
  assert.deepEqual(f.committed, [record]);
});

test("only matching real 404 classifies unavailable; incomplete metadata never commits", async () => {
  assert.equal(classifyTargetReadError({ status: 401, code: "SESSION_NOT_FOUND" }), "unauthorized");
  assert.equal(classifyTargetReadError({ status: 500, code: "SESSION_NOT_FOUND" }), "serverError");
  assert.equal(classifyTargetReadError({ status: 404, code: "UNKNOWN" }), "network");
  const f = fixture();
  const pending = f.loader.read("s", { valid: () => true });
  await Promise.resolve();
  const { headMessageId: _head, ...incomplete } = record;
  f.requests[0]!.resolve(incomplete as AgentSessionRecord);
  const result = await pending;
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.classification, "protocol");
  assert.equal(f.committed.length, 0);
});
