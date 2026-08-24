import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentContextItemRecord } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { AgentConflictError } from "../agent.store.js";
import { ContextWritebackApplication, type ContextWritebackApplicationDependencies } from "./context-writeback-application.js";

type AppendInput = Parameters<ContextWritebackApplication["appendContextItemFromWorker"]>[0];
type ApplicationDependencies = ContextWritebackApplicationDependencies;

function createAppendParams(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    workspaceId: "workspace",
    sessionId: "session",
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    output: { type: "user_text", text: "message" },
    ...overrides
  } as AppendInput;
}

function createItem(overrides: Partial<AgentContextItemRecord> = {}): AgentContextItemRecord {
  return {
    id: 7,
    workspaceId: "workspace",
    sessionId: "session",
    runId: null,
    turnId: null,
    step: null,
    prevId: null,
    kind: "user",
    status: "completed",
    archiveAt: null,
    boundaryReason: null,
    output: { type: "user_text", text: "message" },
    createdAt: 100,
    updatedAt: 100,
    ...overrides
  };
}

function createApplication(overrides: Partial<ApplicationDependencies> = {}) {
  const calls: unknown[][] = [];
  const dependencies: ApplicationDependencies = {
    appendWithRunFence(params) {
      calls.push(["append", params]);
      return { kind: "appended", item: createItem() };
    },
    nowMs: () => 100,
    formatTodolistTitle(value) {
      calls.push(["format-title", value]);
      return typeof value === "string" ? value.trim() : "";
    },
    updateSessionTitle(params) {
      calls.push(["update-title", params]);
    },
    isAppendConflict(error): error is { currentHeadItemId: number | null } {
      return error instanceof AgentConflictError;
    },
    warnAppendConflict(params) {
      calls.push(["warn-conflict", params]);
    },
    inspectForWorkerUpdate(itemId) {
      calls.push(["inspect", itemId]);
      return { kind: "updated", item: createItem({ status: "streaming", output: { type: "assistant_text", text: "draft" } }) };
    },
    uiArtifacts: {
      async writeApplyPatch(input) {
        calls.push(["write-apply-patch", input]);
        return { kind: "written", filePath: "/tmp/apply_patch.json" };
      },
      async writeWrite(input) {
        calls.push(["write-write", input]);
        return { kind: "written", filePath: "/tmp/write.json" };
      },
      async readApplyPatch() {
        throw new Error("not used in writeback application test");
      },
      async readWrite() {
        throw new Error("not used in writeback application test");
      }
    },
    logArtifactError(params) {
      calls.push(["artifact-error", params]);
    },
    logArtifactWarning(params) {
      calls.push(["artifact-warning", params]);
    },
    updateWithRunFence(params) {
      calls.push(["update", params]);
      return { kind: "updated", item: createItem({ status: params.status ?? "streaming", output: params.output ?? { type: "assistant_text", text: "draft" } }) };
    },
    ...overrides
  };
  return { application: new ContextWritebackApplication(dependencies), calls };
}

test("ContextWritebackApplication P3 owns append fence input and successful todolist title orchestration", () => {
  const item = createItem({
    kind: "tool",
    output: { type: "tool", toolName: "todolist", args: {}, result: { goal: "  Ship   P3  " } }
  });
  const { application, calls } = createApplication({
    appendWithRunFence(params) {
      calls.push(["append", params]);
      return { kind: "appended", item };
    },
    nowMs: () => 456
  });
  const params = createAppendParams({
    kind: "tool",
    output: { type: "tool", toolName: "todolist", args: {}, result: { goal: "ignored input goal" } }
  });

  const response = application.appendContextItemFromWorker(params);

  assert.deepEqual(response, { ok: true, item });
  assert.deepEqual(calls, [
    ["append", { ...params, createdAt: 456 }],
    ["format-title", "  Ship   P3  "],
    ["update-title", { sessionId: "session", title: "Ship   P3", updatedAt: 456 }]
  ]);
});

test("ContextWritebackApplication P3 keeps ignored append side-effect free", () => {
  const { application, calls } = createApplication({
    appendWithRunFence() {
      calls.push(["append"]);
      return { kind: "ignored" };
    }
  });

  assert.deepEqual(application.appendContextItemFromWorker(createAppendParams()), { ok: true, item: null, ignored: true });
  assert.deepEqual(calls, [["append"]]);
});

