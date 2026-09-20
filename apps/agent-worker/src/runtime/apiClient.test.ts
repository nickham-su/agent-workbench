import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, test } from "node:test";
import { Type } from "@sinclair/typebox";
import {
  AgentApiEndpoints,
  type AgentApiCommitCompactionWithTerminalIntentRequest,
  type AgentApiCommitCompactionResponse,
  type AgentApiCompactionSourceRequest,
  type AgentApiCompactionSourceResponse,
  type AgentApiCreateStreamingAssistantRequest,
  type AgentApiResumeStreamingAssistantRequest,
  type AgentApiReplaceStreamingAssistantRequest,
  type AgentApiUpdateRunNoticeRequest,
  type AgentApiUpdateToolExecutionRequest,
  type AgentApiSubtaskPreforkPlanRequest,
  type AgentApiSubtaskStartRequest,
  type AgentApiSubtaskResultRequest,
  type AgentApiSubtaskStatusRequest,
} from "@agent-workbench/shared/internal-contracts/agent-api";
import {
  AgentApiClient,
  ApiConflictError,
  InternalRpcHttpError,
  InternalRpcInvalidResponseError,
  InternalRpcTimeoutError,
} from "./apiClient.js";

type TestServerRequest = {
  method?: string;
  url?: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  attempt: number;
};

type TestServerResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  end?: boolean;
  destroySocket?: boolean;
};

type TestServerHandler = (
  request: TestServerRequest,
) => TestServerResponse | Promise<TestServerResponse>;

type TestServerFixture = {
  origin: string;
  attempts: readonly TestServerRequest[];
};

type TestRpcTiming = {
  internalRpcTimeoutMs: number;
  retryDelayMs: number;
};

type WarningRecorder = {
  warnings: string[];
  logger: Pick<Console, "warn">;
};

type ManagedServer = {
  server: Server;
  sockets: Set<Socket>;
};

const servers: ManagedServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(({ server, sockets }) => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }),
  );
});

function createTestRpcTiming(
  overrides: Partial<TestRpcTiming> = {},
): TestRpcTiming {
  return {
    internalRpcTimeoutMs: overrides.internalRpcTimeoutMs ?? 20,
    retryDelayMs: overrides.retryDelayMs ?? 1,
  };
}

function createWarningRecorder(): WarningRecorder {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      warn(message: unknown) {
        warnings.push(String(message));
      },
    },
  };
}

async function startTestServer(
  handler: TestServerHandler,
): Promise<TestServerFixture> {
  const attempts: TestServerRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    let text = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      void (async () => {
        const request = {
          method: req.method,
          url: req.url,
          body: text ? JSON.parse(text) : null,
        } as TestServerRequest;
        Object.defineProperties(request, {
          headers: { value: req.headers, enumerable: false },
          attempt: { value: attempts.length + 1, enumerable: false },
        });
        attempts.push({
          ...request,
          headers: req.headers,
          attempt: request.attempt,
        });
        const result = await handler(request);
        if (result.destroySocket) {
          req.socket.destroy();
          return;
        }
        res.statusCode = result.status;
        res.setHeader("content-type", "application/json");
        for (const [name, value] of Object.entries(result.headers ?? {})) {
          res.setHeader(name, value);
        }
        if (result.end === false) {
          res.flushHeaders();
          if (typeof result.body === "string") res.write(result.body);
          else if (result.body !== undefined)
            res.write(JSON.stringify(result.body));
          return;
        }
        res.end(
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body),
        );
      })().catch((error) => {
        if (res.destroyed) return;
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  servers.push({ server, sockets });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not bind");
  return { origin: `http://127.0.0.1:${address.port}`, attempts };
}

async function startServer(handler: TestServerHandler) {
  return (await startTestServer(handler)).origin;
}

function abortAfter(controller: AbortController, ms: number) {
  return setTimeout(() => controller.abort(), ms);
}

test("test server fixture supports attempts, warning logs, and safely abortable response hangs", async () => {
  const timing = createTestRpcTiming({ internalRpcTimeoutMs: 100 });
  const beforeHeaders = await startTestServer(
    () => new Promise<TestServerResponse>(() => {}),
  );
  const beforeHeadersController = new AbortController();
  const beforeHeadersTimer = abortAfter(
    beforeHeadersController,
    timing.internalRpcTimeoutMs,
  );
  await assert.rejects(
    () =>
      fetch(`${beforeHeaders.origin}/before-headers`, {
        method: "POST",
        body: "{}",
        signal: beforeHeadersController.signal,
      }),
    { name: "AbortError" },
  );
  clearTimeout(beforeHeadersTimer);
  assert.equal(beforeHeaders.attempts.length, 1);

  const afterHeaders = await startTestServer(() => ({
    status: 200,
    end: false,
  }));
  const afterHeadersController = new AbortController();
  const afterHeadersTimer = abortAfter(
    afterHeadersController,
    timing.internalRpcTimeoutMs,
  );
  const response = await fetch(`${afterHeaders.origin}/after-headers`, {
    signal: afterHeadersController.signal,
  });
  await assert.rejects(() => response.text(), { name: "AbortError" });
  clearTimeout(afterHeadersTimer);
  assert.equal(afterHeaders.attempts.length, 1);

  const recorder = createWarningRecorder();
  recorder.logger.warn("fixture warning");
  assert.deepEqual(recorder.warnings, ["fixture warning"]);
  assert.equal(createTestRpcTiming({ retryDelayMs: 2 }).retryDelayMs, 2);
});

const runStateInput = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  runNoticeText: "运行中",
  updatedAt: 100,
} satisfies AgentApiUpdateRunNoticeRequest;

const terminalControlInput = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  status: "completed" as const,
  code: "run_completed" as const,
  detail: null,
  updatedAt: 100,
};

const assistantMessage = {
  id: "MESSAGE",
  workspaceId: "WORKSPACE",
  previousMessageId: null,
  replacesMessageId: null,
  depth: 0,
  type: "assistant" as const,
  status: "streaming" as const,
  originSessionId: "SESSION",
  originRunId: "RUN",
  updatedRevision: 1,
  createdAt: 100,
  updatedAt: 100,
  parts: [],
};

const createAssistantInput: AgentApiCreateStreamingAssistantRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  messageId: "MESSAGE",
  createdAt: 100,
};

const resumeAssistantInput: AgentApiResumeStreamingAssistantRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  messageId: "MESSAGE",
};

const replaceAssistantInput: AgentApiReplaceStreamingAssistantRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  oldMessageId: "MESSAGE",
  newMessageId: "REPLACEMENT",
  runNoticeText: "retrying",
  retryCount: 1,
  nextRetryAt: 2_000,
  createdAt: 101,
};

const toolExecutionInput: AgentApiUpdateToolExecutionRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  toolExecutionId: "EXECUTION",
  status: "completed",
  resultPreview: "完成",
  completedAt: 200,
  updatedAt: 200,
};

const compactInput: AgentApiCommitCompactionWithTerminalIntentRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
  messageId: "COMPACTION_MESSAGE",
  textPartId: "COMPACTION_TEXT",
  expectedHeadMessageId: "MESSAGE",
  expectedRevision: 1,
  summaryText: "SUMMARY",
  retainedFromMessageId: null,
  createdAt: 300,
};

const compactResponse: AgentApiCommitCompactionResponse = {
  result: "updated",
  summaryMessageId: "COMPACTION_MESSAGE",
};

const compactionSourceInput: AgentApiCompactionSourceRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "SESSION",
  runId: "RUN",
};

