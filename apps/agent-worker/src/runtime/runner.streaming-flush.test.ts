import assert from "node:assert/strict";
import test from "node:test";
import type { streamText } from "ai";
import { AgentRunner, ControlWritePermanentError } from "./runner.js";
import { InternalRpcHttpError, InternalRpcInvalidResponseError, InternalRpcNetworkError } from "./apiClient.js";

type StreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text?: string; delta?: string }
  | { type: "tool-call"; toolName: string; toolCallId?: string; input?: unknown }
  | { type: "finish"; usage?: Record<string, unknown> }
  | { type: "error"; error: unknown };

type StreamResultLike = {
  fullStream: AsyncIterable<StreamChunk>;
  reasoningText?: PromiseLike<unknown>;
  usage?: PromiseLike<unknown> | unknown;
  totalUsage?: PromiseLike<unknown> | unknown;
  response?: PromiseLike<unknown> | unknown;
};

function baseProfile() {
  return {
    model: { id: "gpt-4o-mini" },
    provider: { npm: "@ai-sdk/openai", options: { apiKey: "test-key" } },
    agent: {
      tools: ["read"],
      pluginTools: [],
      mcpServers: []
    },
    runtime: { modelRequestRetryBackoffMaxMs: 60_000 }
  };
}

function baseContext() {
  return {
    pendingTools: [],
    tools: [],
    headMessageId: null,
    sessionRevision: 0,
    system: "",
    messages: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: []
  };
}

function baseRun() {
  return {
    workspaceId: "ws_test",
    sessionId: "sess_test",
    runId: "run_test",
    workspacePath: process.cwd(),
    workspaceRepoDirNames: [],
    inputText: "hello"
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControlledStream() {
  type QueueItem = {
    chunk?: StreamChunk;
    ack: Promise<void>;
    resolveAck: () => void;
    rejectAck: (reason?: unknown) => void;
  };

  const queue: QueueItem[] = [];
  const waiters: Array<(result: IteratorResult<StreamChunk>) => void> = [];
  let ended = false;
  let inFlightAck: { resolve: () => void; reject: (reason?: unknown) => void } | null = null;
  let closeAck = deferred<void>();
  let terminalError: unknown = null;

  const settlePrevious = () => {
    const previous = inFlightAck;
    inFlightAck = null;
    previous?.resolve();
  };

  const failPending = (reason: unknown) => {
    const previous = inFlightAck;
    inFlightAck = null;
    previous?.reject(reason);
    while (queue.length > 0) {
      const item = queue.shift();
      item?.rejectAck(reason);
    }
    closeAck.reject(reason);
  };

  const next = async (): Promise<IteratorResult<StreamChunk>> => {
    settlePrevious();
    if (terminalError) throw terminalError;
    const item = queue.shift();
    if (item) {
      if (item.chunk) {
        inFlightAck = { resolve: item.resolveAck, reject: item.rejectAck };
        return { value: item.chunk, done: false };
      }
      item.resolveAck();
      closeAck.resolve();
      return { value: undefined, done: true };
    }
    if (ended) {
      closeAck.resolve();
      return { value: undefined, done: true };
    }
    return await new Promise<IteratorResult<StreamChunk>>((resolve, reject) => {
      waiters.push((result) => {
        if (terminalError) {
          reject(terminalError);
          return;
        }
        resolve(result);
      });
    });
  };

  const fullStream = {
    [Symbol.asyncIterator]() {
      return {
        next,
        async return(): Promise<IteratorReturnResult<undefined>> {
          settlePrevious();
          closeAck.resolve();
          ended = true;
          return { value: undefined, done: true as const };
        }
      };
    }
  };

  const reasoning = deferred<string>();
  const usage = deferred<Record<string, unknown>>();

  const enqueue = (item: QueueItem) => {
    const waiter = waiters.shift();
    if (waiter) {
      if (item.chunk) {
        inFlightAck = { resolve: item.resolveAck, reject: item.rejectAck };
        waiter({ value: item.chunk, done: false });
        return;
      }
      item.resolveAck();
      closeAck.resolve();
      waiter({ value: undefined, done: true });
      return;
    }
    queue.push(item);
  };

  return {
    stream: {
      fullStream,
      reasoningText: reasoning.promise,
      usage: usage.promise
    } satisfies StreamResultLike,
    async push(chunk: StreamChunk) {
      const ack = deferred<void>();
      enqueue({ chunk, ack: ack.promise, resolveAck: ack.resolve, rejectAck: ack.reject });
      return await ack.promise;
    },
    async finish(options?: { reasoningText?: string; usage?: Record<string, unknown> }) {
      ended = true;
      reasoning.resolve(options?.reasoningText ?? "");
      usage.resolve(options?.usage ?? { inputTokens: 1, outputTokens: 1 });
      const ack = deferred<void>();
      closeAck = ack;
      enqueue({ ack: ack.promise, resolveAck: ack.resolve, rejectAck: ack.reject });
      return await ack.promise;
    },
    fail(reason: unknown) {
      terminalError = reason;
      failPending(reason);
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined, done: true });
      }
    }
  };
}

