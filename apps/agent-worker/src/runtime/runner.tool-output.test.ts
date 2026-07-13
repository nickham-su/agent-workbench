import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AgentRunner,
  buildProviderOptionsWithPromptCacheKeyForTest,
  buildToolExecutionBatchesForTest,
  finalizeToolTextForTest,
  hasValidPromptCacheKeyForTest
} from "./runner.js";
import { getBashToolAppendix, startBashToolProbe } from "./bashTools.js";

function pendingTool(input: {
  itemId: number;
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
}) {
  return {
    itemId: input.itemId,
    status: "queued" as const,
    toolName: input.toolName,
    toolCallId: input.toolCallId ?? `call_${input.itemId}`,
    args: input.args ?? {}
  };
}

async function withTempWorkspace(fn: (workspacePath: string) => Promise<void>) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-runner-tool-output-"));
  try {
    await fn(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

test("bash tool appendix uses English labels", async () => {
  startBashToolProbe({ warn() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const appendix = getBashToolAppendix();
  if (!appendix) return;
  assert.equal(appendix.includes("Known available tools:") || appendix.includes("Runtime environment:"), true);
  assert.equal(appendix.includes("已知可用工具:"), false);
  assert.equal(appendix.includes("运行环境:"), false);
});

test("subtask 长输出不截断且不生成 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const longText = "S".repeat(9_500);
    const output = await finalizeToolTextForTest({
      workspacePath,
      itemId: 1,
      toolName: "subtask",
      toolCallId: "call_subtask_long",
      text: longText
    });

    assert.equal(output.text, longText);
    assert.equal(output.textTruncated, false);
    assert.equal(output.textArtifactPath, undefined);
    await assert.rejects(
      fs.access(path.join(workspacePath, ".awb", "agent", "artifacts", "by_tool_call", "subtask", "call_subtask_long.txt"))
    );
  });
});

test("非 subtask 长输出仍截断并写入 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const longText = "B".repeat(9_500);
    const output = await finalizeToolTextForTest({
      workspacePath,
      itemId: 2,
      toolName: "bash",
      toolCallId: "call_bash_long",
      text: longText
    });

    assert.equal(output.textTruncated, true);
    assert.equal(output.text.includes("[truncated]"), true);
    assert.equal(output.textArtifactPath, ".awb/agent/artifacts/by_tool_call/bash/call_bash_long.txt");
    assert.equal(await fs.readFile(path.join(workspacePath, output.textArtifactPath), "utf8"), longText);
  });
});

test("subtask executeTool 成功时 completed output 保留完整长文本且无 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ status?: string; output?: Record<string, unknown> }> = [];
    const longText = "R".repeat(9_500);
    const apiClient = {
      async updateContextItem(input: { status?: string; output?: Record<string, unknown> }) {
        updates.push({ status: input.status, output: input.output });
        return { id: 1 };
      },
      async updateRunState() {
        return;
      },
      async startSubtaskRun() {
        return { sessionId: "sub_succ", runId: "run_sub_succ", workspacePath, agentName: "Researcher" };
      },
      async getSubtaskStatus() {
        return { status: "completed" as const };
      },
      async getSubtaskResult() {
        return { resultText: longText };
      }
    };

    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).processRun = async () => {};

    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["subtask"],
          pluginTools: []
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath
      },
      tool: pendingTool({
        itemId: 201,
        toolName: "subtask",
        toolCallId: "call_subtask_execute_success",
        args: { description: "desc", prompt: "prompt", agentId: "agent_a", session: { mode: "new" } }
      }),
      signal: new AbortController().signal,
      promptContext: { tools: [] }
    });

    assert.equal(result.paused, false);
    let completed: { status?: string; output?: Record<string, unknown> } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "completed") {
        completed = item;
        break;
      }
    }
    assert.ok(completed, "should have completed update");
    const output = (completed.output || {}) as Record<string, unknown>;
    assert.equal(output.text, `tool: subtask\nstatus: completed\nsubtask_session_id: sub_succ\n\n${longText}`);
    assert.equal(output.textTruncated, undefined);
    assert.equal(output.textArtifactPath, undefined);
    assert.deepEqual(output.result, {
      subtaskSessionId: "sub_succ",
      subtaskAgentId: "agent_a",
      subtaskAgentName: "Researcher",
      resultText: longText
    });
  });
});

