import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRunner,
  getNestedChildrenForTest,
  getNestedParentForTest,
  getRegisteredControllerForTest,
  executeToolForTest,
  processNestedRunWithControllerForTest,
  processRunForTest
} from "./runner.js";

function baseProfile() {
  return {
    model: "openai:gpt-4o-mini",
    provider: { npm: "@ai-sdk/openai", options: {} },
    agent: {
      tools: [],
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

function makeRun(sessionId: string, runId: string) {
  return {
    workspaceId: "ws_test",
    sessionId,
    runId,
    workspacePath: process.cwd(),
    workspaceRepoDirNames: [],
    inputText: "hello"
  };
}

test("nested child controller 注册并在完成后清理", async () => {
  const apiClient = {
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunState() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async completeRun() {
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  let seenControllerDuringRun = false;
  (runner as any).runModelStep = async () => {
    seenControllerDuringRun = Boolean(getRegisteredControllerForTest(runner, "sess_child"));
    return { aborted: false as const, toolCallCount: 0, assistantItemId: 1, hasVisibleText: true };
  };

  await processNestedRunWithControllerForTest(runner, {
    parentSessionId: "sess_parent",
    run: makeRun("sess_child", "run_child"),
    parentSignal: new AbortController().signal
  });

  assert.equal(seenControllerDuringRun, true);
  assert.equal(getRegisteredControllerForTest(runner, "sess_child"), undefined);
  assert.deepEqual(getNestedChildrenForTest(runner, "sess_parent"), []);
  assert.equal(getNestedParentForTest(runner, "sess_child"), undefined);
});

test("父 signal abort 会桥接到 child controller", async () => {
  const apiClient = {
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunState() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async completeRun() {
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  let childSignal!: AbortSignal;
  let resolveStep!: () => void;
  const stepGate = new Promise<void>((resolve) => {
    resolveStep = resolve;
  });
  (runner as any).runModelStep = async ({ signal }: { signal: AbortSignal }) => {
    childSignal = signal;
    await stepGate;
    return { aborted: true as const, assistantItemId: 1 };
  };
  const parentController = new AbortController();
  const nestedPromise = processNestedRunWithControllerForTest(runner, {
    parentSessionId: "sess_parent",
    run: makeRun("sess_child", "run_child"),
    parentSignal: parentController.signal
  });

  await new Promise((resolve) => setImmediate(resolve));
  parentController.abort();
  assert.equal(childSignal.aborted, true);
  resolveStep();
  await nestedPromise;
});

test("直接 cancel childSessionId 能命中 nested child controller", async () => {
  const apiClient = {
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunState() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async completeRun() {
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  let resolveStep!: () => void;
  const stepGate = new Promise<void>((resolve) => {
    resolveStep = resolve;
  });
  let childSignal!: AbortSignal;
  (runner as any).runModelStep = async ({ signal }: { signal: AbortSignal }) => {
    childSignal = signal;
    await stepGate;
    return { aborted: true as const, assistantItemId: 1 };
  };

  const nestedPromise = processNestedRunWithControllerForTest(runner, {
    parentSessionId: "sess_parent",
    run: makeRun("sess_child", "run_child"),
    parentSignal: new AbortController().signal
  });

  await new Promise((resolve) => setImmediate(resolve));
  runner.cancelSession("sess_child");
  assert.equal(childSignal.aborted, true);
  resolveStep();
  await nestedPromise;
});

test("取消父 session 会本地级联 abort 当前 nested child", async () => {
  const apiClient = {
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunState() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async completeRun() {
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  let resolveStep!: () => void;
  const stepGate = new Promise<void>((resolve) => {
    resolveStep = resolve;
  });
  let childSignal!: AbortSignal;
  (runner as any).runModelStep = async ({ signal }: { signal: AbortSignal }) => {
    childSignal = signal;
    await stepGate;
    return { aborted: true as const, assistantItemId: 1 };
  };

  const nestedPromise = processNestedRunWithControllerForTest(runner, {
    parentSessionId: "sess_parent",
    run: makeRun("sess_child", "run_child"),
    parentSignal: new AbortController().signal
  });

  await new Promise((resolve) => setImmediate(resolve));
  runner.cancelSession("sess_parent");
  assert.equal(childSignal.aborted, true);
  resolveStep();
  await nestedPromise;
});

test("processRun 因 signal.aborted 退出时 completeRun(cancelled) 恰好一次", async () => {
  const completed: string[] = [];
  const apiClient = {
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunState() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async completeRun(input: { status: string }) {
      completed.push(input.status);
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const controller = new AbortController();
  (runner as any).runModelStep = async () => {
    controller.abort();
    return { aborted: true as const, assistantItemId: 1 };
  };

  await processRunForTest(runner, makeRun("sess_test", "run_test"), controller.signal);

  assert.deepEqual(completed, ["cancelled"]);
});

test("processRun cancelled 首次 completeRun 失败后会按原终态重试成功", async () => {
  const completed: string[] = [];
  let attempts = 0;
  const apiClient = {
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunState() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async completeRun(input: { status: string }) {
      completed.push(input.status);
      attempts += 1;
      if (attempts === 1) throw new Error("transient completeRun failure");
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  const controller = new AbortController();
  (runner as any).runModelStep = async () => {
    controller.abort();
    return { aborted: true as const, assistantItemId: 1 };
  };

  await processRunForTest(runner, makeRun("sess_test", "run_test"), controller.signal);

  assert.deepEqual(completed, ["cancelled", "cancelled"]);
});

test("processRun completed 首次 completeRun 失败后不会错误降级为 failed", async () => {
  const completed: string[] = [];
  let attempts = 0;
  const apiClient = {
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunState() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async completeRun(input: { status: string }) {
      completed.push(input.status);
      attempts += 1;
      if (attempts === 1) throw new Error("transient completeRun failure");
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => {
    return { aborted: false as const, toolCallCount: 0, assistantItemId: 1, hasVisibleText: true };
  };

  await processRunForTest(runner, makeRun("sess_test", "run_test"), new AbortController().signal);

  assert.deepEqual(completed, ["completed", "completed"]);
});

test("processRun 遇到 abort-like error 时只提交一次 cancelled", async () => {
  const completed: string[] = [];
  const apiClient = {
    async getExecutionProfile() {
      return baseProfile();
    },
    async updateRunState() {
      return;
    },
    async getPromptContext() {
      return baseContext();
    },
    async completeRun(input: { status: string }) {
      completed.push(input.status);
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).runModelStep = async () => {
    const err = new Error("request aborted");
    (err as Error & { name: string }).name = "AbortError";
    throw err;
  };

  await processRunForTest(runner, makeRun("sess_test", "run_test"), new AbortController().signal);

  assert.deepEqual(completed, ["cancelled"]);
});

test("executeTool 遇到 AbortError 不会把工具项更新为 failed", async () => {
  const statuses: string[] = [];
  const apiClient = {
    async updateContextItem(input: { status: string }) {
      statuses.push(input.status);
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).toolRegistry = {
    async isToolEnabled() {
      return true;
    },
    async execute() {
      const err = new Error("request aborted");
      (err as Error & { name: string }).name = "AbortError";
      throw err;
    }
  };

  const result = await executeToolForTest(runner, {
    profile: baseProfile(),
    run: makeRun("sess_parent", "run_parent"),
    tool: {
      itemId: 1,
      status: "queued",
      toolName: "bash",
      toolCallId: "call_abort_tool",
      args: { command: "sleep 1" }
    },
    parentSessionId: "sess_parent",
    signal: new AbortController().signal,
    promptContext: baseContext()
  });

  assert.deepEqual(result, { paused: false });
  assert.deepEqual(statuses, ["running"]);
});

test("read probe 期间 signal abort 时不会把根路径错误写成 failed", async () => {
  const statuses: string[] = [];
  const controller = new AbortController();
  const apiClient = {
    async updateContextItem(input: { status: string }) {
      statuses.push(input.status);
      return;
    }
  };
  const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
  (runner as any).toolRegistry = {
    async isToolEnabled() {
      return true;
    },
    async execute() {
      controller.abort();
      throw new Error("ENOENT: no such file or directory, lstat '/workspace/src/a.ts'");
    }
  };

  await executeToolForTest(runner, {
    profile: baseProfile(),
    run: makeRun("sess_parent", "run_parent"),
    tool: {
      itemId: 2,
      status: "queued",
      toolName: "read",
      toolCallId: "call_abort_read",
      args: { filePath: "src/a.ts" }
    },
    parentSessionId: "sess_parent",
    signal: controller.signal,
    promptContext: baseContext()
  });

  assert.deepEqual(statuses, ["running"]);
});