function createRunnerHarness(options?: {
  stream?: ReturnType<typeof createControlledStream>;
  streams?: Array<ReturnType<typeof createControlledStream>>;
  nowMs?: () => number;
  createResults?: Array<unknown>;
  listTools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; source: string }>;
  onRunNotice?: (input: Record<string, unknown>) => void;
  flushResults?: Array<{ result: "updated" | "ignored" | "missing" } | Error>;
  completeResults?: Array<{ result: "updated" | "ignored" | "missing" } | Error>;
  replaceResults?: Array<{ result: "updated" | "ignored" | "missing" }>;
  noticeResults?: Array<{ result: "updated" | "ignored" | "missing" } | Error>;
  resumeResults?: Array<{ result: "updated" | "ignored" | "missing" }>;
  controlWriteSleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
}) {
  const flushes: Array<{ messageId: string; parts: Array<Record<string, unknown>> }> = [];
  const completions: Array<Record<string, unknown>> = [];
  const createdMessages: Array<Record<string, unknown>> = [];
  const replacements: Array<Record<string, unknown>> = [];
  const runNoticeUpdates: Array<Record<string, unknown>> = [];
  const streamRequests: unknown[] = [];
  const resumeRequests: Array<Record<string, unknown>> = [];
  const terminalCompletions: Array<Record<string, unknown>> = [];
  const logger = { info() {}, warn() {}, error() {} };
  const apiClient = {
    async getExecutionProfile() { return baseProfile(); },
    async getPromptContext() { return baseContext(); },
    async createStreamingAssistant(input: Record<string, unknown>) {
      createdMessages.push(input);
      const result = options?.createResults?.shift();
      if (result instanceof Error) throw result;
      return { result: "updated" };
    },
    async flushAssistantParts(input: { messageId: string; parts: Array<Record<string, unknown>> }) {
      flushes.push({ messageId: input.messageId, parts: input.parts });
      const result = options?.flushResults?.shift() ?? { result: "updated" as const };
      if (result instanceof Error) throw result;
      return result;
    },
    async resumeStreamingAssistant(input: Record<string, unknown>) {
      resumeRequests.push(input);
      const result = options?.resumeResults?.shift() ?? { result: "updated" as const };
      return result;
    },
    async replaceStreamingAssistant(input: Record<string, unknown>) {
      replacements.push(input);
      const result = options?.replaceResults?.shift()?.result ?? "updated";
      return { result, message: result === "updated" ? { id: input.newMessageId } : null };
    },
    async completeAssistant(input: Record<string, unknown>) {
      completions.push(input);
      const result = options?.completeResults?.shift() ?? { result: "updated" as const };
      if (result instanceof Error) throw result;
      return result;
    },
    async updateRunNotice(input: Record<string, unknown>) {
      runNoticeUpdates.push(input);
      options?.onRunNotice?.(input);
      const result = options?.noticeResults?.shift() ?? { result: "updated" };
      if (result instanceof Error) throw result;
      return result;
    },
    async completeRun(input: Record<string, unknown>) {
      terminalCompletions.push(input);
    }
  };
  const runner = new AgentRunner(
    apiClient as any,
    {} as any,
    logger,
    1,
    {
      streamText: (((input: unknown) => {
        streamRequests.push(input);
        const stream = options?.streams?.shift() ?? options?.stream;
        return stream?.stream;
      }) as unknown) as typeof streamText,
      nowMs: options?.nowMs,
      controlWriteSleep: options?.controlWriteSleep
    }
  );
  (runner as any).toolRegistry.listTools = async () => options?.listTools ?? [
    { name: "read", description: "fixture read", inputSchema: { type: "object", properties: {} }, source: "builtin" }
  ];
  return { runner, flushes, createdMessages, replacements, completions, runNoticeUpdates, streamRequests, resumeRequests, terminalCompletions };
}

function startRunModelStep(params: {
  stream?: ReturnType<typeof createControlledStream>;
  streams?: Array<ReturnType<typeof createControlledStream>>;
  backoffMaxMs?: number;
  nowMs?: () => number;
  signal?: AbortSignal;
  createResults?: Array<unknown>;
  onRunNotice?: (input: Record<string, unknown>) => void;
  flushResults?: Array<{ result: "updated" | "ignored" | "missing" } | Error>;
  completeResults?: Array<{ result: "updated" | "ignored" | "missing" } | Error>;
  replaceResults?: Array<{ result: "updated" | "ignored" | "missing" }>;
  noticeResults?: Array<{ result: "updated" | "ignored" | "missing" } | Error>;
  resumeResults?: Array<{ result: "updated" | "ignored" | "missing" }>;
  controlWriteSleep?: (ms: number, signal: AbortSignal) => Promise<boolean>;
}) {
  const harness = createRunnerHarness({
    stream: params.stream,
    streams: params.streams,
    nowMs: params.nowMs,
    createResults: params.createResults,
    onRunNotice: params.onRunNotice,
    flushResults: params.flushResults,
    completeResults: params.completeResults,
    replaceResults: params.replaceResults,
    noticeResults: params.noticeResults,
    resumeResults: params.resumeResults,
    controlWriteSleep: params.controlWriteSleep
  });
  const promise = (harness.runner as any).runModelStep({
    profile: { ...baseProfile(), runtime: { modelRequestRetryBackoffMaxMs: params.backoffMaxMs ?? 60_000 } },
    run: baseRun(),
    context: baseContext(),
    step: 1,
    signal: params.signal ?? new AbortController().signal,
    recoveryContinuation: { messageId: null },
    repeatedToolCallCounter: new Map()
  });
  return { ...harness, promise };
}

