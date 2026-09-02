import assert from "node:assert/strict";
import test from "node:test";
import type { streamText } from "ai";
import { AgentRunner } from "./runner.js";

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
    runtime: {}
  };
}

function baseContext() {
  return {
    pendingTools: [],
    tools: [],
    headItemId: null,
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
  maxRetries?: number;
  nowMs?: () => number;
  listTools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown>; source: string }>;
}) {
  const updates: Array<{ itemId?: number; status?: string; output?: Record<string, unknown> }> = [];
  const createdItems: Array<Record<string, unknown>> = [];
  const runStateUpdates: Array<Record<string, unknown>> = [];
  const logger = { info() {}, warn() {}, error() {} };
  const apiClient = {
    async createContextItem(input: Record<string, unknown>) {
      createdItems.push(input);
      return { item: { id: createdItems.length } };
    },
    async updateContextItem(input: { itemId?: number; status?: string; output?: Record<string, unknown> }) {
      updates.push({ itemId: input.itemId, status: input.status, output: input.output });
      return { id: input.itemId ?? 1 };
    },
    async updateRunState(input: Record<string, unknown>) {
      runStateUpdates.push(input);
      return;
    }
  };
  const runner = new AgentRunner(
    apiClient as any,
    {} as any,
    logger,
    1,
    {
      streamText: ((() => {
        const stream = options?.streams?.shift() ?? options?.stream;
        return stream?.stream;
      }) as unknown) as typeof streamText,
      nowMs: options?.nowMs
    }
  );
  (runner as any).toolRegistry.listTools = async () => options?.listTools ?? [
    { name: "read", description: "fixture read", inputSchema: { type: "object", properties: {} }, source: "builtin" }
  ];
  return { runner, updates, createdItems, runStateUpdates };
}

function startRunModelStep(params: {
  stream?: ReturnType<typeof createControlledStream>;
  streams?: Array<ReturnType<typeof createControlledStream>>;
  maxRetries?: number;
  nowMs?: () => number;
}) {
  const harness = createRunnerHarness({
    stream: params.stream,
    streams: params.streams,
    maxRetries: params.maxRetries,
    nowMs: params.nowMs
  });
  const promise = (harness.runner as any).runModelStep({
    profile: { ...baseProfile(), runtime: { modelRequestMaxRetries: params.maxRetries ?? 0 } },
    run: baseRun(),
    context: baseContext(),
    step: 1,
    signal: new AbortController().signal,
    repeatedToolCallCounter: new Map()
  });
  return { ...harness, promise };
}

test("runModelStep: 100 chars 且 <1s 时不发生阈值驱动的中途 streaming flush，正常结束保存尾段与 reasoning", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "x".repeat(100) });
  assert.equal(started.updates.filter((item) => item.status === "streaming").length, 0);

  await stream.finish({ reasoningText: "final reasoning", usage: { inputTokens: 1, outputTokens: 2 } });
  const result = await started.promise;

  assert.equal(result.aborted, false);
  assert.deepEqual(started.updates.map((item) => item.status), ["streaming", "completed"]);
  assert.equal(started.updates[0]?.output?.text, "x".repeat(100));
  assert.equal(started.updates[1]?.output?.text, "x".repeat(100));
  assert.deepEqual(started.updates[1]?.output?.reasoning, { text: "final reasoning" });
});

test("runModelStep: 达到 160 chars 时在 finish 前触发 streaming flush", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "a".repeat(160) });
  const streaming = started.updates.filter((item) => item.status === "streaming");
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0]?.output?.text, "a".repeat(160));

  await stream.finish({ usage: { inputTokens: 1, outputTokens: 2 } });
  await started.promise;
});

test("runModelStep: 100 chars 且 300ms 时在 finish 前不触发 streaming flush", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "hello".repeat(20) });
  now = 300;
  await stream.push({ type: "reasoning-delta", text: "r" });
  assert.equal(started.updates.filter((item) => item.status === "streaming").length, 0);

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
  const streaming = started.updates.filter((item) => item.status === "streaming");
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0]?.output?.text, "hello".repeat(20));
  assert.deepEqual(streaming[0]?.output?.reasoning, { text: "r" });

  await stream.finish({ reasoningText: "r", usage: { inputTokens: 1, outputTokens: 2 } });
  await started.promise;
});

test("runModelStep: tool-call step 前未达阈值文本会在 completed 中保存", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "preface" });
  assert.equal(started.updates.filter((item) => item.status === "streaming").length, 0);
  assert.equal(started.updates.filter((item) => item.status === "completed").length, 0);

  await stream.push({ type: "tool-call", toolName: "read", toolCallId: "call_read_1", input: { filePath: "README.md" } });
  assert.equal(started.updates.filter((item) => item.status === "completed").length, 0);

  await stream.finish({ usage: { inputTokens: 1, outputTokens: 2 } });
  const result = await started.promise;

  assert.equal(result.toolCallCount, 1);
  const completed = started.updates.filter((item) => item.status === "completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]?.output?.text, "preface");
  assert.equal(started.createdItems.some((item) => item.kind === "tool" && (item.output as Record<string, unknown>)?.toolCallId === "call_read_1"), true);
});

