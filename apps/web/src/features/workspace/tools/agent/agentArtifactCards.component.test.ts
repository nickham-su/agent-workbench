import assert from "node:assert/strict";
import test from "node:test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const [{ mount }, applyPatchCard, writeCard, { workspaceHostKey }, { message }] = await Promise.all([
  import("@vue/test-utils"),
  import("./AgentApplyPatchCard.vue"),
  import("./AgentWriteCard.vue"),
  import("@/features/workspace/host"),
  import("ant-design-vue"),
]);

async function mountCard(component: "apply" | "write", props: Record<string, unknown>) {
  const calls: unknown[] = [];
  return {
    calls,
    wrapper: mount(component === "apply" ? applyPatchCard.default : writeCard.default, {
      attachTo: document.body,
      props: props as any,
      global: {
        provide: {
          [workspaceHostKey as symbol]: {
            openTool() {}, minimizeTool() {}, toggleMinimize() {}, setToolDot() {},
            callFrom(...args: unknown[]) { calls.push(args); },
            registerToolCommands() { return () => undefined; }, emitToolEvent() {},
          },
        },
      },
    }),
  };
}

function completedExecution() {
  return {
    id: "execution-a",
    callPartId: "call-a",
    status: "completed",
    resultPreview: null,
    resultTruncated: false,
    error: null,
    updatedRevision: 1,
    startedAt: 1_000,
    completedAt: 2_000,
  } as const;
}

const baseProps = {
  workspaceId: "ws-a",
  toolId: "agent-tool",
  sessionId: "session-a",
  toolExecutionId: "execution-a",
};

test("真实 AgentApplyPatchCard：scope props 更新后普通晚到响应不调用 host，fetch 获得 abort signal", async () => {
  const artifact = deferred<Response>();
  const originalFetch = globalThis.fetch;
  const originalError = message.error;
  let receivedSignal: AbortSignal | undefined;
  let errors = 0;
  globalThis.fetch = (async (_url, options) => {
    receivedSignal = options?.signal as AbortSignal;
    return artifact.promise;
  }) as typeof fetch;
  message.error = (() => { errors += 1; }) as typeof message.error;
  try {
    const { wrapper, calls } = await mountCard("apply", {
      ...baseProps,
      input: { patchText: "diff --git a/a.ts b/a.ts" },
      execution: completedExecution(),
      now: 2_000,
    });
    await wrapper.get("button").trigger("click");
    assert.ok(receivedSignal);
    await wrapper.setProps({ workspaceId: "ws-b" });
    await wrapper.setProps({ sessionId: "session-b" });
    await wrapper.setProps({ toolExecutionId: "execution-b" });
    assert.equal(receivedSignal.aborted, true);
    artifact.resolve(new Response(JSON.stringify({ files: [{ path: "a.ts", before: "a", after: "b" }] }), { status: 200 }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);
    assert.equal(errors, 0);
    wrapper.unmount();
  } finally {
    globalThis.fetch = originalFetch;
    message.error = originalError;
  }
});

test("真实 AgentApplyPatchCard：点击一次为 artifact 全部文件打开独立 Diff", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    files: [
      { path: "a.ts", before: "a", after: "a1" },
      { path: "b.ts", before: "b", after: "b1" },
    ],
  }), { status: 200 })) as typeof fetch;
  try {
    const { wrapper, calls } = await mountCard("apply", {
      ...baseProps,
      input: { patchText: "multi-file patch" },
      execution: completedExecution(),
      now: 2_000,
    });
    await wrapper.get("button").trigger("click");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => (call as any[])[2]), [
      {
        type: "editor.openDiff",
        payload: {
          original: "a", modified: "a1", path: "a.ts", language: "typescript",
          title: "a.ts", tabKey: "agent:applyPatch:execution-a:a.ts", source: "agent.applyPatch",
        },
      },
      {
        type: "editor.openDiff",
        payload: {
          original: "b", modified: "b1", path: "b.ts", language: "typescript",
          title: "b.ts", tabKey: "agent:applyPatch:execution-a:b.ts", source: "agent.applyPatch",
        },
      },
    ]);
    wrapper.unmount();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("真实 AgentWriteCard：卸载后普通晚到错误不调用 host 或 message.error", async () => {
  const artifact = deferred<Response>();
  const originalFetch = globalThis.fetch;
  const originalError = message.error;
  let receivedSignal: AbortSignal | undefined;
  let errors = 0;
  globalThis.fetch = (async (_url, options) => {
    receivedSignal = options?.signal as AbortSignal;
    return artifact.promise;
  }) as typeof fetch;
  message.error = (() => { errors += 1; }) as typeof message.error;
  try {
    const { wrapper, calls } = await mountCard("write", {
      ...baseProps,
      input: { filePath: "a.ts", content: "next" },
      execution: completedExecution(),
      now: 2_000,
    });
    await wrapper.get("button").trigger("click");
    assert.ok(receivedSignal);
    wrapper.unmount();
    assert.equal(receivedSignal.aborted, true);
    artifact.reject(new Error("ordinary late error"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, []);
    assert.equal(errors, 0);
  } finally {
    globalThis.fetch = originalFetch;
    message.error = originalError;
  }
});