test("runModelStep: 恢复 continuation 认领成功后复用 streaming Assistant", async () => {
  const stream = createControlledStream();
  const harness = createRunnerHarness({ stream });
  const continuation = { messageId: "msg_recovered" };
  const promise = (harness.runner as any).runModelStep({
    profile: baseProfile(), run: baseRun(), context: baseContext(), step: 1,
    signal: new AbortController().signal, recoveryContinuation: continuation,
    repeatedToolCallCounter: new Map(),
  });
  await stream.push({ type: "text-delta", text: "recovered" });
  await stream.finish();
  await promise;
  assert.deepEqual(harness.resumeRequests, [{ workspaceId: "ws_test", sessionId: "sess_test", runId: "run_test", messageId: "msg_recovered" }]);
  assert.equal(harness.createdMessages.length, 0);
  assert.equal(harness.flushes[0]?.messageId, "msg_recovered");
  assert.equal(harness.completions[0]?.messageId, "msg_recovered");
  assert.equal(continuation.messageId, null);
});

test("runModelStep: 恢复 continuation 认领失效时停止，不创建 Message 或调用模型", async () => {
  const stream = createControlledStream();
  const harness = createRunnerHarness({ stream, resumeResults: [{ result: "ignored" }] });
  await assert.rejects((harness.runner as any).runModelStep({
    profile: baseProfile(), run: baseRun(), context: baseContext(), step: 1,
    signal: new AbortController().signal, recoveryContinuation: { messageId: "msg_stale" },
    repeatedToolCallCounter: new Map(),
  }), /fenced write ignored/);
  assert.equal(harness.createdMessages.length, 0);
  assert.equal(harness.streamRequests.length, 0);
});

test("runModelStep: streaming Assistant 创建 post-commit response-loss 使用同一不可变请求重放", async () => {
  const stream = createControlledStream();
  const started = startRunModelStep({
    stream,
    createResults: [
      new InternalRpcNetworkError({ method: "POST", endpoint: "/streaming-assistants" }),
      { result: "updated" },
    ],
    controlWriteSleep: async () => true,
  });

  await stream.push({ type: "text-delta", text: "after replay" });
  await stream.finish();
  await started.promise;

  assert.equal(started.createdMessages.length, 2);
  assert.deepEqual(started.createdMessages[1], started.createdMessages[0]);
  assert.equal(started.streamRequests.length, 1);
  assert.equal(started.completions.length, 1);
});

test("streaming Assistant 重放冲突是永久控制面错误，不重试且收敛 Run failed", async () => {
  const stream = createControlledStream();
  const sleepCalls: number[] = [];
  const harness = createRunnerHarness({
    stream,
    createResults: [new InternalRpcHttpError({
      method: "POST",
      endpoint: "/api/internal/agent/streaming-assistants",
      status: 409,
      apiCode: "AGENT_STREAMING_ASSISTANT_REPLAY_MISMATCH",
      safeMessage: "streaming assistant replay does not match existing message",
    })],
    controlWriteSleep: async (ms) => {
      sleepCalls.push(ms);
      return true;
    },
  });

  await (harness.runner as any).processRun(baseRun(), new AbortController().signal);

  assert.equal(harness.createdMessages.length, 1);
  assert.equal(harness.streamRequests.length, 0);
  assert.deepEqual(sleepCalls, []);
  assert.deepEqual(harness.terminalCompletions.map((input) => input.status), ["failed"]);
});

test("runModelStep: streaming Assistant 创建重试可由取消打断", async () => {
  const stream = createControlledStream();
  const controller = new AbortController();
  const started = startRunModelStep({
    stream,
    signal: controller.signal,
    createResults: [new InternalRpcNetworkError({ method: "POST", endpoint: "/streaming-assistants" })],
    controlWriteSleep: async (_ms, signal) => {
      controller.abort();
      return !signal.aborted;
    },
  });

  await assert.rejects(started.promise, /fenced write ignored/);
  assert.equal(started.createdMessages.length, 1);
  assert.equal(started.streamRequests.length, 0);
});

test("runModelStep: 100 chars 且 <1s 时不发生阈值驱动的中途 streaming flush，正常结束保存尾段与 reasoning", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "x".repeat(100) });
  assert.equal(started.flushes.filter((flush) => flush.parts.some((part) => part.type === "text")).length, 0);

  await stream.finish({ reasoningText: "final reasoning", usage: { inputTokens: 1, outputTokens: 2 } });
  const result = await started.promise;

  assert.equal(result.aborted, false);
  assert.equal(started.flushes.length, 2);
  assert.equal(started.completions.length, 1);
  assert.equal(started.flushes[0]?.parts.find((part) => part.type === "text")?.text, "x".repeat(100));
  assert.deepEqual(({ text: started.flushes[1]?.parts.find((part) => part.type === "reasoning")?.text }), { text: "final reasoning" });
});

test("runModelStep: 达到 160 chars 时在 finish 前触发 streaming flush", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "a".repeat(160) });
  const streaming = started.flushes.filter((flush) => flush.parts.some((part) => part.type === "text"));
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0]?.parts.find((part) => part.type === "text")?.text, "a".repeat(160));

  await stream.finish({ usage: { inputTokens: 1, outputTokens: 2 } });
  await started.promise;
});