const compactionSourceResponse: AgentApiCompactionSourceResponse = {
  ...compactionSourceInput,
  runKind: "manual_compaction",
  triggerMessageId: null,
  agentId: "AGENT",
  providerId: "PROVIDER",
  modelId: "MODEL",
  subtaskDepth: null,
  headMessageId: "MESSAGE",
  contextRootMessageId: "COMPACTION_MESSAGE",
  sessionRevision: 2,
  uiLocale: null,
  oneShotSystem: "",
  pendingBoundary: null,
  blocks: [],
};

const subtaskPreforkInput: AgentApiSubtaskPreforkPlanRequest = {
  workspaceId: "WORKSPACE",
  parentSessionId: "PARENT_SESSION",
  parentRunId: "PARENT_RUN",
  parentToolExecutionId: "PARENT_EXECUTION",
  agentId: "AGENT",
};
const subtaskStartInput: AgentApiSubtaskStartRequest = {
  workspaceId: "WORKSPACE",
  parentSessionId: "PARENT_SESSION",
  parentRunId: "PARENT_RUN",
  parentToolExecutionId: "PARENT_EXECUTION",
  description: "child task",
  prompt: "do the child task",
  agentId: "AGENT",
  session: { mode: "fork" },
};
const subtaskResultInput: AgentApiSubtaskResultRequest = {
  workspaceId: "WORKSPACE",
  sessionId: "CHILD_SESSION",
  runId: "CHILD_RUN",
};
const subtaskStatusInput: AgentApiSubtaskStatusRequest = subtaskResultInput;

function createShortTimeoutClient(
  origin: string,
  options: {
    logger?: Pick<Console, "warn">;
    sleepFn?: (ms: number) => Promise<void>;
    timing?: Partial<TestRpcTiming>;
  } = {},
) {
  const timing = createTestRpcTiming(options.timing);
  return new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: timing.internalRpcTimeoutMs,
    logger: options.logger ?? { warn() {} },
    sleepFn: options.sleepFn ?? (async () => {}),
  });
}

function assertSafeError(
  error: unknown,
  expected: { code: string; status?: number },
) {
  assert(error instanceof Error);
  assert.equal((error as Error & { code?: unknown }).code, expected.code);
  if (expected.status != null) {
    assert.equal(
      (error as Error & { status?: unknown }).status,
      expected.status,
    );
  }
  const serialized = JSON.stringify(error);
  const text = `${error.message}\n${serialized}\n${JSON.stringify(Object.entries(error))}`;
  for (const secret of [
    "RESPONSE_SECRET",
    "WORKSPACE_SECRET",
    "SESSION_SECRET",
    "RUN_SECRET",
    "TOKEN",
  ]) {
    assert.equal(
      text.includes(secret),
      false,
      `safe error must not expose ${secret}`,
    );
  }
}

test("single attempts time out before headers and while a 200 body is pending without becoming cancellation errors", async () => {
  const beforeHeaders = await startTestServer(
    () => new Promise<TestServerResponse>(() => {}),
  );
  const beforeHeadersClient = createShortTimeoutClient(beforeHeaders.origin);
  await assert.rejects(
    () =>
      beforeHeadersClient.getPromptContext({
        workspaceId: "WORKSPACE_SECRET",
        sessionId: "SESSION_SECRET",
        runId: "RUN_SECRET",
      }),
    (error: unknown) => {
      assertSafeError(error, { code: "AGENT_INTERNAL_RPC_TIMEOUT" });
      assert(error instanceof InternalRpcTimeoutError);
      assert.equal(error.name.includes("Abort"), false);
      assert.equal(error.message.toLowerCase().includes("abort"), false);
      return true;
    },
  );
  assert.equal(beforeHeaders.attempts.length, 2);

  const pendingBody = await startTestServer(() => ({
    status: 200,
    body: { RESPONSE_SECRET: true },
    end: false,
  }));
  const pendingBodyClient = createShortTimeoutClient(pendingBody.origin);
  await assert.rejects(
    () =>
      pendingBodyClient.getPromptContext({
        workspaceId: "WORKSPACE_SECRET",
        sessionId: "SESSION_SECRET",
        runId: "RUN_SECRET",
      }),
    (error: unknown) => {
      assertSafeError(error, { code: "AGENT_INTERNAL_RPC_TIMEOUT" });
      return error instanceof InternalRpcTimeoutError;
    },
  );
  assert.equal(pendingBody.attempts.length, 2);
});

test("known non-2xx status remains authoritative when its body is pending", async () => {
  for (const status of [400, 500, 503]) {
    const fixture = await startTestServer(() => ({
      status,
      body: {
        message: "SERVER_MESSAGE",
        code: "SERVER_CODE",
        secret: "RESPONSE_SECRET",
      },
      end: false,
    }));
    const client = createShortTimeoutClient(fixture.origin, {
      timing: { internalRpcTimeoutMs: 100 },
    });
    await assert.rejects(
      () =>
        client.getPromptContext({
          workspaceId: "WORKSPACE_SECRET",
          sessionId: "SESSION_SECRET",
          runId: "RUN_SECRET",
        }),
      (error: unknown) => {
        assertSafeError(error, {
          code: "AGENT_INTERNAL_RPC_HTTP_ERROR",
          status,
        });
        return error instanceof InternalRpcHttpError;
      },
    );
    assert.equal(
      fixture.attempts.length,
      status === 503 ? 2 : 1,
      `status ${status} retry count`,
    );
  }
});

test("non-2xx responses retain only a bounded business code and never expose response messages", async () => {
  const fixture = await startTestServer(() => ({
    status: 404,
    body: {
      code: "AGENT_SUBTASK_SESSION_NOT_FOUND",
      message: "subtask session not found",
      secret: "RESPONSE_SECRET",
      prompt: "PROMPT_SECRET",
      nested: { token: "TOKEN_SECRET" },
    },
  }));
  const client = createShortTimeoutClient(fixture.origin);
  await assert.rejects(
    () =>
      client.startSubtaskRun({
        ...subtaskStartInput,
        session: { mode: "existing", sessionId: "MISSING_SESSION" },
      }),
    (error: unknown) => {
      assert(error instanceof InternalRpcHttpError);
      assert.equal(error.method, "POST");
      assert.equal(error.endpoint, AgentApiEndpoints.startSubtask.path);
      assert.equal(error.status, 404);
      assert.equal(error.apiCode, "AGENT_SUBTASK_SESSION_NOT_FOUND");
      assert.equal(error.safeMessage, undefined);
      assert.match(error.message, /code=AGENT_SUBTASK_SESSION_NOT_FOUND/);
      assert.doesNotMatch(error.message, /subtask session not found/);
      const text = `${error.message}\n${JSON.stringify(error)}\n${JSON.stringify(Object.entries(error))}`;
      for (const secret of [
        "RESPONSE_SECRET",
        "PROMPT_SECRET",
        "TOKEN_SECRET",
        "MISSING_SESSION",
        "TOKEN",
      ]) {
        assert.equal(
          text.includes(secret),
          false,
          `safe error must not expose ${secret}`,
        );
      }
      return true;
    },
  );
  assert.equal(fixture.attempts.length, 1);
});

test("non-2xx response message containing replay, raw, and provider metadata never enters errors or warnings", async () => {
  const sentinel = "opaque-encrypted-replay-SENTINEL-api-client-43d1";
  const recorder = createWarningRecorder();
  const fixture = await startTestServer(() => ({
    status: 400,
    body: {
      code: "REPLAY_REJECTED",
      message: JSON.stringify({
        encrypted_content: sentinel,
        rawValue: { response: { output: [sentinel] } },
        providerMetadata: { openai: { reasoningEncryptedContent: sentinel } },
      }),
    },
  }));
  const client = createShortTimeoutClient(fixture.origin, { logger: recorder.logger });
  await assert.rejects(
    () => client.getPromptContext({ workspaceId: "WORKSPACE", sessionId: "SESSION", runId: "RUN" }),
    (error: unknown) => {
      assert(error instanceof InternalRpcHttpError);
      assert.equal(error.apiCode, "REPLAY_REJECTED");
      assert.equal(error.safeMessage, undefined);
      const diagnostics = `${error.message}\n${JSON.stringify(error)}\n${JSON.stringify(Object.entries(error))}\n${recorder.warnings.join("\n")}`;
      assert.doesNotMatch(diagnostics, new RegExp(sentinel));
      assert.doesNotMatch(diagnostics, /encrypted_content|reasoningEncryptedContent|providerMetadata|rawValue/);
      assert.match(diagnostics, /REPLAY_REJECTED/);
      return true;
    },
  );
});