test("subtask executeTool 失败时 failed output 保留错误状态与完整结果且无 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ status?: string; output?: Record<string, unknown> }> = [];
    const longText = "F".repeat(9_500);
    const apiClient = {
      async updateContextItem(input: { status?: string; output?: Record<string, unknown> }) {
        updates.push({ status: input.status, output: input.output });
        return { id: 1 };
      },
      async updateRunState() {
        return;
      },
      async startSubtaskRun() {
        return { sessionId: "sub_fail", runId: "run_sub_fail", workspacePath, agentName: "Researcher" };
      },
      async getSubtaskStatus() {
        return { status: "failed" as const };
      },
      async getSubtaskResult() {
        return { resultText: longText };
      }
    };

    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).processRun = async () => {};

    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["subtask"],
          pluginTools: []
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath
      },
      tool: pendingTool({
        itemId: 202,
        toolName: "subtask",
        toolCallId: "call_subtask_execute_failed",
        args: { description: "desc", prompt: "prompt", agentId: "agent_a", session: { mode: "new" } }
      }),
      signal: new AbortController().signal,
      promptContext: { tools: [] }
    });

    assert.equal(result.paused, false);
    let failed: { status?: string; output?: Record<string, unknown> } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = (failed.output || {}) as Record<string, unknown>;
    assert.equal(output.text, `tool: subtask\nstatus: failed\nsubtask_session_id: sub_fail\n\nsubtask failed\n\n${longText}`);
    assert.equal(output.textTruncated, undefined);
    assert.equal(output.textArtifactPath, undefined);
    assert.equal(output.error, "subtask failed");
    assert.deepEqual(output.result, { subtaskSessionId: "sub_fail", resultText: longText });
  });
});

test("bash 后接 subtask 时拆成两个并发段", () => {
  const batches = buildToolExecutionBatchesForTest([
    pendingTool({ itemId: 1, toolName: "bash" }),
    pendingTool({ itemId: 2, toolName: "subtask" }),
    pendingTool({ itemId: 3, toolName: "bash" })
  ]);

  assert.deepEqual(
    batches.map((batch) => ({ mode: batch.mode, itemIds: batch.tools.map((tool) => tool.itemId) })),
    [
      { mode: "parallel", itemIds: [1] },
      { mode: "parallel", itemIds: [2] },
      { mode: "parallel", itemIds: [3] }
    ]
  );
});

test("openai providerOptions 为空时自动补 promptCacheKey", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    workspaceId: "ws_123",
    providerOptions: {}
  });

  assert.deepEqual(options, {
    promptCacheKey: "awb:ws_123"
  });
});

test("openai providerOptions 缺少 promptCacheKey 时自动补默认值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    workspaceId: "ws_123",
    providerOptions: { temperature: 0.2 }
  });

  assert.deepEqual(options, {
    temperature: 0.2,
    promptCacheKey: "awb:ws_123"
  });
});

test("openai providerOptions 已配置 promptCacheKey 时保持原值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    workspaceId: "ws_123",
    providerOptions: { temperature: 0.2, promptCacheKey: "user-defined" }
  });

  assert.deepEqual(options, {
    temperature: 0.2,
    promptCacheKey: "user-defined"
  });
});

test("仅有效非空字符串 promptCacheKey 才视为已配置", () => {
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: "user-defined" }), true);
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: "  user-defined  " }), true);
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: "" }), false);
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: "   " }), false);
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: null }), false);
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: undefined }), false);
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: 123 }), false);
});

test("openai providerOptions 的空字符串 promptCacheKey 会回退默认值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    workspaceId: "ws_123",
    providerOptions: { promptCacheKey: "" }
  });

  assert.deepEqual(options, {
    promptCacheKey: "awb:ws_123"
  });
});

test("openai providerOptions 的空白 promptCacheKey 会回退默认值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    workspaceId: "ws_123",
    providerOptions: { promptCacheKey: "   " }
  });

  assert.deepEqual(options, {
    promptCacheKey: "awb:ws_123"
  });
});

test("openai providerOptions 的 null/undefined/非字符串 promptCacheKey 会回退默认值", () => {
  assert.deepEqual(
    buildProviderOptionsWithPromptCacheKeyForTest({
      providerNpm: "@ai-sdk/openai",
      workspaceId: "ws_123",
      providerOptions: { promptCacheKey: null }
    }),
    { promptCacheKey: "awb:ws_123" }
  );
  assert.deepEqual(
    buildProviderOptionsWithPromptCacheKeyForTest({
      providerNpm: "@ai-sdk/openai",
      workspaceId: "ws_123",
      providerOptions: { promptCacheKey: undefined, other: true }
    }),
    { promptCacheKey: "awb:ws_123", other: true }
  );
});