test("runModelStep: 按 Provider 原始交错顺序保存 text → tool → text，execution 关联实际 ToolCallPart", async () => {
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream });

  await stream.push({ type: "text-delta", text: "before" });
  await stream.push({ type: "tool-call", toolName: "read", toolCallId: "call-read", input: { filePath: "a.ts" } });
  await stream.push({ type: "text-delta", text: "after" });
  await stream.finish();
  await started.promise;

  const parts = started.flushes.at(-1)!.parts;
  assert.deepEqual(parts.map((part) => [part.type, part.position]), [
    ["text", 0], ["tool_call", 1], ["text", 2],
  ]);
  assert.deepEqual(parts.map((part) => part.id), [
    `${started.completions[0]?.messageId}:part:0`,
    `${started.completions[0]?.messageId}:part:1`,
    `${started.completions[0]?.messageId}:part:2`,
  ]);
  assert.equal((started.completions[0]?.executions as Array<Record<string, unknown>>)[0]?.callPartId, parts[1]?.id);
});

test("runModelStep: reasoning、text 和多个 ToolCall 保留原始交错 Part 序列", async () => {
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream });

  await stream.push({ type: "reasoning-delta", text: "r1" });
  await stream.push({ type: "text-delta", text: "t1" });
  await stream.push({ type: "tool-call", toolName: "read", toolCallId: "call-one", input: { filePath: "one" } });
  await stream.push({ type: "reasoning-delta", text: "r2" });
  await stream.push({ type: "tool-call", toolName: "read", toolCallId: "call-two", input: { filePath: "two" } });
  await stream.push({ type: "text-delta", text: "t2" });
  await stream.finish();
  await started.promise;

  const parts = started.flushes.at(-1)!.parts;
  assert.deepEqual(parts.map((part) => part.type), ["reasoning", "text", "tool_call", "reasoning", "tool_call", "text"]);
  assert.deepEqual(parts.map((part) => part.position), [0, 1, 2, 3, 4, 5]);
  const executions = started.completions[0]?.executions as Array<Record<string, unknown>>;
  assert.deepEqual(executions.map((execution) => execution.callPartId), [parts[2]?.id, parts[4]?.id]);
});

test("runModelStep: 多次 flush 仅追加或更新末尾 Part，既有 Part ID 和 position 稳定", async () => {
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream });

  await stream.push({ type: "text-delta", text: "a".repeat(160) });
  const first = started.flushes.at(-1)!.parts;
  await stream.push({ type: "tool-call", toolName: "read", toolCallId: "call-stable", input: {} });
  await stream.push({ type: "text-delta", text: "b".repeat(160) });
  await stream.finish();
  await started.promise;

  const last = started.flushes.at(-1)!.parts;
  assert.deepEqual(first.map((part) => ({ id: part.id, position: part.position, text: part.text })), [{
    id: last[0]?.id, position: last[0]?.position, text: "a".repeat(160),
  }]);
  assert.deepEqual(last.map((part) => part.type), ["text", "tool_call", "text"]);
});

test("runModelStep: 100 chars 且 300ms 时在 finish 前不触发 streaming flush", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "hello".repeat(20) });
  now = 300;
  await stream.push({ type: "reasoning-delta", text: "r" });
  assert.equal(started.flushes.filter((flush) => flush.parts.some((part) => part.type === "text")).length, 0);

  await stream.finish({ reasoningText: "r", usage: { inputTokens: 1, outputTokens: 2 } });
  await started.promise;
});

test("runModelStep: 100 chars 且 1000ms 时在 finish 前按时间阈值触发 streaming flush", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "hello".repeat(20) });
  now = 1_000;
  await stream.push({ type: "reasoning-delta", text: "r" });
  const streaming = started.flushes.filter((flush) => flush.parts.some((part) => part.type === "text"));
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0]?.parts.find((part) => part.type === "text")?.text, "hello".repeat(20));
  assert.equal(streaming[0]?.parts.find((part) => part.type === "reasoning")?.text, "r");

  await stream.finish({ reasoningText: "r", usage: { inputTokens: 1, outputTokens: 2 } });
  await started.promise;
});

test("runModelStep: tool-call step 前未达阈值文本会在 completed 中保存", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "preface" });
  assert.equal(started.flushes.filter((flush) => flush.parts.some((part) => part.type === "text")).length, 0);
  assert.equal(started.completions.length, 0);

  await stream.push({ type: "tool-call", toolName: "read", toolCallId: "call_read_1", input: { filePath: "README.md" } });
  assert.equal(started.completions.length, 0);

  await stream.finish({ usage: { inputTokens: 1, outputTokens: 2 } });
  const result = await started.promise;

  assert.equal(result.toolCallCount, 1);
  const completed = started.completions;
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.messageId ? "preface" : undefined, "preface");
  assert.equal(started.completions.some((item) => Array.isArray(item.executions) && (item.executions as Array<Record<string, unknown>>).some((execution) => execution.callPartId != null)), true);
});