test("non-2xx empty, malformed, non-object, and oversized bodies safely fall back to status diagnostics", async () => {
  const cases: Array<{
    name: string;
    body?: unknown;
    headers?: Record<string, string>;
  }> = [
    { name: "empty" },
    { name: "non-json", body: "not json RESPONSE_SECRET" },
    {
      name: "array",
      body: [{ code: "SERVER_CODE", message: "SERVER_MESSAGE" }],
    },
    {
      name: "oversized",
      body: {
        code: "SERVER_CODE",
        message: "x".repeat(5_000),
        secret: "RESPONSE_SECRET",
      },
    },
    {
      name: "oversized content-length",
      body: { code: "SERVER_CODE", message: "SERVER_MESSAGE" },
      headers: { "content-length": "5000" },
    },
  ];
  for (const entry of cases) {
    const fixture = await startTestServer(() => ({
      status: 400,
      body: entry.body,
      headers: entry.headers,
    }));
    const client = createShortTimeoutClient(fixture.origin);
    await assert.rejects(
      () =>
        client.getPromptContext({
          workspaceId: "WORKSPACE_SECRET",
          sessionId: "SESSION_SECRET",
          runId: "RUN_SECRET",
        }),
      (error: unknown) => {
        assert(error instanceof InternalRpcHttpError);
        assert.equal(error.status, 400, entry.name);
        assert.equal(error.apiCode, undefined, entry.name);
        assert.equal(error.safeMessage, undefined, entry.name);
        const text = `${error.message}\n${JSON.stringify(error)}\n${JSON.stringify(Object.entries(error))}`;
        for (const secret of [
          "RESPONSE_SECRET",
          "SERVER_CODE",
          "SERVER_MESSAGE",
          "WORKSPACE_SECRET",
          "SESSION_SECRET",
          "RUN_SECRET",
          "TOKEN",
        ]) {
          assert.equal(
            text.includes(secret),
            false,
            `${entry.name} must not expose ${secret}`,
          );
        }
        return true;
      },
    );
  }
});

test("invalid business codes and arbitrary response messages are not exposed", async () => {
  const fixture = await startTestServer(() => ({
    status: 400,
    body: {
      code: "INVALID CODE WITH SPACES",
      message: `  ${"safe message ".repeat(80)}\n`,
      secret: "RESPONSE_SECRET",
    },
  }));
  const client = createShortTimeoutClient(fixture.origin);
  await assert.rejects(
    () =>
      client.getPromptContext({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
        runId: "RUN",
      }),
    (error: unknown) => {
      assert(error instanceof InternalRpcHttpError);
      assert.equal(error.apiCode, undefined);
      assert.equal(error.safeMessage, undefined);
      assert.equal(error.message.includes("safe message"), false);
      assert.equal(error.message.includes("RESPONSE_SECRET"), false);
      return true;
    },
  );
});

test("structured error messages with control, ANSI, and bidi characters are discarded", async () => {
  const fixture = await startTestServer(() => ({
    status: 400,
    body: {
      code: "SAFE_CODE",
      message:
        "正常\u001b[31m文本\u001b[0m\u0007\u009b[2K\u061c\u200e\u200f\u202e方向\u2066隔离\u2069结束",
    },
  }));
  const client = createShortTimeoutClient(fixture.origin);
  await assert.rejects(
    () =>
      client.getPromptContext({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
        runId: "RUN",
      }),
    (error: unknown) => {
      assert(error instanceof InternalRpcHttpError);
      assert.equal(error.apiCode, "SAFE_CODE");
      assert.equal(error.safeMessage, undefined);
      assert.doesNotMatch(error.message, /正常|方向|隔离|结束/);
      return true;
    },
  );
});

test("all public client methods are explicitly classified", () => {
  assert.deepEqual(AgentApiClient.publicMethodPolicies, {
    createStreamingAssistant: "idempotentControlWrite",
    flushAssistantParts: "controlWrite",
    resumeStreamingAssistant: "controlWrite",
    replaceStreamingAssistant: "controlWrite",
    discardStreamingAssistant: "controlWrite",
    completeAssistant: "controlWrite",
    completeTerminalAssistant: "idempotentControlWrite",
    updateToolExecution: "controlWrite",
    updateRunNotice: "controlWrite",
    markRunWorkInProgress: "terminalControl",
    persistRunTerminalIntent: "terminalControl",
    convergeRunTerminal: "terminalControl",
    getExecutionProfile: "controlRead",
    getPromptContext: "controlRead",
    getMessagesContext: "controlRead",
    getCompactionSource: "controlRead",
    archiveRead: "controlRead",
    archiveSearch: "controlRead",
    commitCompactionWithTerminalIntent: "idempotentControlWrite",
    confirmCompactionCommit: "controlRead",
    getSubtaskPreforkPlan: "controlRead",
    startSubtaskRun: "subtaskStart",
    getSubtaskResult: "controlRead",
    getSubtaskStatus: "controlRead",
    getAgentMcpSettings: "controlRead",
    getPluginRuntimeSnapshots: "controlRead",
    listPluginTools: "controlRead",
    executePluginTool: "excluded",
    prepareGitEnvForBash: "excluded",
    cleanupGitEnvLease: "excluded",
  });
});

test("controlRead retry boundaries and normal success diagnostics are bounded", async () => {
  const noRetryCases = [
    {
      name: "http 400",
      response: { status: 400, body: { message: "SERVER_MESSAGE" } },
    },
    {
      name: "http 500",
      response: { status: 500, body: { message: "SERVER_MESSAGE" } },
    },
    { name: "malformed json", response: { status: 200, body: "not json" } },
    {
      name: "schema mismatch",
      response: { status: 200, body: { unexpected: true } },
    },
  ];
  for (const entry of noRetryCases) {
    const fixture = await startTestServer(() => entry.response);
    const recorder = createWarningRecorder();
    const client = createShortTimeoutClient(fixture.origin, {
      logger: recorder.logger,
      timing: { internalRpcTimeoutMs: 100 },
    });
    await assert.rejects(() =>
      client.getPromptContext({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
        runId: "RUN",
      }),
    );
    assert.equal(fixture.attempts.length, 1, `${entry.name} must not retry`);
    assert.equal(
      recorder.warnings.some((warning) => warning.includes("retry")),
      false,
    );
  }

  const success = await startTestServer(() => ({
    status: 200,
    body: validPromptContextResponse,
  }));
  const recorder = createWarningRecorder();
  const client = createShortTimeoutClient(success.origin, {
    logger: recorder.logger,
  });
  await client.getPromptContext({
    workspaceId: "WORKSPACE",
    sessionId: "SESSION",
    runId: "RUN",
  });
  assert.equal(success.attempts.length, 1);
  assert.deepEqual(recorder.warnings, []);
});