test("subtask 后接 bash 时拆成两个并发段", () => {
  const batches = buildToolExecutionBatchesForTest([
    pendingTool({ itemId: 1, toolName: "subtask" }),
    pendingTool({ itemId: 2, toolName: "bash" }),
    pendingTool({ itemId: 3, toolName: "subtask" })
  ]);

  assert.deepEqual(
    batches.map((batch) => ({ mode: batch.mode, itemIds: batch.tools.map((tool) => tool.itemId) })),
    [
      { mode: "parallel", itemIds: [1] },
      { mode: "parallel", itemIds: [2] },
      { mode: "parallel", itemIds: [3] }
    ]
  );
});

test("非并发工具会打断并发段", () => {
  const batches = buildToolExecutionBatchesForTest([
    pendingTool({ itemId: 1, toolName: "bash" }),
    pendingTool({ itemId: 2, toolName: "bash" }),
    pendingTool({ itemId: 3, toolName: "read" }),
    pendingTool({ itemId: 4, toolName: "subtask" }),
    pendingTool({ itemId: 5, toolName: "subtask" })
  ]);

  assert.deepEqual(
    batches.map((batch) => ({ mode: batch.mode, itemIds: batch.tools.map((tool) => tool.itemId) })),
    [
      { mode: "parallel", itemIds: [1, 2] },
      { mode: "serial", itemIds: [3] },
      { mode: "parallel", itemIds: [4, 5] }
    ]
  );
});

test("并发段超过上限时自动拆段", () => {
  const batches = buildToolExecutionBatchesForTest([
    pendingTool({ itemId: 1, toolName: "bash" }),
    pendingTool({ itemId: 2, toolName: "bash" }),
    pendingTool({ itemId: 3, toolName: "bash" }),
    pendingTool({ itemId: 4, toolName: "bash" }),
    pendingTool({ itemId: 5, toolName: "bash" })
  ]);

  assert.deepEqual(
    batches.map((batch) => ({ mode: batch.mode, itemIds: batch.tools.map((tool) => tool.itemId) })),
    [
      { mode: "parallel", itemIds: [1, 2, 3] },
      { mode: "parallel", itemIds: [4, 5] }
    ]
  );
});

test("并发段中单个工具失败不影响其他工具与后续段", async () => {
  const executionOrder: string[] = [];
  const runner = new AgentRunner(
    {
      async updateContextItem() {
        return { id: 1 };
      },
      async updateRunState() {
        executionOrder.push("updateRunState");
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  (runner as any).executeTool = async ({ tool }: { tool: { itemId: number; toolName: string } }) => {
    executionOrder.push(`start:${tool.itemId}:${tool.toolName}`);
    if (tool.itemId === 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      executionOrder.push(`done:${tool.itemId}`);
      return { paused: false as const };
    }
    if (tool.itemId === 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(`fail:${tool.itemId}`);
      throw new Error("simulated failure");
    }
    executionOrder.push(`done:${tool.itemId}`);
    return { paused: false as const };
  };

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["bash", "subtask", "read"]
      }
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: process.cwd()
    },
    context: {
      pendingTools: [
        pendingTool({ itemId: 1, toolName: "bash" }),
        pendingTool({ itemId: 2, toolName: "bash" }),
        pendingTool({ itemId: 3, toolName: "read" })
      ]
    },
    signal: new AbortController().signal
  });

  assert.equal(result.paused, false);
  assert.deepEqual(
    executionOrder,
    [
      "start:1:bash",
      "start:2:bash",
      "fail:2",
      "done:1",
      "start:3:read",
      "done:3",
      "updateRunState"
    ]
  );
});

test("并发段中某个工具 paused 时当前 step 返回 paused 且后续段不再启动", async () => {
  const executionOrder: string[] = [];
  const runner = new AgentRunner(
    {
      async updateContextItem() {
        return { id: 1 };
      },
      async updateRunState() {
        executionOrder.push("updateRunState");
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  (runner as any).executeTool = async ({ tool }: { tool: { itemId: number; toolName: string } }) => {
    executionOrder.push(`start:${tool.itemId}:${tool.toolName}`);
    if (tool.itemId === 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      executionOrder.push(`done:${tool.itemId}`);
      return { paused: false as const };
    }
    if (tool.itemId === 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(`paused:${tool.itemId}`);
      return { paused: true as const };
    }
    executionOrder.push(`done:${tool.itemId}`);
    return { paused: false as const };
  };

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["bash", "subtask", "read"]
      }
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: process.cwd()
    },
    context: {
      pendingTools: [
        pendingTool({ itemId: 1, toolName: "bash" }),
        pendingTool({ itemId: 2, toolName: "bash" }),
        pendingTool({ itemId: 3, toolName: "read" })
      ]
    },
    signal: new AbortController().signal
  });

  assert.equal(result.paused, true);
  assert.deepEqual(executionOrder, ["start:1:bash", "start:2:bash", "paused:2", "done:1"]);
});