test("runModelStep: 无文本、无 tool call 的正常结束响应失败", async () => {
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream });

  await stream.finish();
  await assert.rejects(started.promise, /model stream completed without visible text or tool calls/);

  assert.equal(started.updates.filter((item) => item.status === "completed").length, 0);
  assert.equal(started.updates.filter((item) => item.status === "failed").length, 1);
});

test("runModelStep: 纯空白文本和 reasoning-only 响应按空响应处理", async () => {
  for (const chunks of [
    [{ type: "text-delta", text: "  \n\t" }],
    [{ type: "reasoning-delta", text: "internal reasoning only" }]
  ] as const) {
    const stream = createControlledStream();
    const started = await startRunModelStep({ stream });

    for (const chunk of chunks) {
      await stream.push(chunk);
    }
    await stream.finish();
    await assert.rejects(started.promise, /model stream completed without visible text or tool calls/);
  }
});

test("runModelStep: 空响应重试后复用同一 step，并清理上一轮 usage", async () => {
  const emptyStream = createControlledStream();
  const successfulStream = createControlledStream();
  const started = await startRunModelStep({ streams: [emptyStream, successfulStream], maxRetries: 1 });

  await emptyStream.push({ type: "finish", usage: { inputTokens: 90, outputTokens: 10 } });
  await emptyStream.finish();
  await successfulStream.push({ type: "text-delta", text: "ok" });
  await successfulStream.finish({ usage: { inputTokens: 3, outputTokens: 4 } });
  const result = await started.promise;

  assert.equal(result.hasVisibleText, true);
  assert.equal(started.createdItems.filter((item) => item.kind === "assistant").length, 1);
  assert.equal(started.runStateUpdates.at(-1)?.lastResponseTotalTokens, 7);
});

test("runModelStep: 连续空响应的 retryAttempt 连续递增且不重置", async () => {
  const streams = [createControlledStream(), createControlledStream(), createControlledStream()];
  const started = await startRunModelStep({ streams, maxRetries: 2 });

  for (const stream of streams) {
    void stream.finish();
  }

  await assert.rejects(started.promise, /failed after 2 retries: model stream completed without visible text or tool calls/);

  const retryNotices = started.runStateUpdates
    .map((update) => String(update.runNoticeText ?? ""))
    .filter((notice) => notice.includes("Request failed, retrying"));
  assert.equal(retryNotices.length, 2);
  assert.match(retryNotices[0] ?? "", /\(1\/2\)/);
  assert.match(retryNotices[1] ?? "", /\(2\/2\)/);
});

test("runModelStep: 空响应耗尽共享重试上限后失败且不创建新 step 或 item", async () => {
  const streams = [createControlledStream(), createControlledStream(), createControlledStream()];
  const started = await startRunModelStep({ streams, maxRetries: 2 });

  for (const stream of streams) {
    void stream.finish();
  }

  await assert.rejects(started.promise, /failed after 2 retries/);

  assert.equal(started.createdItems.filter((item) => item.kind === "assistant").length, 1);
  assert.equal(started.createdItems.filter((item) => item.kind === "tool").length, 0);
  assert.equal(started.updates.filter((item) => item.status === "completed").length, 0);
  assert.equal(started.updates.filter((item) => item.status === "failed").length, 1);
  assert.equal(new Set(started.updates.map((item) => item.itemId)).size, 1);
});

test("runModelStep: reasoning-only 响应在真实模型步骤内重试后成功", async () => {
  const reasoningStream = createControlledStream();
  const successfulStream = createControlledStream();
  const started = await startRunModelStep({ streams: [reasoningStream, successfulStream], maxRetries: 1 });

  void reasoningStream.push({ type: "reasoning-delta", text: "internal reasoning only" });
  void reasoningStream.finish();
  void successfulStream.push({ type: "text-delta", text: "visible answer" });
  void successfulStream.finish();

  const result = await started.promise;

  assert.equal(result.hasVisibleText, true);
  assert.equal(result.toolCallCount, 0);
  assert.equal(started.createdItems.filter((item) => item.kind === "assistant").length, 1);
  assert.deepEqual(started.updates.filter((item) => item.status === "completed")[0]?.output?.text, "visible answer");
});

test("runModelStep: 失败路径会保存未达阈值文本", async () => {
  let now = 0;
  const stream = createControlledStream();
  const started = await startRunModelStep({ stream, nowMs: () => now });

  await stream.push({ type: "text-delta", text: "partial output" });
  assert.equal(started.updates.filter((item) => item.status === "streaming").length, 0);

  const errorAck = stream.push({ type: "error", error: new Error("boom") }).catch((err) => err);
  let thrown: unknown = null;
  try {
    await started.promise;
  } catch (err) {
    thrown = err;
  }
  await errorAck;
  assert.match(thrown instanceof Error ? thrown.message : String(thrown), /boom/);
  const failed = started.updates.filter((item) => item.status === "failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.output?.text, "partial output");
});