test("controlWrite never retries timeout or 503", async () => {
  const timeoutFixture = await startTestServer(
    () => new Promise<TestServerResponse>(() => {}),
  );
  const timeoutClient = createShortTimeoutClient(timeoutFixture.origin);
  await assert.rejects(
    () => timeoutClient.updateRunNotice(runStateInput),
    InternalRpcTimeoutError,
  );
  assert.equal(timeoutFixture.attempts.length, 1);

  const unavailableFixture = await startTestServer(() => ({
    status: 503,
    body: { message: "SERVER_MESSAGE" },
  }));
  const unavailableClient = createShortTimeoutClient(unavailableFixture.origin);
  await assert.rejects(
    () => unavailableClient.commitCompactionWithTerminalIntent(compactInput),
    InternalRpcHttpError,
  );
  assert.equal(unavailableFixture.attempts.length, 1);
});

test("subtaskStart retries once while terminalControl leaves retries to Runner", async () => {
  const startFixture = await startTestServer((request) =>
    request.attempt === 1
      ? { status: 503, body: { message: "SERVER_MESSAGE" } }
      : {
          status: 200,
          body: {
            sessionId: "CHILD_SESSION",
            runId: "CHILD_RUN",
            workspacePath: "/workspace",
            agentName: "child",
            reused: true,
          },
        },
  );
  const startDelays: number[] = [];
  const startClient = createShortTimeoutClient(startFixture.origin, {
    sleepFn: async (ms) => {
      startDelays.push(ms);
    },
  });
  await startClient.startSubtaskRun(subtaskStartInput);
  assert.equal(startFixture.attempts.length, 2);
  assert.deepEqual(startDelays, [300]);

  const completeFixture = await startTestServer((request) =>
    request.attempt === 1
      ? { status: 503, body: { message: "SERVER_MESSAGE" } }
      : { status: 200, body: { result: "updated" } },
  );
  const completeDelays: number[] = [];
  const recorder = createWarningRecorder();
  const completeClient = createShortTimeoutClient(completeFixture.origin, {
    logger: recorder.logger,
    sleepFn: async (ms) => {
      completeDelays.push(ms);
    },
    timing: { internalRpcTimeoutMs: 100 },
  });
  await assert.rejects(
    () => completeClient.persistRunTerminalIntent(terminalControlInput, { timeoutMs: 50 }),
    InternalRpcHttpError,
  );
  assert.equal(completeFixture.attempts.length, 1);
  assert.deepEqual(completeDelays, []);
  assert.equal(
    recorder.warnings.some(
      (warning) =>
        warning.includes("policy=terminalControl") &&
        warning.includes("timeoutMs=50"),
    ),
    true,
  );
});

test("terminal-control 单次 timeout 不得超过内部 RPC 配置", async () => {
  const fixture = await startTestServer(() => ({ status: 503, body: { message: "SERVER_MESSAGE" } }));
  const recorder = createWarningRecorder();
  const client = createShortTimeoutClient(fixture.origin, {
    logger: recorder.logger,
    timing: { internalRpcTimeoutMs: 11 },
  });
  await assert.rejects(
    () => client.persistRunTerminalIntent(terminalControlInput, { timeoutMs: 99 }),
    InternalRpcHttpError,
  );
  assert.equal(fixture.attempts.length, 1);
  assert.equal(
    recorder.warnings.some((warning) =>
      warning.includes("policy=terminalControl") && warning.includes("timeoutMs=11"),
    ),
    true,
  );
});

test("network failures retry once and remain normalized without exposing their raw cause", async () => {
  const fixture = await startTestServer(() => ({
    status: 200,
    destroySocket: true,
  }));
  const recorder = createWarningRecorder();
  const delays: number[] = [];
  const client = createShortTimeoutClient(fixture.origin, {
    logger: recorder.logger,
    sleepFn: async (ms) => {
      delays.push(ms);
    },
  });
  await assert.rejects(
    () =>
      client.getPromptContext({
        workspaceId: "WORKSPACE_SECRET",
        sessionId: "SESSION_SECRET",
        runId: "RUN_SECRET",
      }),
    (error: unknown) => {
      assertSafeError(error, { code: "AGENT_INTERNAL_RPC_NETWORK_ERROR" });
      return error instanceof Error && error.name === "InternalRpcNetworkError";
    },
  );
  assert.equal(fixture.attempts.length, 2);
  assert.deepEqual(delays, [300]);
  assert.equal(
    recorder.warnings.some((warning) => warning.includes("reason=network")),
    true,
  );
});

test("timeout diagnostics remain safe for retry and final failure", async () => {
  const fixture = await startTestServer(
    () => new Promise<TestServerResponse>(() => {}),
  );
  const recorder = createWarningRecorder();
  const client = createShortTimeoutClient(fixture.origin, {
    logger: recorder.logger,
    sleepFn: async () => {},
  });
  await assert.rejects(
    () =>
      client.getPromptContext({
        workspaceId: "WORKSPACE_SECRET",
        sessionId: "SESSION_SECRET",
        runId: "RUN_SECRET",
      }),
    InternalRpcTimeoutError,
  );
  assert.equal(fixture.attempts.length, 2);
  assert.equal(
    recorder.warnings.some((warning) =>
      warning.includes("[agent-api] timeout"),
    ),
    true,
  );
  assert.equal(
    recorder.warnings.some((warning) => warning.includes("[agent-api] retry")),
    true,
  );
  assert.equal(
    recorder.warnings.some((warning) => warning.includes("[agent-api] failed")),
    true,
  );
  for (const warning of recorder.warnings) {
    for (const secret of [
      "WORKSPACE_SECRET",
      "SESSION_SECRET",
      "RUN_SECRET",
      "TOKEN",
    ]) {
      assert.equal(
        warning.includes(secret),
        false,
        `diagnostic must not expose ${secret}`,
      );
    }
  }
});

test("controlRead retries only the five approved reasons and emits safe diagnostics", async () => {
  const retryableStatuses = [502, 503, 504];
  for (const status of retryableStatuses) {
    const fixture = await startTestServer((request) =>
      request.attempt === 1
        ? { status, body: { message: "SERVER_MESSAGE", code: "SERVER_CODE" } }
        : { status: 200, body: validPromptContextResponse },
    );
    const recorder = createWarningRecorder();
    const delays: number[] = [];
    const client = createShortTimeoutClient(fixture.origin, {
      logger: recorder.logger,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });
    await client.getPromptContext({
      workspaceId: "WORKSPACE",
      sessionId: "SESSION",
      runId: "RUN",
    });
    assert.equal(fixture.attempts.length, 2);
    assert.deepEqual(delays, [300]);
    assert.equal(
      recorder.warnings.some((warning) =>
        warning.includes(`reason=http_${status}`),
      ),
      true,
    );
    assert.equal(
      recorder.warnings.some((warning) => warning.includes("recovered")),
      true,
    );
    for (const warning of recorder.warnings) {
      assert.equal(
        /SERVER_MESSAGE|SERVER_CODE|TOKEN|WORKSPACE|SESSION|RUN/.test(warning),
        false,
      );
    }
  }
});

test("malformed and schema-invalid successful responses use safe invalid-response errors", async () => {
  const malformed = await startTestServer(() => ({
    status: 200,
    body: "RESPONSE_SECRET SERVER_MESSAGE SERVER_CODE",
  }));
  const malformedClient = createShortTimeoutClient(malformed.origin);
  await assert.rejects(
    () =>
      malformedClient.getPromptContext({
        workspaceId: "WORKSPACE_SECRET",
        sessionId: "SESSION_SECRET",
        runId: "RUN_SECRET",
      }),
    (error: unknown) => {
      assertSafeError(error, { code: "AGENT_INTERNAL_RPC_INVALID_RESPONSE" });
      return (
        error instanceof InternalRpcInvalidResponseError &&
        error.stage === "body-or-json"
      );
    },
  );

  const schemaInvalid = await startTestServer(() => ({
    status: 200,
    body: { RESPONSE_SECRET: "SERVER_MESSAGE" },
  }));
  const schemaInvalidClient = createShortTimeoutClient(schemaInvalid.origin);
  await assert.rejects(
    () =>
      schemaInvalidClient.getPromptContext({
        workspaceId: "WORKSPACE_SECRET",
        sessionId: "SESSION_SECRET",
        runId: "RUN_SECRET",
      }),
    (error: unknown) => {
      assertSafeError(error, { code: "AGENT_INTERNAL_RPC_INVALID_RESPONSE" });
      return (
        error instanceof InternalRpcInvalidResponseError &&
        error.stage === "schema"
      );
    },
  );
});