test("ContextWritebackApplication P3 preserves append error mappings and conflict warning", () => {
  const cases = [
    { result: { kind: "missing-session" } as const, statusCode: 404, message: "session not found" },
    { result: { kind: "missing-run" } as const, statusCode: 404, message: "run not found" },
    { result: { kind: "workspace-mismatch" } as const, statusCode: 400, message: "workspaceId mismatch" },
    { result: { kind: "run-mismatch" } as const, statusCode: 400, message: "workspaceId mismatch" }
  ];
  for (const entry of cases) {
    const { application } = createApplication({ appendWithRunFence: () => entry.result });
    assert.throws(
      () => application.appendContextItemFromWorker(createAppendParams()),
      (error: unknown) => error instanceof HttpError && error.statusCode === entry.statusCode && error.message === entry.message
    );
  }

  const { application, calls } = createApplication({
    appendWithRunFence() {
      throw new AgentConflictError(42);
    }
  });
  assert.throws(
    () => application.appendContextItemFromWorker(createAppendParams({ kind: "assistant" })),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.message === "session head conflict" && error.code === "conflict_head:42"
  );
  assert.deepEqual(calls, [["warn-conflict", { sessionId: "session", kind: "assistant", currentHeadItemId: 42 }]]);
});

test("ContextWritebackApplication P3 rejects completed apply_patch before calling append", () => {
  const { application, calls } = createApplication();
  assert.throws(
    () => application.appendContextItemFromWorker(createAppendParams({
      kind: "tool",
      status: "completed",
      output: { type: "tool", toolName: "apply_patch", args: {}, result: { before: "before", after: "after" } }
    })),
    (error: unknown) => error instanceof HttpError && error.statusCode === 400 && error.message === "apply_patch completed tool item must be updated, not appended"
  );
  assert.deepEqual(calls, []);
});

test("ContextWritebackApplication P5 preserves initial and final update fences without artifact work for ordinary output", async () => {
  const nextOutput = { type: "assistant_text" as const, text: "final" };
  const { application, calls } = createApplication();
  const params = { itemId: 7, status: "completed" as const, output: nextOutput };

  const response = await application.updateContextItemFromWorker(params);

  assert.deepEqual(response, createItem({ status: "completed", output: nextOutput }));
  assert.deepEqual(calls, [
    ["inspect", 7],
    ["update", { itemId: 7, status: "completed", output: nextOutput, updatedAt: 100 }]
  ]);
});

test("ContextWritebackApplication P4 maps initial update fences without artifact, final fence, or title side effects", async () => {
  const cases = [
    { result: { kind: "missing" } as const, statusCode: 404, message: "context item not found" },
    { result: { kind: "ownership-mismatch" } as const, statusCode: 404, message: "context item ownership mismatch" }
  ];
  for (const entry of cases) {
    const { application, calls } = createApplication({ inspectForWorkerUpdate: () => entry.result });
    await assert.rejects(
      () => application.updateContextItemFromWorker({ itemId: 7 }),
      (error: unknown) => error instanceof HttpError && error.statusCode === entry.statusCode && error.message === entry.message
    );
    assert.deepEqual(calls, []);
  }

  const unchanged = createItem({ status: "completed" });
  const { application, calls } = createApplication({ inspectForWorkerUpdate: () => ({ kind: "unchanged", item: unchanged }) });
  assert.strictEqual(await application.updateContextItemFromWorker({ itemId: 7 }), unchanged);
  assert.deepEqual(calls, []);
});

test("ContextWritebackApplication P4 returns final unchanged item without title update", async () => {
  const unchanged = createItem({
    kind: "tool",
    status: "completed",
    output: { type: "tool", toolName: "todolist", args: {}, result: { goal: "must not title" } }
  });
  const { application, calls } = createApplication({
    updateWithRunFence(params) {
      calls.push(["update", params]);
      return { kind: "unchanged", item: unchanged };
    }
  });

  assert.strictEqual(await application.updateContextItemFromWorker({ itemId: 7 }), unchanged);
  assert.deepEqual(calls, [
    ["inspect", 7],
    ["update", { itemId: 7, status: undefined, output: undefined, updatedAt: 100 }]
  ]);
});