test("被预处理掉的中间工具仍会打断并发段", async () => {
  const executionOrder: string[] = [];
  const runner = new AgentRunner(
    {
      async updateContextItem(input: { itemId: number; status?: string }) {
        executionOrder.push(`update:${input.itemId}:${input.status ?? ""}`);
        return { id: input.itemId };
      },
      async updateRunState() {
        executionOrder.push("updateRunState");
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  (runner as any).executeTool = async ({ tool }: { tool: { itemId: number; toolName: string } }) => {
    executionOrder.push(`start:${tool.itemId}:${tool.toolName}`);
    await new Promise((resolve) => setTimeout(resolve, tool.itemId === 1 ? 25 : 5));
    executionOrder.push(`done:${tool.itemId}`);
    return { paused: false as const };
  };

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["bash"]
      }
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: process.cwd()
    },
    context: {
      pendingTools: [
        pendingTool({ itemId: 1, toolName: "bash" }),
        pendingTool({ itemId: 2, toolName: "read" }),
        pendingTool({ itemId: 3, toolName: "bash" })
      ]
    },
    signal: new AbortController().signal
  });

  assert.equal(result.paused, false);
  assert.deepEqual(executionOrder, [
    "update:2:failed",
    "start:1:bash",
    "done:1",
    "start:3:bash",
    "done:3",
    "updateRunState"
  ]);
});

test("纯非并发多工具保持原有串行语义", async () => {
  const executionOrder: string[] = [];
  const runner = new AgentRunner(
    {
      async updateContextItem() {
        return { id: 1 };
      },
      async updateRunState() {
        executionOrder.push("updateRunState");
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  (runner as any).executeTool = async ({ tool }: { tool: { itemId: number; toolName: string } }) => {
    executionOrder.push(`start:${tool.itemId}:${tool.toolName}`);
    await new Promise((resolve) => setTimeout(resolve, tool.itemId === 1 ? 25 : 5));
    executionOrder.push(`done:${tool.itemId}`);
    return { paused: false as const };
  };

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["read", "write", "apply_patch"]
      }
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: process.cwd()
    },
    context: {
      pendingTools: [
        pendingTool({ itemId: 1, toolName: "read" }),
        pendingTool({ itemId: 2, toolName: "write" }),
        pendingTool({ itemId: 3, toolName: "apply_patch" })
      ]
    },
    signal: new AbortController().signal
  });

  assert.equal(result.paused, false);
  assert.deepEqual(executionOrder, ["start:1:read", "done:1", "start:2:write", "done:2", "start:3:apply_patch", "done:3", "updateRunState"]);
});