test("409 conflict remains ApiConflictError even if its response body is pending", async () => {
  const fixture = await startTestServer(() => ({
    status: 409,
    body: {
      message: "SERVER_MESSAGE",
      code: "SERVER_CODE",
      secret: "RESPONSE_SECRET",
    },
    end: false,
  }));
  const client = createShortTimeoutClient(fixture.origin);
  await assert.rejects(
    () =>
      client.commitCompactionWithTerminalIntent({
        ...compactInput,
        workspaceId: "WORKSPACE_SECRET",
        sessionId: "SESSION_SECRET",
        runId: "RUN_SECRET",
      }),
    (error: unknown) => {
      assert(error instanceof ApiConflictError);
      assert.equal(error.message, "context conflict");
      const text = `${error.message}\n${JSON.stringify(error)}\n${JSON.stringify(Object.entries(error))}`;
      for (const secret of [
        "RESPONSE_SECRET",
        "SERVER_MESSAGE",
        "SERVER_CODE",
        "WORKSPACE_SECRET",
        "SESSION_SECRET",
        "RUN_SECRET",
        "TOKEN",
      ]) {
        assert.equal(
          text.includes(secret),
          false,
          `conflict error must not expose ${secret}`,
        );
      }
      return true;
    },
  );
  assert.equal(fixture.attempts.length, 1);
});

test("run methods use shared endpoint method/path and validate literal success", async () => {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const origin = await startServer((request) => {
    requests.push(request);
    return {
      status: 200,
      body:
        request.url === AgentApiEndpoints.convergeRunTerminal.path
          ? { kind: "transitioned", finalStatus: "completed" }
          : request.url === AgentApiEndpoints.updateRunNotice.path
          ? { result: "updated" }
          : { result: "updated" },
    };
  });
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });

  await client.updateRunNotice(runStateInput);
  await client.markRunWorkInProgress({ workspaceId: "WORKSPACE", sessionId: "SESSION", runId: "RUN", updatedAt: 100 });
  await client.persistRunTerminalIntent(terminalControlInput);
  await client.convergeRunTerminal({ workspaceId: "WORKSPACE", sessionId: "SESSION", runId: "RUN", updatedAt: 100 });

  assert.deepEqual(
    requests.map((request) => ({ method: request.method, url: request.url })),
    [
      {
        method: AgentApiEndpoints.updateRunNotice.method,
        url: AgentApiEndpoints.updateRunNotice.path,
      },
      {
        method: AgentApiEndpoints.markRunWorkInProgress.method,
        url: AgentApiEndpoints.markRunWorkInProgress.path,
      },
      {
        method: AgentApiEndpoints.persistRunTerminalIntent.method,
        url: AgentApiEndpoints.persistRunTerminalIntent.path,
      },
      {
        method: AgentApiEndpoints.convergeRunTerminal.method,
        url: AgentApiEndpoints.convergeRunTerminal.path,
      },
    ],
  );
});

test("strict rejects a successful response schema mismatch", async () => {
  const origin = await startServer(() => ({
    status: 200,
    body: { ok: false },
  }));
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });

  await assert.rejects(
    () => client.updateRunNotice(runStateInput),
    (error: unknown) =>
      error instanceof InternalRpcInvalidResponseError &&
      error.stage === "schema",
  );
});

test("warn logs a bounded schema warning and continues", async () => {
  const warnings: string[] = [];
  const origin = await startServer(() => ({
    status: 200,
    body: { ok: false, token: "TOKEN", runId: "RUN" },
  }));
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) },
  });

  await client.persistRunTerminalIntent(terminalControlInput);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] || "", /endpoint=.*runs\/terminal-intent/);
  assert.match(warnings[0] || "", /method=POST/);
  assert.equal(warnings[0]?.includes("TOKEN"), false);
  assert.equal(warnings[0]?.includes("RUN"), false);
});

test("warn without an injected logger emits a warning", async () => {
  const origin = await startServer(() => ({
    status: 200,
    body: { ok: false },
  }));
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const client = new AgentApiClient({
      apiOrigin: origin,
      internalToken: "TOKEN",
      internalRpcTimeoutMs: 15_000,
        responseValidation: "warn",
    });
    await client.updateRunNotice(runStateInput);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0] || ""), /endpoint=.*run-notice/);
});

test("Message compaction uses shared endpoint/method/body and validates the success response", async () => {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const origin = await startServer((request) => {
    requests.push(request);
    return { status: 200, body: compactResponse };
  });
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });

  const result = await client.commitCompactionWithTerminalIntent(compactInput);

  assert.deepEqual(result, compactResponse);
  assert.deepEqual(requests, [
    {
      method: AgentApiEndpoints.commitCompactionWithTerminalIntent.method,
      url: AgentApiEndpoints.commitCompactionWithTerminalIntent.path,
      body: compactInput,
    },
  ]);
  assert.equal(result.summaryMessageId, "COMPACTION_MESSAGE");
});

test("Compaction source uses its fixed read endpoint and rejects non-schema responses", async () => {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const origin = await startServer((request) => {
    requests.push(request);
    return { status: 200, body: compactionSourceResponse };
  });
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });
  assert.deepEqual(await client.getCompactionSource(compactionSourceInput), compactionSourceResponse);
  assert.deepEqual(requests, [{
    method: AgentApiEndpoints.getCompactionSource.method,
    url: AgentApiEndpoints.getCompactionSource.path,
    body: compactionSourceInput,
  }]);

  const invalidOrigin = await startServer(() => ({
    status: 200,
    body: { ...compactionSourceResponse, uiLocale: "en-US" },
  }));
  const invalidClient = new AgentApiClient({
    apiOrigin: invalidOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });
  await assert.rejects(
    () => invalidClient.getCompactionSource(compactionSourceInput),
    (error: unknown) => error instanceof InternalRpcInvalidResponseError && error.stage === "schema",
  );
});

test("compact strict and warn preserve the success schema boundary", async () => {
  const invalidResponse = { compacted: true, summaryItemId: 18 };
  const strictOrigin = await startServer(() => ({
    status: 200,
    body: invalidResponse,
  }));
  const strictClient = new AgentApiClient({
    apiOrigin: strictOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });
  await assert.rejects(
    () => strictClient.commitCompactionWithTerminalIntent(compactInput),
    (error: unknown) =>
      error instanceof InternalRpcInvalidResponseError &&
      error.stage === "schema",
  );

  const warnings: string[] = [];
  const warnOrigin = await startServer(() => ({
    status: 200,
    body: invalidResponse,
  }));
  const warnClient = new AgentApiClient({
    apiOrigin: warnOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) },
  });
  const parsed = await warnClient.commitCompactionWithTerminalIntent(compactInput);
  assert.deepEqual(parsed, invalidResponse);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] || "", /endpoint=.*messages\/compaction/);
  assert.equal(warnings[0]?.includes("TOKEN"), false);
  assert.equal(warnings[0]?.includes("SUMMARY"), false);

  const malformedOrigin = await startServer(() => ({
    status: 200,
    body: "not-json",
  }));
  const malformedClient = new AgentApiClient({
    apiOrigin: malformedOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
  });
  await assert.rejects(
    () => malformedClient.commitCompactionWithTerminalIntent(compactInput),
    (error: unknown) =>
      error instanceof InternalRpcInvalidResponseError &&
      error.stage === "body-or-json",
  );

  const non2xxOrigin = await startServer(() => ({
    status: 500,
    body: { message: "SERVER_MESSAGE", code: "SERVER_CODE" },
  }));
  const non2xxClient = new AgentApiClient({
    apiOrigin: non2xxOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
  });
  await assert.rejects(
    () => non2xxClient.commitCompactionWithTerminalIntent(compactInput),
    (error: unknown) => {
      assertSafeError(error, {
        code: "AGENT_INTERNAL_RPC_HTTP_ERROR",
        status: 500,
      });
      return error instanceof InternalRpcHttpError;
    },
  );
});