test("ContextWritebackApplication P5 writes apply_patch artifact before the final fence and stores its slim result", async () => {
  const { application, calls } = createApplication();
  await application.updateContextItemFromWorker({
    itemId: 7,
    status: "completed",
    updatedAt: 456,
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_apply_patch",
      args: { patchText: "patch" },
      result: {
        text: "ok",
        summary: { fileCount: 1, additions: 2, deletions: 1 },
        files: [{ type: "update", path: "file.ts", before: "before", after: "after", additions: 2, deletions: 1 }]
      }
    }
  });

  assert.deepEqual(calls.map(([kind]) => kind), ["inspect", "write-apply-patch", "update"]);
  assert.deepEqual(calls[1], ["write-apply-patch", {
    workspaceId: "workspace",
    toolCallId: "call_apply_patch",
    createdAt: 456,
    artifact: {
      schemaVersion: 1,
      toolName: "apply_patch",
      summary: { fileCount: 1, additions: 2, deletions: 1 },
      files: [{ type: "update", path: "file.ts", before: "before", after: "after", additions: 2, deletions: 1 }]
    }
  }]);
  assert.deepEqual((calls[2] as [string, { output: unknown }])[1].output, {
    type: "tool",
    toolName: "apply_patch",
    toolCallId: "call_apply_patch",
    args: { patchText: "patch" },
    result: {
      text: "ok",
      summary: { fileCount: 1, additions: 2, deletions: 1 },
      files: [{ type: "update", path: "file.ts", additions: 2, deletions: 1 }]
    }
  });
});

test("ContextWritebackApplication P5 keeps write artifact completed-only and best-effort", async () => {
  const { application, calls } = createApplication({
    uiArtifacts: {
      async writeApplyPatch() { return { kind: "written", filePath: "/tmp/apply_patch.json" }; },
      async writeWrite() { throw new Error("disk failure"); },
      async readApplyPatch() { throw new Error("not used"); },
      async readWrite() { throw new Error("not used"); }
    }
  });
  const completedOutput = {
    type: "tool" as const, toolName: "write" as const, toolCallId: "call_write", args: { filePath: "a.txt", content: "after" },
    result: { filePath: "a.txt", bytesWritten: 5, existedBefore: false, before: { available: false }, after: { available: true, text: "after" } }
  };
  await application.updateContextItemFromWorker({ itemId: 7, status: "completed", output: completedOutput });
  assert.deepEqual(calls.map(([kind]) => kind), ["inspect", "artifact-error", "update"]);
  assert.deepEqual((calls[2] as [string, { output: { result: unknown } }])[1].output.result, {
    summary: "Wrote file a.txt", filePath: "a.txt", bytesWritten: 5, existedBefore: false
  });

  calls.length = 0;
  await application.updateContextItemFromWorker({ itemId: 7, status: "failed", output: completedOutput });
  assert.deepEqual(calls.map(([kind]) => kind), ["inspect", "update"]);
  assert.strictEqual((calls[1] as [string, { output: unknown }])[1].output, completedOutput);
});

test("ContextWritebackApplication P5 permits a successful artifact write before a final unchanged fence", async () => {
  const unchanged = createItem({ status: "streaming", output: { type: "assistant_text", text: "stored" } });
  const { application, calls } = createApplication({
    updateWithRunFence(params) {
      calls.push(["update", params]);
      return { kind: "unchanged", item: unchanged };
    }
  });

  assert.strictEqual(await application.updateContextItemFromWorker({
    itemId: 7,
    status: "completed",
    output: {
      type: "tool",
      toolName: "apply_patch",
      toolCallId: "call_race",
      args: { patchText: "patch" },
      result: { text: "ok", summary: {}, files: [] }
    }
  }), unchanged);

  assert.deepEqual(calls.map(([kind]) => kind), ["inspect", "write-apply-patch", "update"]);
  assert.deepEqual((calls[2] as [string, { output: { result: unknown } }])[1].output.result, {
    text: "ok",
    summary: { fileCount: 0, additions: 0, deletions: 0 },
    files: []
  });
});

test("ContextWritebackApplication P4 updates the title only after a successful completed todolist update", async () => {
  const updated = createItem({
    kind: "tool",
    status: "completed",
    output: { type: "tool", toolName: "todolist", args: {}, result: { goal: "  Ship P4  " } }
  });
  const { application, calls } = createApplication({
    updateWithRunFence(params) {
      calls.push(["update", params]);
      return { kind: "updated", item: updated };
    }
  });

  assert.strictEqual(await application.updateContextItemFromWorker({ itemId: 7, status: "completed" }), updated);
  assert.deepEqual(calls.slice(-2), [
    ["format-title", "  Ship P4  "],
    ["update-title", { sessionId: "session", title: "Ship P4", updatedAt: 100 }]
  ]);
});