test("runModelStep: 空输出重试复用同一 streaming Assistant，并清除重试提示", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
  const emptyStream = createControlledStream();
  const successfulStream = createControlledStream();
    const started = await startRunModelStep({ streams: [emptyStream, successfulStream] });

    void emptyStream.finish({ usage: { inputTokens: 90, outputTokens: 10 } });
    void successfulStream.push({ type: "text-delta", text: "ok" });
    void successfulStream.finish({ usage: { inputTokens: 3, outputTokens: 4 } });
    const result = await started.promise;

    assert.equal(result.hasVisibleText, true);
    assert.equal(started.createdMessages.length, 1);
    assert.equal(started.replacements.length, 0);
    assert.equal(started.completions.length, 1);
    const retryNotice = started.runNoticeUpdates.find((update) => String(update.runNoticeText ?? "").includes("Request failed, retrying"));
    assert.equal(retryNotice?.retryCount, 1);
    assert.equal(typeof retryNotice?.nextRetryAt, "number");
    assert.ok(started.runNoticeUpdates.some((update) => update.runNoticeText === "" && update.nextRetryAt === null));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("fenced flush 网络异常会保留完整 Part 快照并在写回恢复后完成", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    const stream = createControlledStream();
    const started = startRunModelStep({ stream, flushResults: [new InternalRpcNetworkError({ method: "POST", endpoint: "/flush" }), { result: "updated" }] });
    await stream.push({ type: "text-delta", text: "text".repeat(40) });
    await stream.push({ type: "reasoning-delta", text: "reasoning" });
    await stream.push({ type: "tool-call", toolName: "read", toolCallId: "call-1", input: { filePath: "one" } });
    await stream.push({ type: "tool-call", toolName: "read", toolCallId: "call-2", input: { filePath: "two" } });
    await stream.finish();
    const result = await started.promise;
    assert.equal(result.aborted, false);
    assert.equal(started.flushes.length >= 3, true);
    const retried = started.flushes.find((flush) => flush.parts.some((part) => part.type === "reasoning") && flush.parts.filter((part) => part.type === "tool_call").length === 2)!;
    assert.equal(retried.parts.find((part) => part.type === "text")?.text, "text".repeat(40));
    assert.equal(retried.parts.find((part) => part.type === "reasoning")?.text, "reasoning");
    assert.deepEqual(retried.parts.filter((part) => part.type === "tool_call").map((part) => part.providerToolCallId), ["call-1", "call-2"]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

for (const result of ["ignored", "missing"] as const) {
  test(`fenced flush ${result} 会立即停止且不完成或再次请求模型`, async () => {
    const stream = createControlledStream();
    const started = startRunModelStep({ stream, flushResults: [{ result }] });
    await stream.push({ type: "text-delta", text: "x".repeat(160) });
    await assert.rejects(started.promise, new RegExp(`fenced write ${result}: flush assistant parts`));
    assert.equal(started.completions.length, 0);
    assert.equal(started.streamRequests.length, 1);
  });

  test(`fenced complete ${result} 会立即停止后续流程`, async () => {
    const stream = createControlledStream();
    const started = startRunModelStep({ stream, completeResults: [{ result }] });
    await stream.push({ type: "text-delta", text: "done" });
    await stream.finish();
    await assert.rejects(started.promise, new RegExp(`fenced write ${result}: complete assistant`));
    assert.equal(started.completions.length, 1);
    assert.equal(started.streamRequests.length, 1);
  });
}

test("partial retry replacement 原子写入 retry notice，且 ignored 不会开始下一次模型请求", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    const failed = createControlledStream();
    const next = createControlledStream();
    const started = startRunModelStep({ streams: [failed, next], replaceResults: [{ result: "ignored" }] });
    await failed.push({ type: "text-delta", text: "partial" });
    await failed.push({ type: "error", error: new Error("request failed: 500") }).catch(() => undefined);
    await assert.rejects(started.promise, /fenced write ignored: replace streaming assistant/);
    assert.equal(started.replacements.length, 1);
    assert.equal(typeof started.replacements[0]?.runNoticeText, "string");
    assert.equal(started.replacements[0]?.retryCount, 1);
    assert.equal(typeof started.replacements[0]?.nextRetryAt, "number");
    assert.equal(started.runNoticeUpdates.length, 0);
    assert.equal(started.streamRequests.length, 1);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

const providerRetryErrors = [
  ...[400, 401, 403, 404, 429, 500].map((status) => ({
    name: `HTTP ${status}`,
    error: Object.assign(new Error(`provider HTTP ${status}`), { status, statusCode: status })
  })),
  { name: "network", error: new Error("ECONNRESET") }
];

for (const { name, error } of providerRetryErrors) {
  test(`模型错误 ${name} 持续退避并在后续成功后清理 retry notice`, async () => {
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
    try {
      const first = createControlledStream();
      const second = createControlledStream();
      const started = startRunModelStep({ streams: [first, second] });
      await first.push({ type: "error", error }).catch(() => undefined);
      await new Promise((resolve) => originalSetTimeout(resolve, 0));
      await second.push({ type: "text-delta", text: "recovered" });
      await second.finish();
      const result = await started.promise;
      assert.equal(result.aborted, false);
      assert.equal(started.streamRequests.length, 2);
      assert.equal(started.runNoticeUpdates[0]?.retryCount, 1);
      assert.equal(typeof started.runNoticeUpdates[0]?.nextRetryAt, "number");
      const cleared = started.runNoticeUpdates.find((update) => update.runNoticeText === "");
      assert.deepEqual(cleared && { retryCount: cleared.retryCount, nextRetryAt: cleared.nextRetryAt }, { retryCount: 0, nextRetryAt: null });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
}

for (const error of [
  ...[400, 401, 403, 404, 405, 409, 422].map((status) => new InternalRpcHttpError({ method: "POST", endpoint: "/complete", status })),
  new InternalRpcInvalidResponseError({ method: "POST", endpoint: "/complete", stage: "schema" }),
  new Error("programming bug")
]) {
  test(`永久控制面错误 ${error.name} 不进入 Provider retry 或 replacement`, async () => {
    const stream = createControlledStream();
    const started = startRunModelStep({ stream, completeResults: [error] });
    await stream.push({ type: "text-delta", text: "done" });
    await stream.finish();
    await assert.rejects(started.promise, ControlWritePermanentError);
    assert.equal(started.streamRequests.length, 1);
    assert.equal(started.replacements.length, 0);
  });
}

test("瞬态控制面 503 会原地恢复且不重发模型", async () => {
  const stream = createControlledStream();
  const sleeps: number[] = [];
  const started = startRunModelStep({
    stream,
    completeResults: [new InternalRpcHttpError({ method: "POST", endpoint: "/complete", status: 503 }), { result: "updated" }],
    controlWriteSleep: async (ms) => { sleeps.push(ms); return true; }
  });
  await stream.push({ type: "text-delta", text: "done" });
  await stream.finish();
  const result = await started.promise;
  assert.equal(result.aborted, false);
  assert.equal(started.streamRequests.length, 1);
  assert.equal(started.replacements.length, 0);
  assert.deepEqual(sleeps, [100]);
});

test("flush 与 complete 的控制面网络异常重试同一请求快照", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    originalSetTimeout(handler, typeof ms === "number" && ms >= 1_000 ? 0 : ms, ...args)) as typeof setTimeout;
  try {
    const stream = createControlledStream();
    const flushPayloads: Array<Record<string, unknown>> = [];
    const completePayloads: Array<Record<string, unknown>> = [];
    let flushAttempt = 0;
    let completeAttempt = 0;
    const runner = new AgentRunner({
      async createStreamingAssistant() { return { result: "updated" }; },
      async flushAssistantParts(input: Record<string, unknown>) {
        flushPayloads.push(input);
        flushAttempt += 1;
        if (flushAttempt === 1) throw new InternalRpcNetworkError({ method: "POST", endpoint: "/flush" });
        return { result: "updated" };
      },
      async completeAssistant(input: Record<string, unknown>) {
        completePayloads.push(input);
        completeAttempt += 1;
        if (completeAttempt === 1) throw new InternalRpcHttpError({ method: "POST", endpoint: "/complete", status: 503 });
        return { result: "updated" };
      },
      async updateRunNotice() { return { result: "updated" }; }
    } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
      streamText: (() => stream.stream) as unknown as typeof streamText,
      controlWriteSleep: async () => true,
      nowMs: (() => { let value = 0; return () => ++value; })()
    });
    (runner as any).toolRegistry.listTools = async () => [];
    const promise = (runner as any).runModelStep({
      profile: baseProfile(), run: baseRun(), context: baseContext(), step: 1,
      signal: new AbortController().signal, repeatedToolCallCounter: new Map()
    });
    await stream.push({ type: "text-delta", text: "recovered" });
    await stream.finish();
    await promise;
    assert.equal(flushPayloads.length, 3);
    assert.equal(completePayloads.length, 2);
    assert.strictEqual(flushPayloads[0], flushPayloads[1]);
    assert.strictEqual(completePayloads[0], completePayloads[1]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("clear retry notice 控制面网络失败恢复后不 replacement 且不重复模型请求", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    originalSetTimeout(handler, typeof ms === "number" && ms >= 1_000 ? 0 : ms, ...args)) as typeof setTimeout;
  try {
    const first = createControlledStream();
    const second = createControlledStream();
    const sleeps: number[] = [];
    const started = startRunModelStep({
      streams: [first, second],
      noticeResults: [{ result: "updated" }, new InternalRpcNetworkError({ method: "POST", endpoint: "/notice" }), { result: "updated" }],
      controlWriteSleep: async (ms) => { sleeps.push(ms); return true; }
    });
    await first.push({ type: "error", error: new Error("request failed: 500") }).catch(() => undefined);
    while (started.streamRequests.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    await second.push({ type: "text-delta", text: "recovered" });
    await second.finish();
    const result = await started.promise;
    assert.equal(result.aborted, false);
    assert.equal(started.streamRequests.length, 2);
    assert.equal(started.replacements.length, 0);
    assert.deepEqual(sleeps, [100]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("clear retry notice 持续控制面失败可由用户取消中断，且不 replacement 或再次模型调用", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) =>
    originalSetTimeout(handler, typeof ms === "number" && ms >= 1_000 ? 0 : ms, ...args)) as typeof setTimeout;
  try {
    const first = createControlledStream();
    const second = createControlledStream();
    const controller = new AbortController();
    let sleeps = 0;
    const started = startRunModelStep({
      streams: [first, second],
      signal: controller.signal,
      noticeResults: [{ result: "updated" }, new InternalRpcNetworkError({ method: "POST", endpoint: "/notice" })],
      controlWriteSleep: async () => {
        sleeps += 1;
        controller.abort();
        return false;
      }
    });
    await first.push({ type: "error", error: new Error("request failed: 500") }).catch(() => undefined);
    while (started.streamRequests.length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    await second.push({ type: "text-delta", text: "recovered" });
    await second.finish();
    const result = await started.promise;
    assert.equal(result.aborted, true);
    assert.equal(sleeps, 1);
    assert.equal(started.streamRequests.length, 2);
    assert.equal(started.replacements.length, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

function abortAwareTimeoutStream(signal: AbortSignal, busy: boolean): StreamResultLike {
  return {
    fullStream: (async function* () {
      while (!signal.aborted) {
        if (!busy) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        } else {
          yield { type: "text-delta" as const, text: "x" };
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
      const error = new Error("request aborted");
      error.name = "AbortError";
      throw error;
    })(),
    reasoningText: Promise.resolve(""), usage: Promise.resolve({})
  };
}

for (const mode of ["idle", "total"] as const) {
  test(`真实 ${mode} timeout 触发请求中断、Provider 重试并在第二次成功`, async () => {
    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) =>
      originalSetTimeout(handler, typeof ms === "number" && ms >= 1_000 ? 0 : ms, ...args)) as typeof setTimeout;
    try {
    const second = createControlledStream();
    let calls = 0;
    const aborted: boolean[] = [];
    const runner = new AgentRunner({
      async createStreamingAssistant() { return { result: "updated" }; },
      async flushAssistantParts() { return { result: "updated" }; },
      async replaceStreamingAssistant() { return { result: "updated", message: {} }; },
      async completeAssistant() { return { result: "updated" }; },
      async updateRunNotice() { return { result: "updated" }; }
    } as any, {} as any, { info() {}, warn() {}, error() {} }, 1, {
      streamText: ((request: { abortSignal: AbortSignal }) => {
        calls += 1;
        request.abortSignal.addEventListener("abort", () => aborted.push(true), { once: true });
        return calls === 1 ? abortAwareTimeoutStream(request.abortSignal, mode === "total") : second.stream;
      }) as unknown as typeof streamText,
      controlWriteSleep: async () => true
    });
    (runner as any).toolRegistry.listTools = async () => [];
    const promise = (runner as any).runModelStep({
      profile: { ...baseProfile(), runtime: mode === "idle"
        ? { modelIdleTimeoutMs: 20, modelRequestRetryBackoffMaxMs: 2_000 }
        : { modelTotalTimeoutMs: 20, modelRequestRetryBackoffMaxMs: 2_000 } },
      run: baseRun(), context: baseContext(), step: 1,
      signal: new AbortController().signal, repeatedToolCallCounter: new Map()
    });
    while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await second.push({ type: "text-delta", text: "recovered" });
    await second.finish();
    const result = await promise;
    assert.equal(result.aborted, false);
    assert.equal(calls, 2);
    assert.deepEqual(aborted, [true]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
}

test("runModelStep: reasoning-only 响应完整保存并作为有效完成", async () => {
  const reasoningStream = createControlledStream();
  const started = await startRunModelStep({ stream: reasoningStream });

  await reasoningStream.push({ type: "reasoning-delta", text: "internal reasoning only" });
  await reasoningStream.finish();

  const result = await started.promise;

  assert.equal(result.hasVisibleText, true);
  assert.equal(result.toolCallCount, 0);
  assert.equal(started.createdMessages.length, 1);
  assert.equal(started.replacements.length, 0);
  const lastReasoningFlush = [...started.flushes]
    .reverse()
    .find((flush) => flush.parts.some((part) => part.type === "reasoning"));
  assert.equal(lastReasoningFlush?.parts.find((part) => part.type === "reasoning")?.text, "internal reasoning only");
});

test("runModelStep: 部分 Text 失败先保存旧输出，再替代为新 Assistant", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    const failedStream = createControlledStream();
    const successfulStream = createControlledStream();
    const started = await startRunModelStep({ streams: [failedStream, successfulStream] });

    await failedStream.push({ type: "text-delta", text: "partial output" });
    void failedStream.push({ type: "error", error: new Error("boom") }).catch(() => undefined);
    void successfulStream.push({ type: "text-delta", text: "replacement output" });
    void successfulStream.finish();
    const result = await started.promise;

    assert.equal(started.replacements.length, 1);
    const oldMessageId = String(started.replacements[0]?.oldMessageId);
    const newMessageId = String(started.replacements[0]?.newMessageId);
    assert.notEqual(oldMessageId, newMessageId);
    assert.equal(started.flushes.some((flush) => flush.messageId === oldMessageId && flush.parts.some((part) => part.type === "text" && part.text === "partial output")), true);
    assert.equal(started.completions[0]?.messageId, newMessageId);
    assert.equal(result.assistantMessageId, newMessageId);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("runModelStep: 部分 ToolCall 按 provider 顺序保存到 superseded Assistant，且不创建旧执行", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    const failedStream = createControlledStream();
    const successfulStream = createControlledStream();
    const started = await startRunModelStep({ streams: [failedStream, successfulStream] });

    await failedStream.push({ type: "tool-call", toolName: "read", toolCallId: "old-1", input: { filePath: "one" } });
    await failedStream.push({ type: "tool-call", toolName: "read", toolCallId: "old-2", input: { filePath: "two" } });
    void failedStream.push({ type: "error", error: new Error("boom") }).catch(() => undefined);
    void successfulStream.push({ type: "tool-call", toolName: "read", toolCallId: "new-1", input: { filePath: "three" } });
    void successfulStream.finish();
    await started.promise;

    const oldMessageId = String(started.replacements[0]?.oldMessageId);
    const oldToolCalls = started.flushes
      .filter((flush) => flush.messageId === oldMessageId)
      .flatMap((flush) => flush.parts.filter((part) => part.type === "tool_call"));
    assert.deepEqual(oldToolCalls.at(-2)?.providerToolCallId, "old-1");
    assert.deepEqual(oldToolCalls.at(-1)?.providerToolCallId, "old-2");
    assert.equal(started.completions.length, 1);
    const executions = started.completions[0]?.executions as Array<Record<string, unknown>>;
    assert.equal(executions.length, 1);
    assert.equal(String(executions[0]?.callPartId).startsWith(`${started.replacements[0]?.newMessageId}:part:`), true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("runModelStep: partial retry replacement 分别保留旧新 Assistant 的有序 Part 和实际 execution 关联", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    const failedStream = createControlledStream();
    const successfulStream = createControlledStream();
    const started = await startRunModelStep({ streams: [failedStream, successfulStream] });

    await failedStream.push({ type: "text-delta", text: "old-before" });
    await failedStream.push({ type: "tool-call", toolName: "read", toolCallId: "old-call", input: { filePath: "old" } });
    void failedStream.push({ type: "error", error: new Error("retry") }).catch(() => undefined);
    await successfulStream.push({ type: "reasoning-delta", text: "new-reasoning" });
    await successfulStream.push({ type: "tool-call", toolName: "read", toolCallId: "new-call", input: { filePath: "new" } });
    await successfulStream.push({ type: "text-delta", text: "new-after" });
    await successfulStream.finish();
    await started.promise;

    const oldMessageId = String(started.replacements[0]?.oldMessageId);
    const newMessageId = String(started.replacements[0]?.newMessageId);
    const oldParts = started.flushes.filter((flush) => flush.messageId === oldMessageId).at(-1)!.parts;
    const newParts = started.flushes.filter((flush) => flush.messageId === newMessageId).at(-1)!.parts;
    assert.deepEqual(oldParts.map((part) => part.type), ["text", "tool_call"]);
    assert.deepEqual(newParts.map((part) => part.type), ["reasoning", "tool_call", "text"]);
    const execution = (started.completions[0]?.executions as Array<Record<string, unknown>>)[0]!;
    assert.equal(execution.callPartId, newParts[1]?.id);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("runModelStep: 部分 Reasoning 失败会替代消息，且下一次请求不携带 reasoning", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(handler, 0, ...args)) as typeof setTimeout;
  try {
    const failedStream = createControlledStream();
    const successfulStream = createControlledStream();
    const started = await startRunModelStep({ streams: [failedStream, successfulStream] });

    await failedStream.push({ type: "reasoning-delta", text: "private chain" });
    void failedStream.push({ type: "error", error: new Error("boom") }).catch(() => undefined);
    void successfulStream.push({ type: "text-delta", text: "answer" });
    void successfulStream.finish();
    await started.promise;

    assert.equal(started.replacements.length, 1);
    const oldMessageId = String(started.replacements[0]?.oldMessageId);
    assert.equal(started.flushes.some((flush) => flush.messageId === oldMessageId && flush.parts.some((part) => part.type === "reasoning" && part.text === "private chain")), true);
    assert.equal(JSON.stringify(started.streamRequests[1]).includes("private chain"), false);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("runModelStep: 在退避期间取消不会发起下一次模型请求", async () => {
  const controller = new AbortController();
  const failedStream = createControlledStream();
  const started = await startRunModelStep({
    stream: failedStream,
    signal: controller.signal,
    onRunNotice(input) {
      if (String(input.runNoticeText).includes("Request failed, retrying")) controller.abort();
    }
  });

  void failedStream.finish();
  const result = await started.promise;

  assert.equal(result.aborted, true);
  assert.equal(started.streamRequests.length, 1);
  assert.equal(started.completions.length, 0);
});

test("runModelStep 使用 Profile 的 120s 退避上限并在第六次重试等待 64000ms", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const observedDelays: number[] = [];
  (globalThis as any).setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (typeof ms === "number" && ms > 0) observedDelays.push(ms);
    return originalSetTimeout(handler, 0, ...args);
  }) as typeof setTimeout;

  try {
    const streams = Array.from({ length: 7 }, (_, index) => ({
      fullStream: (async function* () {
        if (index === 6) yield { type: "text-delta", text: "ok" };
        yield { type: "finish" };
      })(),
      reasoningText: Promise.resolve(""),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 })
    }));
    const runNoticeUpdates: Array<Record<string, unknown>> = [];
    const streamRequests: unknown[] = [];
    let streamCalls = 0;
    const runner = new AgentRunner(
      {
        async createStreamingAssistant() { return { result: "updated" }; },
        async flushAssistantParts() { return { result: "updated" }; },
        async completeAssistant() { return { result: "updated" }; },
        async updateRunNotice(input: Record<string, unknown>) { runNoticeUpdates.push(input); return { result: "updated" }; }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
      {
        streamText: ((input: unknown) => {
          streamRequests.push(input);
          return streams[streamCalls++];
        }) as unknown as typeof streamText
      }
    );
    (runner as any).toolRegistry.listTools = async () => [];

    const result = await (runner as any).runModelStep({
      profile: { ...baseProfile(), runtime: { modelRequestMaxRetries: 6, modelRequestRetryBackoffMaxMs: 120_000 } },
      run: baseRun(),
      context: baseContext(),
      step: 1,
      signal: new AbortController().signal,
      repeatedToolCallCounter: new Map()
    });

    assert.equal(result.aborted, false);
    assert.equal(streamRequests.length, 7);
    assert.deepEqual(observedDelays.slice(-6), [2_000, 4_000, 8_000, 16_000, 32_000, 64_000]);
    assert.ok(runNoticeUpdates.some((update) => String(update.runNoticeText || "").includes("64s")));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