test("compact maps both 409 response bodies to ApiConflictError without inspecting code", async () => {
  for (const body of [
    { message: "session head conflict" },
    { message: "session head conflict", code: "conflict_head:17" },
  ]) {
    const origin = await startServer(() => ({ status: 409, body }));
    const client = new AgentApiClient({
      apiOrigin: origin,
      internalToken: "TOKEN",
      internalRpcTimeoutMs: 15_000,
      });
    await assert.rejects(
      () => client.commitCompactionWithTerminalIntent(compactInput),
      ApiConflictError,
    );
  }
});

test("subtask methods use shared endpoints, forward typed bodies, and validate each success shape", async () => {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const origin = await startServer((request) => {
    requests.push(request);
    if (request.url === AgentApiEndpoints.getSubtaskPreforkPlan.path) {
      return {
        status: 200,
        body: {
          shouldPrefork: true,
          thresholdPct: 95,
          parentLastResponseTotalTokens: 123,
          childContextWindowTokens: 456,
          thresholdTokens: 433,
        },
      };
    }
    if (request.url === AgentApiEndpoints.startSubtask.path) {
      return {
        status: 200,
        body: {
          sessionId: "CHILD_SESSION",
          runId: "CHILD_RUN",
          workspacePath: "/workspace/child",
          agentName: "child-agent",
          reused: false,
        },
      };
    }
    if (request.url === AgentApiEndpoints.getSubtaskResult.path) {
      return { status: 200, body: { resultText: "partial result" } };
    }
    return { status: 200, body: { status: "completed" } };
  });
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });

  await client.getSubtaskPreforkPlan(subtaskPreforkInput);
  await client.startSubtaskRun(subtaskStartInput);
  await client.getSubtaskResult(subtaskResultInput);
  await client.getSubtaskStatus(subtaskStatusInput);
  assert.deepEqual(requests, [
    {
      method: AgentApiEndpoints.getSubtaskPreforkPlan.method,
      url: AgentApiEndpoints.getSubtaskPreforkPlan.path,
      body: subtaskPreforkInput,
    },
    {
      method: AgentApiEndpoints.startSubtask.method,
      url: AgentApiEndpoints.startSubtask.path,
      body: subtaskStartInput,
    },
    {
      method: AgentApiEndpoints.getSubtaskResult.method,
      url: AgentApiEndpoints.getSubtaskResult.path,
      body: subtaskResultInput,
    },
    {
      method: AgentApiEndpoints.getSubtaskStatus.method,
      url: AgentApiEndpoints.getSubtaskStatus.path,
      body: subtaskStatusInput,
    },
  ]);
});

test("subtask strict/warn validation applies to all success responses without exposing payloads", async () => {
  const invalidResponses = [
    { shouldPrefork: true },
    { sessionId: "CHILD_SESSION" },
    { resultText: 123 },
    { status: "queued" },
  ];
  const inputs = [
    subtaskPreforkInput,
    subtaskStartInput,
    subtaskResultInput,
    subtaskStatusInput,
  ];
  const methods = [
    "getSubtaskPreforkPlan",
    "startSubtaskRun",
    "getSubtaskResult",
    "getSubtaskStatus",
  ] as const;
  for (let i = 0; i < methods.length; i += 1) {
    const origin = await startServer(() => ({
      status: 200,
      body: invalidResponses[i],
    }));
    const client = new AgentApiClient({
      apiOrigin: origin,
      internalToken: "TOKEN",
      internalRpcTimeoutMs: 15_000,
      });
    await assert.rejects(
      () => client[methods[i]](inputs[i] as never),
      (error: unknown) =>
        error instanceof InternalRpcInvalidResponseError &&
        error.stage === "schema",
    );
  }

  const warnings: string[] = [];
  const origin = await startServer((request) => {
    if (request.url === AgentApiEndpoints.getSubtaskPreforkPlan.path)
      return { status: 200, body: { shouldPrefork: true, secret: "PROMPT" } };
    if (request.url === AgentApiEndpoints.startSubtask.path)
      return {
        status: 200,
        body: { sessionId: "CHILD_SESSION", secret: "PROMPT" },
      };
    if (request.url === AgentApiEndpoints.getSubtaskResult.path)
      return { status: 200, body: { resultText: 123, secret: "PROMPT" } };
    return { status: 200, body: { status: "queued", secret: "PROMPT" } };
  });
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) },
  });
  await client.getSubtaskPreforkPlan(subtaskPreforkInput);
  await client.startSubtaskRun(subtaskStartInput);
  await client.getSubtaskResult(subtaskResultInput);
  await client.getSubtaskStatus(subtaskStatusInput);
  assert.equal(warnings.length, 4);
  assert.equal(
    warnings.every(
      (warning) => !warning.includes("TOKEN") && !warning.includes("PROMPT"),
    ),
    true,
  );
});

test("subtask warn does not relax malformed JSON or non-2xx responses", async () => {
  const malformedOrigin = await startServer(() => ({
    status: 200,
    body: "not-json",
  }));
  const malformedClient = new AgentApiClient({
    apiOrigin: malformedOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
  });
  await assert.rejects(() =>
    malformedClient.getSubtaskStatus(subtaskStatusInput),
  );

  const errorOrigin = await startServer(() => ({
    status: 500,
    body: { message: "server error" },
  }));
  const errorClient = new AgentApiClient({
    apiOrigin: errorOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
  });
  await assert.rejects(
    () => errorClient.getSubtaskResult(subtaskResultInput),
    (error: unknown) =>
      error instanceof InternalRpcHttpError && error.status === 500,
  );
});

test("subtask 409 remains a safe typed HTTP failure for every endpoint", async () => {
  const methods = [
    ["getSubtaskPreforkPlan", subtaskPreforkInput],
    ["startSubtaskRun", subtaskStartInput],
    ["getSubtaskResult", subtaskResultInput],
    ["getSubtaskStatus", subtaskStatusInput],
  ] as const;
  for (const [method, input] of methods) {
    const origin = await startServer(() => ({
      status: 409,
      body: {
        message: "business conflict",
        code: "AGENT_SUBTASK_DEPTH_UNKNOWN",
      },
    }));
    const client = new AgentApiClient({
      apiOrigin: origin,
      internalToken: "TOKEN",
      internalRpcTimeoutMs: 15_000,
      });
    await assert.rejects(
      () => client[method](input as never),
      (error: unknown) =>
        error instanceof InternalRpcHttpError && error.status === 409,
    );
  }
});

test("warn does not relax JSON parse or non-2xx failures", async () => {
  const malformedOrigin = await startServer(() => ({
    status: 200,
    body: "not-json",
  }));
  const malformedClient = new AgentApiClient({
    apiOrigin: malformedOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
  });
  await assert.rejects(() => malformedClient.updateRunNotice(runStateInput));

  const errorOrigin = await startServer(() => ({
    status: 500,
    body: { message: "server error" },
  }));
  const errorClient = new AgentApiClient({
    apiOrigin: errorOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
  });
  await assert.rejects(
    () => errorClient.persistRunTerminalIntent(terminalControlInput),
    (error: unknown) =>
      error instanceof InternalRpcHttpError && error.status === 500,
  );
});

