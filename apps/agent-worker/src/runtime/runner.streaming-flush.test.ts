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
  stream: ReturnType<typeof createControlledStream>;
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
      return { id: createdItems.length };
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
      streamText: ((() => options?.stream.stream) as unknown) as typeof streamText,
      nowMs: options?.nowMs
    }
  );
  (runner as any).toolRegistry.listTools = async () => options?.listTools ?? [
    { name: "read", description: "fixture read", inputSchema: { type: "object", properties: {} }, source: "builtin" }
  ];
  return { runner, updates, createdItems, runStateUpdates };
}

function startRunModelStep(params: {
  stream: ReturnType<typeof createControlledStream>;
  nowMs?: () => number;
}) {
  const harness = createRunnerHarness({ stream: params.stream, nowMs: params.nowMs });
  const promise = (harness.runner as any).runModelStep({
    profile: baseProfile(),
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