test("单个 bash 或 subtask 仍按单段执行，行为与旧实现一致", async () => {
  for (const toolName of ["bash", "subtask"] as const) {
    const executionOrder: string[] = [];
    const runner = new AgentRunner(
      {
        async updateContextItem() {
          return { id: 1 };
        },
        async updateRunState() {
          executionOrder.push("updateRunState");
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );

    (runner as any).executeTool = async ({ tool }: { tool: { itemId: number; toolName: string } }) => {
      executionOrder.push(`start:${tool.itemId}:${tool.toolName}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(`done:${tool.itemId}`);
      return { paused: false as const };
    };

    const result = await (runner as any).executePendingTools({
      profile: {
        agent: {
          tools: [toolName]
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: `ses_${toolName}`,
        runId: `run_${toolName}`,
        workspacePath: process.cwd()
      },
      context: {
        pendingTools: [pendingTool({ itemId: 1, toolName })]
      },
      signal: new AbortController().signal
    });

    assert.equal(result.paused, false);
    assert.deepEqual(executionOrder, [`start:1:${toolName}`, "done:1", "updateRunState"]);
  }
});

test("tool 文本过长且 artifact 不可写时降级为 completed + artifact unavailable", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const bigFilePath = path.join(workspacePath, "big.txt");
    const bigContent = `${Array.from({ length: 2600 }, (_, i) => `line-${i.toString().padStart(4, "0")} abcdefghijklmnopqrstuvwxyz`).join("\n")}\n`;
    await fs.writeFile(bigFilePath, bigContent, "utf8");

    // 将 .awb 占位为普通文件,让 artifact 目录无法创建,触发降级分支。
    await fs.writeFile(path.join(workspacePath, ".awb"), "blocked", "utf8");

    const updates: Array<{ status?: string; output?: unknown }> = [];
    const apiClient = {
      async updateContextItem(input: { status?: string; output?: unknown }) {
        updates.push({ status: input.status, output: input.output });
        return { id: 1 };
      },
      async updateRunState() {
        return;
      }
    };

    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["read"]
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath
      },
      tool: {
        itemId: 123,
        status: "queued",
        toolName: "read",
        toolCallId: "call_read_1",
        args: {
          filePath: "big.txt",
          offset: 1,
          limit: 2000
        }
      },
      signal: new AbortController().signal
    });

    assert.equal(result.paused, false);
    assert.equal(updates.some((item) => item.status === "failed"), false);

    let completed: { status?: string; output?: unknown } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "completed") {
        completed = item;
        break;
      }
    }
    assert.ok(completed, "should have completed update");

    const output = (completed.output || {}) as Record<string, unknown>;
    assert.equal(typeof output.text, "string");
    assert.equal(String(output.text || "").includes("artifact: unavailable"), true);
    assert.equal(output.textTruncated, true);
    assert.equal(Object.prototype.hasOwnProperty.call(output, "textArtifactPath"), false);
  });
});

test("read offset 越界时应 completed 且不输出误导性的请求 range", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, "small.txt"), "alpha\nbeta\n", "utf8");

    const updates: Array<{ status?: string; output?: unknown }> = [];
    const apiClient = {
      async updateContextItem(input: { status?: string; output?: unknown }) {
        updates.push({ status: input.status, output: input.output });
        return { id: 1 };
      },
      async updateRunState() {
        return;
      }
    };

    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["read"]
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath
      },
      tool: {
        itemId: 124,
        status: "queued",
        toolName: "read",
        toolCallId: "call_read_2",
        args: {
          filePath: "small.txt",
          offset: 5,
          limit: 20
        }
      },
      signal: new AbortController().signal
    });

    assert.equal(result.paused, false);
    assert.equal(updates.some((item) => item.status === "failed"), false);

    let completed: { status?: string; output?: unknown } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "completed") {
        completed = item;
        break;
      }
    }
    assert.ok(completed, "should have completed update");

    const output = (completed.output || {}) as Record<string, unknown>;
    const text = String(output.text || "");
    assert.equal(String(output.error || ""), "");
    assert.equal(text.includes("tool: read"), true);
    assert.equal(text.includes("status: completed"), true);
    assert.equal(text.includes("End of file - total 2 lines. Requested offset=5 exceeds file length. No more content to read. Do not call read again for this file unless the file changes."), true);
    assert.equal(text.includes("range: 5-24"), false);
    assert.equal(text.includes("range: 5"), false);
  });
});

test("read 目录 offset 越界时应 completed 且不输出误导性的请求 range", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.mkdir(path.join(workspacePath, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "nested", "a.txt"), "a", "utf8");
    await fs.writeFile(path.join(workspacePath, "nested", "b.txt"), "b", "utf8");

    const updates: Array<{ status?: string; output?: unknown }> = [];
    const apiClient = {
      async updateContextItem(input: { status?: string; output?: unknown }) {
        updates.push({ status: input.status, output: input.output });
        return { id: 1 };
      },
      async updateRunState() {
        return;
      }
    };

    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["read"]
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath
      },
      tool: {
        itemId: 125,
        status: "queued",
        toolName: "read",
        toolCallId: "call_read_3",
        args: {
          filePath: "nested",
          offset: 5,
          limit: 20
        }
      },
      signal: new AbortController().signal
    });

    assert.equal(result.paused, false);
    assert.equal(updates.some((item) => item.status === "failed"), false);

    let completed: { status?: string; output?: unknown } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "completed") {
        completed = item;
        break;
      }
    }
    assert.ok(completed, "should have completed update");
    const text = String(((completed.output || {}) as Record<string, unknown>).text || "");
    assert.equal(text.includes("End of directory - total 2 entries. Requested offset=5 exceeds directory length. No more entries to read. Do not call read again for this directory unless the directory contents change."), true);
    assert.equal(text.includes("range: 5-24"), false);
    assert.equal(text.includes("range: 5"), false);
  });
});

test("bash workdir 不存在时应提示 bash.workdir not found", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ status?: string; output?: unknown }> = [];
    const apiClient = {
      async updateContextItem(input: { status?: string; output?: unknown }) {
        updates.push({ status: input.status, output: input.output });
        return { id: 1 };
      },
      async updateRunState() {
        return;
      }
    };

    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["bash"]
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath
      },
      tool: {
        itemId: 456,
        status: "queued",
        toolName: "bash",
        toolCallId: "call_bash_1",
        args: {
          command: "pwd",
          workdir: "missing_dir"
        }
      },
      signal: new AbortController().signal
    });

    assert.equal(result.paused, false);

    let failed: { status?: string; output?: unknown } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = ((failed || {}).output || {}) as Record<string, unknown>;
    assert.equal(String(output.error || ""), "bash.workdir not found: missing_dir");
    assert.equal(String(output.text || "").includes("bash.workdir not found: missing_dir"), true);
  });
});

test("bash workdir 为文件时应提示 bash.workdir must be a directory", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, "not_dir"), "x", "utf8");

    const updates: Array<{ status?: string; output?: unknown }> = [];
    const apiClient = {
      async updateContextItem(input: { status?: string; output?: unknown }) {
        updates.push({ status: input.status, output: input.output });
        return { id: 1 };
      },
      async updateRunState() {
        return;
      }
    };

    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["bash"]
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath
      },
      tool: {
        itemId: 789,
        status: "queued",
        toolName: "bash",
        toolCallId: "call_bash_2",
        args: {
          command: "pwd",
          workdir: "not_dir"
        }
      },
      signal: new AbortController().signal
    });

    assert.equal(result.paused, false);

    let failed: { status?: string; output?: unknown } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = ((failed || {}).output || {}) as Record<string, unknown>;
    assert.equal(String(output.error || ""), "bash.workdir must be a directory: not_dir");
    assert.equal(String(output.text || "").includes("bash.workdir must be a directory: not_dir"), true);
  });
});

test("bash 未传 workdir 且 workspace 根目录不存在时应提示 bash.cwd not found", async () => {
  await withTempWorkspace(async (workspacePath) => {
    // 移除 workspace 根目录,确保不会进入 spawn 分支。
    await fs.rm(workspacePath, { recursive: true, force: true });

    const updates: Array<{ status?: string; output?: unknown }> = [];
    const apiClient = {
      async updateContextItem(input: { status?: string; output?: unknown }) {
        updates.push({ status: input.status, output: input.output });
        return { id: 1 };
      },
      async updateRunState() {
        return;
      }
    };

    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["bash"]
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath
      },
      tool: {
        itemId: 101,
        status: "queued",
        toolName: "bash",
        toolCallId: "call_bash_3",
        args: {
          command: "pwd"
        }
      },
      signal: new AbortController().signal
    });

    assert.equal(result.paused, false);

    let failed: { status?: string; output?: unknown } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = ((failed || {}).output || {}) as Record<string, unknown>;
    assert.equal(String(output.error || ""), "bash.cwd not found: workspace root");
    assert.equal(String(output.text || "").includes("bash.cwd not found: workspace root"), true);
  });
});

test("bash workdir 某级为文件导致 ENOTDIR 时应提示 must be a directory", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, "file"), "x", "utf8");

    const updates: Array<{ status?: string; output?: unknown }> = [];
    const apiClient = {
      async updateContextItem(input: { status?: string; output?: unknown }) {
        updates.push({ status: input.status, output: input.output });
        return { id: 1 };
      },
      async updateRunState() {
        return;
      }
    };

    const runner = new AgentRunner(apiClient as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["bash"]
        }
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath
      },
      tool: {
        itemId: 102,
        status: "queued",
        toolName: "bash",
        toolCallId: "call_bash_4",
        args: {
          command: "pwd",
          workdir: "file/sub"
        }
      },
      signal: new AbortController().signal
    });

    assert.equal(result.paused, false);

    let failed: { status?: string; output?: unknown } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = ((failed || {}).output || {}) as Record<string, unknown>;
    assert.equal(String(output.error || ""), "bash.workdir must be a directory: file/sub");
    assert.equal(String(output.text || "").includes("bash.workdir must be a directory: file/sub"), true);
  });
});