const validExecutionProfileResponse = {
  resolved: {
    runId: "RUN",
    sessionId: "SESSION",
    workspaceId: "WORKSPACE",
    agentId: "default",
    providerId: "ppchat",
    modelId: "gpt-5.2",
  },
  agent: {
    id: "default",
    name: "Default",
    summary: "",
    prompt: "system prompt",
    tools: [],
    pluginTools: [],
    mcpServers: [],
    defaultModel: { providerId: "ppchat", modelId: "gpt-5.2" },
  },
  provider: {
    id: "ppchat",
    name: "PPChat",
    npm: "@ai-sdk/openai",
    options: { baseURL: "http://llm.test/v1", apiKey: "api-key" },
  },
  model: {
    id: "gpt-5.2",
    name: "GPT 5.2",
    contextWindowTokens: 128000,
    options: { dynamic: true },
  },
  runtime: {
    modelIdleTimeoutMs: 1000,
    modelTotalTimeoutMs: 2000,
    modelRequestMaxRetries: 0,
    modelRequestRetryBackoffMaxMs: 60_000,
    autoCompactThresholdPct: 80,
    maxSubtaskDepth: 1,
    sessionTerminalSoundEnabled: true,
    visionModel: null,
    compactionModel: null,
    updatedAt: 1,
  },
  vision: null,
  compaction: null,
};

const validPromptContextResponse = {
  headMessageId: null,
  sessionRevision: 0,
  system: "system prompt",
  messages: [
    { role: "user", content: [{ type: "text", text: "dynamic message" }] },
  ],
  tools: [
    {
      name: "bash",
      description: "run command",
      inputSchema: { type: "object" },
    },
  ],
  pendingTools: [
    {
      toolExecutionId: "EXECUTION",
      callPartId: "CALL_PART",
      assistantMessageId: "MESSAGE",
      status: "queued",
      toolName: "bash",
      args: { command: "pwd" },
    },
  ],
  lastResponseTotalTokens: null,
  uiLocale: "zh-CN",
  externalSkillRoots: [
    {
      sourceType: "workspace",
      rootDir: ".agents",
      rootPath: "/workspace/.agents",
    },
  ],
};

const validMessagesContextResponse = {
  headMessageId: "MESSAGE",
  system: "system prompt",
  messages: [{ role: "user", content: "dynamic message" }],
};

test("read-side methods use shared endpoints, typed bodies, and valid strict/warn responses", async () => {
  const requests: Array<{
    method?: string;
    url?: string;
    body: unknown;
    token?: string | string[];
  }> = [];
  const origin = await startServer((request) => {
    requests.push({
      method: request.method,
      url: request.url,
      body: request.body,
      token: request.headers["x-awb-agent-internal-token"],
    });
    if (request.url === AgentApiEndpoints.getExecutionProfile.path)
      return { status: 200, body: validExecutionProfileResponse };
    if (request.url === AgentApiEndpoints.getPromptContext.path)
      return { status: 200, body: validPromptContextResponse };
    return { status: 200, body: validMessagesContextResponse };
  });
  const strictClient = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });
  const warnings: string[] = [];
  const warnClient = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) },
  });
  const executionProfileInput = {
    workspaceId: "WORKSPACE",
    sessionId: "SESSION",
    runId: "RUN",
  };
  const promptContextInput = {
    workspaceId: "WORKSPACE",
    sessionId: "SESSION",
    runId: "RUN",
  };
  const messagesContextInput = {
    workspaceId: "WORKSPACE",
    sessionId: "SESSION",
    appendMessage: { role: "user" as const, content: "read-side body" },
  };

  assert.deepEqual(
    await strictClient.getExecutionProfile(executionProfileInput),
    validExecutionProfileResponse,
  );
  assert.deepEqual(
    await strictClient.getPromptContext(promptContextInput),
    validPromptContextResponse,
  );
  assert.deepEqual(
    await strictClient.getMessagesContext(messagesContextInput),
    validMessagesContextResponse,
  );
  assert.deepEqual(
    await warnClient.getExecutionProfile(executionProfileInput),
    validExecutionProfileResponse,
  );
  assert.deepEqual(
    await warnClient.getPromptContext(promptContextInput),
    validPromptContextResponse,
  );
  assert.deepEqual(
    await warnClient.getMessagesContext(messagesContextInput),
    validMessagesContextResponse,
  );
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    requests.map(({ method, url, body, token }) => ({
      method,
      url,
      body,
      token,
    })),
    [
      {
        method: AgentApiEndpoints.getExecutionProfile.method,
        url: AgentApiEndpoints.getExecutionProfile.path,
        body: executionProfileInput,
        token: "TOKEN",
      },
      {
        method: AgentApiEndpoints.getPromptContext.method,
        url: AgentApiEndpoints.getPromptContext.path,
        body: promptContextInput,
        token: "TOKEN",
      },
      {
        method: AgentApiEndpoints.getMessagesContext.method,
        url: AgentApiEndpoints.getMessagesContext.path,
        body: messagesContextInput,
        token: "TOKEN",
      },
      {
        method: AgentApiEndpoints.getExecutionProfile.method,
        url: AgentApiEndpoints.getExecutionProfile.path,
        body: executionProfileInput,
        token: "TOKEN",
      },
      {
        method: AgentApiEndpoints.getPromptContext.method,
        url: AgentApiEndpoints.getPromptContext.path,
        body: promptContextInput,
        token: "TOKEN",
      },
      {
        method: AgentApiEndpoints.getMessagesContext.method,
        url: AgentApiEndpoints.getMessagesContext.path,
        body: messagesContextInput,
        token: "TOKEN",
      },
    ],
  );
});

test("read-side methods reject strict schema mismatches and warn without leaking payloads", async () => {
  const origin = await startServer((request) => ({
    status: 200,
    body: {
      apiKey: "apiKey secret",
      prompt: "prompt secret",
      messages: "messages secret",
      args: "args secret",
      result: "result secret",
      runId: "RUN",
      sessionId: "SESSION",
      endpoint: request.url,
    },
  }));
  const strictClient = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });
  await assert.rejects(
    () =>
      strictClient.getExecutionProfile({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
        runId: "RUN",
      }),
    (error: unknown) =>
      error instanceof InternalRpcInvalidResponseError &&
      error.stage === "schema",
  );
  await assert.rejects(
    () =>
      strictClient.getPromptContext({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
        runId: "RUN",
      }),
    (error: unknown) =>
      error instanceof InternalRpcInvalidResponseError &&
      error.stage === "schema",
  );
  await assert.rejects(
    () =>
      strictClient.getMessagesContext({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
      }),
    (error: unknown) =>
      error instanceof InternalRpcInvalidResponseError &&
      error.stage === "schema",
  );

  const warnings: string[] = [];
  const warnClient = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) },
  });
  await warnClient.getExecutionProfile({
    workspaceId: "WORKSPACE",
    sessionId: "SESSION",
    runId: "RUN",
  });
  await warnClient.getPromptContext({
    workspaceId: "WORKSPACE",
    sessionId: "SESSION",
    runId: "RUN",
  });
  await warnClient.getMessagesContext({
    workspaceId: "WORKSPACE",
    sessionId: "SESSION",
  });
  assert.equal(warnings.length, 3);
  for (const [index, endpoint] of [
    AgentApiEndpoints.getExecutionProfile,
    AgentApiEndpoints.getPromptContext,
    AgentApiEndpoints.getMessagesContext,
  ].entries()) {
    const warning = warnings[index] || "";
    assert.match(warning, new RegExp(`endpoint=${endpoint.path}`));
    assert.match(warning, new RegExp(`method=${endpoint.method}`));
    for (const sensitiveValue of [
      "TOKEN",
      "apiKey secret",
      "prompt secret",
      "messages secret",
      "args secret",
      "result secret",
      "RUN",
      "SESSION",
    ]) {
      assert.equal(
        warning.includes(sensitiveValue),
        false,
        `warning must not expose ${sensitiveValue}`,
      );
    }
  }
});

