import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  AgentTabsSnapshotResponseSchema,
  type AgentSessionRecord,
  type AgentTabsSnapshotResponse,
  type ScheduledExecution,
  type ScheduledTask,
  type WorkspaceAgentSessionTabVisibilityMutation
} from "@agent-workbench/shared";
import { createAgentIntegrationFixture } from "../src/modules/agent/testkit/agent-integration-testkit.js";
import { appendMessage, createMessageSession, getMessageRunState, getRunRecord } from "../src/modules/agent/agent-message.store.js";
import { AgentSessionTabVisibilityController } from "../../web/src/features/workspace/tools/agent/agentSessionTabVisibilityState.js";
import { createAgentSessionTargetLoader } from "../../web/src/features/workspace/tools/agent/agentSessionTargetLoader.js";
import { createAgentSessionMetadataReads } from "../../web/src/features/workspace/tools/agent/agentSessionMetadataReadContext.js";

// Contract integration, not a browser test: use the actual frontend loader and
// write controller with real HTTP, auth, Fastify routes and a disk-backed DB.
// AgentToolView.component.test.ts separately exercises the Vue adapter and DOM.
for (const triggerMode of ["new_session", "fork_message"] as const) {
  test(`real HTTP frontend loader/controller opens, restores and closes a hidden ${triggerMode} execution`, { timeout: 30_000 }, async (t) => {
    const f = await createAgentIntegrationFixture({ agentWorkerConcurrency: 0, authToken: "release-fixture-login" });
    t.after(() => f.dispose());
    const origin = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "release-fixture-login" })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const mutations: Array<{ sessionId: string; visible: boolean }> = [];
    const request = async <T>(route: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> => {
      const response = await fetch(`${origin}${route}`, {
        method, headers: { cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])
      });
      assert.ok(response.ok, `${method} ${route} returned ${response.status}`);
      return await response.json() as T;
    };
    const workspaceId = f.workspaceId;
    const base = `/api/workspaces/${workspaceId}/scheduled-tasks`;
    if (triggerMode === "fork_message") {
      createMessageSession(f.db, { workspaceId, id: "source", kind: "primary", visibility: "unlisted", title: "source", createdAt: 1 });
      appendMessage(f.db, { workspaceId, sessionId: "source", id: "fixed-anchor", expectedHeadMessageId: null, expectedRevision: 0,
        type: "user", status: "completed", createdAt: 2, parts: [{ id: "anchor-part", position: 0, type: "text", text: "fixture context" }] });
    }
    const { task } = await request<{ task: ScheduledTask }>(base, "POST", {
      name: "HTTP fixture task", prompt: "local fixture prompt", agentId: "default", enabled: false, triggerMode,
      sourceSessionId: triggerMode === "fork_message" ? "source" : null,
      sourceMessageId: triggerMode === "fork_message" ? "fixed-anchor" : null,
      schedule: { kind: "hourly", minutesUtc: [0] }
    });
    const { execution } = await request<{ execution: ScheduledExecution }>(`${base}/${task.id}/run`, "POST", {});
    assert.equal(execution.sessionAvailable, true, "task navigation requires actual request-to-Run acceptance");
    assert.ok(execution.runId);
    const sessionId = execution.sessionId;
    assert.ok(sessionId);
    const runStateBefore = getMessageRunState(f.db, workspaceId, sessionId);
    const row = () => f.db.prepare("select visible from workspace_session_tab_state where workspace_id=? and session_id=?")
      .get(workspaceId, sessionId);
    assert.deepEqual(row(), { visible: 0 });

    let generation = 0;
    function frontendClient() {
      const context = { workspaceId, workspaceGeneration: ++generation };
      let live = true;
      const cache = new Map<string, AgentSessionRecord>();
      const errors: unknown[] = [];
      const reads = createAgentSessionMetadataReads(() => live ? context : null);
      const controller = new AgentSessionTabVisibilityController({
        isContextCurrent: (candidate) => live && candidate.workspaceId === workspaceId && candidate.workspaceGeneration === context.workspaceGeneration,
        onMutationError: (_id, error) => errors.push(error),
        request: (workspace, id, body) => {
          mutations.push({ sessionId: id, visible: body.visible });
          return request<WorkspaceAgentSessionTabVisibilityMutation>(`/api/workspaces/${workspace}/agent-tab-state/${id}`, "PUT", body);
        }
      });
      const loader = createAgentSessionTargetLoader({
        context: () => live ? context : null,
        capture: (id) => reads.captureReadToken(workspaceId, id),
        request: (token, signal) => request<AgentSessionRecord>(`/api/agent/sessions/${token.sessionId}?workspaceId=${workspaceId}`, "GET", undefined, signal),
        accept: reads.accept,
        commit: (record) => { cache.set(record.id, record); controller.rememberSession(record); },
        epoch: reads.epoch,
        confirmationEpoch: (id) => controller.getState(id)?.confirmationEpoch ?? 0
      });
      return {
        controller, cache, errors,
        async initialize() {
          const snapshot = controller.captureSnapshot();
          const result = await request<AgentTabsSnapshotResponse>(`/api/agent/sessions?workspaceId=${workspaceId}&scope=tabs`);
          assert.ok(Value.Check(AgentTabsSnapshotResponseSchema, result));
          assert.deepEqual(result.items.map((item) => item.id).sort(), [...result.tabState.openedSessionIds].sort());
          controller.applyInitializationSnapshot(result.items, result.tabState, snapshot);
          for (const record of result.items) cache.set(record.id, record);
          return result;
        },
        async openKnownTarget(id: string) {
          const read = await loader.read(id, { valid: () => live });
          assert.equal(read.status, "accepted");
          if (read.status !== "accepted") throw new Error("Target metadata was not accepted");
          // A successful metadata GET is not a persistence acknowledgement.
          assert.equal(controller.getEffectiveVisibility(read.record), undefined);
          assert.deepEqual(row(), { visible: 0 });
          const receipt = controller.requestVisibilityWithResult(read.record, true, context);
          assert.equal((await receipt.result).status, "confirmed");
          return read.record;
        },
        async close(id: string) {
          const record = cache.get(id);
          assert.ok(record);
          assert.equal((await controller.requestVisibilityWithResult(record, false, context).result).status, "confirmed");
        },
        dispose() { live = false; loader.reset(); controller.invalidateContext(); reads.reset(); }
      };
    }
    const clients: ReturnType<typeof frontendClient>[] = [];
    t.after(() => clients.forEach((client) => client.dispose()));
    const first = frontendClient(); clients.push(first);
    assert.equal((await first.initialize()).items.some((item) => item.id === sessionId), false);
    const record = await first.openKnownTarget(sessionId);
    assert.equal(record.visibility, "unlisted");
    assert.equal(first.controller.getEffectiveVisibility(record), true);
    assert.deepEqual(row(), { visible: 1 });
    first.dispose(); // A page reload discards every frontend cache and write receipt.

    const reloaded = frontendClient(); clients.push(reloaded);
    assert.ok((await reloaded.initialize()).items.some((item) => item.id === sessionId));
    assert.equal(reloaded.controller.getEffectiveVisibility(record), true);
    assert.deepEqual(mutations, [{ sessionId, visible: true }], "restoration itself must not submit another intent");
    await reloaded.close(sessionId);
    assert.deepEqual(row(), { visible: 0 });
    reloaded.dispose();
    const closedReload = frontendClient(); clients.push(closedReload);
    assert.equal((await closedReload.initialize()).items.some((item) => item.id === sessionId), false);
    assert.deepEqual(mutations, [{ sessionId, visible: true }, { sessionId, visible: false }]);
    for (const client of clients) assert.deepEqual(client.errors, []);
    const chooser = await request<{ items: AgentSessionRecord[] }>(`/api/agent/sessions?workspaceId=${workspaceId}&scope=continuable`);
    assert.equal(chooser.items.some((item) => item.id === sessionId), false);
    const finalRecord = await request<AgentSessionRecord>(`/api/agent/sessions/${sessionId}?workspaceId=${workspaceId}`);
    assert.equal(finalRecord.visibility, "unlisted");
    assert.deepEqual(getMessageRunState(f.db, workspaceId, sessionId), runStateBefore, "Tab transitions cannot cancel or start Runs");
    const history = await request<{ items: ScheduledExecution[] }>(`${base}/${task.id}/executions`);
    assert.equal(history.items[0]?.runId, execution.runId);
    assert.equal(history.items[0]?.sessionAvailable, true);
    // Closing a hidden running Tab did not cancel it; an explicit ordinary
    // cancel still uses the established lifecycle and leaves the actual Tab row.
    await request(`/api/agent/sessions/${sessionId}/cancel`, "POST", { workspaceId });
    assert.equal(getRunRecord(f.db, execution.runId!)?.status, "cancelled");
    assert.equal(getMessageRunState(f.db, workspaceId, sessionId)?.status, "idle");
    assert.deepEqual(row(), { visible: 0 });
    const cancelledHistory = await request<{ items: ScheduledExecution[] }>(`${base}/${task.id}/executions`);
    assert.equal(cancelledHistory.items[0]?.runId, execution.runId);
    assert.equal(cancelledHistory.items[0]?.sessionAvailable, true);
  });
}