test("warn redacts sensitive TypeBox error paths and never includes schema messages", async () => {
  const warnings: string[] = [];
  const origin = await startServer(() => ({
    status: 200,
    body: {
      apiKey: 1,
      prompt: 2,
      messages: 3,
      args: 4,
      result: 5,
      runId: 6,
      sessionId: 7,
    },
  }));
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) },
  });
  await (client as any).request("/diagnostic", {
    method: "POST",
    body: {},
    responseEndpoint: "/diagnostic",
    policy: "controlRead",
    responseSchema: Type.Object({
      apiKey: Type.String(),
      prompt: Type.String(),
      messages: Type.String(),
      args: Type.String(),
      result: Type.String(),
      runId: Type.String(),
      sessionId: Type.String(),
    }),
  });
  assert.equal(warnings.length, 1);
  const warning = warnings[0] || "";
  assert.match(warning, /endpoint=\/diagnostic method=POST/);
  assert.match(warning, /path=<redacted> type=\d+/);
  for (const sensitiveText of [
    "apiKey",
    "prompt",
    "messages",
    "args",
    "result",
    "runId",
    "sessionId",
    "Expected",
    "TOKEN",
  ]) {
    assert.equal(
      warning.includes(sensitiveText),
      false,
      `warning must not expose ${sensitiveText}`,
    );
  }
});

test("read-side methods preserve unified non-2xx and malformed JSON failures in warn mode", async () => {
  const errorOrigin = await startServer((request) => ({
    status:
      request.url === AgentApiEndpoints.getExecutionProfile.path
        ? 401
        : request.url === AgentApiEndpoints.getPromptContext.path
          ? 404
          : 500,
    body: { message: `error for ${request.url}` },
  }));
  const errorClient = new AgentApiClient({
    apiOrigin: errorOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
  });

  await assert.rejects(
    () =>
      errorClient.getExecutionProfile({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
        runId: "RUN",
      }),
    (error: unknown) =>
      error instanceof InternalRpcHttpError && error.status === 401,
  );
  await assert.rejects(
    () =>
      errorClient.getPromptContext({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
        runId: "RUN",
      }),
    (error: unknown) =>
      error instanceof InternalRpcHttpError && error.status === 404,
  );
  await assert.rejects(
    () =>
      errorClient.getMessagesContext({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
      }),
    (error: unknown) =>
      error instanceof InternalRpcHttpError && error.status === 500,
  );

  const malformedOrigin = await startServer(() => ({
    status: 200,
    body: "not-json",
  }));
  const malformedClient = new AgentApiClient({
    apiOrigin: malformedOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
  });
  await assert.rejects(
    () =>
      malformedClient.getPromptContext({
        workspaceId: "WORKSPACE",
        sessionId: "SESSION",
        runId: "RUN",
      }),
    InternalRpcInvalidResponseError,
  );
});

test("Message assistant creation and ToolExecution update use shared contracts", async () => {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const origin = await startServer((request) => {
    requests.push(request);
    if (
      request.url === AgentApiEndpoints.createStreamingAssistant.path
      || request.url === AgentApiEndpoints.replaceStreamingAssistant.path
    ) {
      return { status: 200, body: request.url === AgentApiEndpoints.replaceStreamingAssistant.path ? { result: "updated", message: assistantMessage } : { message: assistantMessage } };
    }
    return { status: 200, body: { result: "updated" } };
  });
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });

  assert.deepEqual(
    await client.createStreamingAssistant(createAssistantInput),
    {
      message: assistantMessage,
    },
  );
  assert.deepEqual(await client.resumeStreamingAssistant(resumeAssistantInput), {
    result: "updated",
  });
  assert.deepEqual(
    await client.replaceStreamingAssistant(replaceAssistantInput),
    { result: "updated", message: assistantMessage },
  );
  assert.deepEqual(await client.updateToolExecution(toolExecutionInput), {
    result: "updated",
  });
  assert.deepEqual(
    requests.map((request) => ({ method: request.method, url: request.url })),
    [
      {
        method: AgentApiEndpoints.createStreamingAssistant.method,
        url: AgentApiEndpoints.createStreamingAssistant.path,
      },
      {
        method: AgentApiEndpoints.resumeStreamingAssistant.method,
        url: AgentApiEndpoints.resumeStreamingAssistant.path,
      },
      {
        method: AgentApiEndpoints.replaceStreamingAssistant.method,
        url: AgentApiEndpoints.replaceStreamingAssistant.path,
      },
      {
        method: AgentApiEndpoints.updateToolExecution.method,
        url: AgentApiEndpoints.updateToolExecution.path,
      },
    ],
  );
  assert.deepEqual(requests[1]?.body, resumeAssistantInput);
  assert.deepEqual(requests[2]?.body, replaceAssistantInput);
  assert.deepEqual(requests[3]?.body, toolExecutionInput);
});

test("Message ToolExecution writeback accepts the late ignored fenced branch", async () => {
  const origin = await startServer(() => ({
    status: 200,
    body: { result: "ignored" },
  }));
  const client = new AgentApiClient({
    apiOrigin: origin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });
  assert.deepEqual(await client.updateToolExecution(toolExecutionInput), {
    result: "ignored",
  });
});

test("Message assistant creation maps 409 to ApiConflictError while execution update preserves raw non-2xx", async () => {
  const createOrigin = await startServer(() => ({
    status: 409,
    body: { code: "SESSION_HEAD_CONFLICT" },
  }));
  const createClient = new AgentApiClient({
    apiOrigin: createOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });
  await assert.rejects(
    () => createClient.createStreamingAssistant(createAssistantInput),
    ApiConflictError,
  );

  const updateOrigin = await startServer(() => ({
    status: 409,
    body: { code: "SESSION_HEAD_CONFLICT" },
  }));
  const updateClient = new AgentApiClient({
    apiOrigin: updateOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });
  await assert.rejects(
    () => updateClient.updateToolExecution(toolExecutionInput),
    (error: unknown) =>
      error instanceof InternalRpcHttpError && error.status === 409,
  );
});

test("Message writeback response validation observes strict/warn boundaries", async () => {
  const strictOrigin = await startServer(() => ({
    status: 200,
    body: { message: { id: "MESSAGE" } },
  }));
  const strictClient = new AgentApiClient({
    apiOrigin: strictOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
  });
  await assert.rejects(
    () => strictClient.createStreamingAssistant(createAssistantInput),
    (error: unknown) =>
      error instanceof InternalRpcInvalidResponseError &&
      error.stage === "schema",
  );

  const warnings: string[] = [];
  const warnOrigin = await startServer(() => ({
    status: 200,
    body: {
      result: "updated",
      token: "TOKEN",
      prompt: "PROMPT",
      toolResult: "TOOL_RESULT",
    },
  }));
  const warnClient = new AgentApiClient({
    apiOrigin: warnOrigin,
    internalToken: "TOKEN",
    internalRpcTimeoutMs: 15_000,
    responseValidation: "warn",
    logger: { warn: (message: string) => warnings.push(message) },
  });
  const result = await warnClient.updateToolExecution(toolExecutionInput);
  assert.deepEqual(result, {
    result: "updated",
    token: "TOKEN",
    prompt: "PROMPT",
    toolResult: "TOOL_RESULT",
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.includes("TOKEN"), false);
  assert.equal(warnings[0]?.includes("PROMPT"), false);
  assert.equal(warnings[0]?.includes("TOOL_RESULT"), false);
});
