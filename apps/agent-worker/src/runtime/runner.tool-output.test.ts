import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  AgentRunner,
  buildProviderOptionsWithPromptCacheKeyForTest,
  buildToolExecutionBatchesForTest,
  executeToolForTest,
  finalizeToolTextForTest,
  warnToolErrorStoreFailureForTest,
  hasValidPromptCacheKeyForTest
} from "./runner.js";
import { getBashToolAppendix, startBashToolProbe } from "./bashTools.js";
import { runReadTool } from "./fileTools.js";
import { InternalRpcHttpError } from "./apiClient.js";

const execFileAsync = promisify(execFile);
const runnerModuleUrl = new URL("./runner.ts", import.meta.url).href;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function encodedNodeValues(graph: any) {
  return Object.values(graph.nodes ?? {}) as Array<any>;
}

function graphContainsString(snapshot: any, expected: string) {
  return encodedNodeValues(snapshot.graph).some((node) =>
    JSON.stringify(node).includes(JSON.stringify(expected))
  ) || JSON.stringify(snapshot.graph.root).includes(JSON.stringify(expected));
}

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

function stubListedTools(runner: AgentRunner, names: string[]) {
  (runner as any).toolRegistry.listTools = async () => names.map((name) => ({
    name,
    description: `fixture ${name}`,
    inputSchema: { type: "object", properties: {} },
    source: name.startsWith("plugin_") ? "plugin" : name.startsWith("mcp_") ? "mcp" : "builtin"
  }));
}

async function withTempWorkspace(fn: (workspacePath: string) => Promise<void>) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-runner-tool-output-"));
  try {
    await fn(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

function testProfile(toolName: string) {
  return {
    agent: {
      tools: [toolName],
      pluginTools: []
    }
  };
}

function testRun(workspacePath: string) {
  return {
    workspaceId: "ws_baseline",
    sessionId: "sess_baseline",
    runId: "run_baseline",
    workspacePath,
    workspaceRepoDirNames: []
  };
}

function testPromptContext() {
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

function latestUpdate(
  updates: Array<{ itemId?: number; status?: string; output?: Record<string, unknown> }>,
  status: string
) {
  for (let index = updates.length - 1; index >= 0; index -= 1) {
    if (updates[index]?.status === status) return updates[index];
  }
  return undefined;
}

test("tool error store warning 按工作区、路径、操作和错误码限频，并在下一窗口报告抑制数", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const warnings: string[] = [];
    let warningNow = 10_000;
    const runner = new AgentRunner(
      {} as any,
      {} as any,
      { info() {}, warn(message) { warnings.push(message); }, error() {} },
      1,
      { warningNowMs: () => warningNow }
    );
    const input = {
      workspacePath,
      relativePath: ".awb/agent/tool-errors/by_run/session/run/1-call.tool.json",
      operation: "publish_link",
      error: Object.assign(new Error("filesystem failure"), { code: "eio", artifactPayload: { events: ["must not log"] } })
    };

    await warnToolErrorStoreFailureForTest(runner, input);
    await warnToolErrorStoreFailureForTest(runner, input);
    await warnToolErrorStoreFailureForTest(runner, input);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.includes(`path=${input.relativePath}`), true);
    assert.equal(warnings[0]?.includes("must not log"), false);

    warningNow += 60_000;
    await warnToolErrorStoreFailureForTest(runner, input);
    assert.equal(warnings.length, 2);
    assert.equal(warnings[1]?.includes("suppressed=2"), true);
    assert.equal(warnings[1]?.includes("\n") || warnings[1]?.includes("\r"), false);
    assert.equal((warnings[1] ?? "").length <= 512, true);
  });
});

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

test("read 的 repo 路径提示错误仍以 failed 工具项持久化且没有 result", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ status?: string; output?: Record<string, unknown> }> = [];
    const runner = new AgentRunner(
      {
        async updateContextItem(input: { status?: string; output?: Record<string, unknown> }) {
          updates.push(input);
          return { id: 1 };
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );
    await fs.mkdir(path.join(workspacePath, "repo-a", "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "repo-a", "src", "a.ts"), "export {};", "utf8");
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return true;
      },
      async execute(_toolName: string, args: { filePath: string }, context: { run: { workspacePath: string; workspaceRepoDirNames: string[] } }) {
        return await runReadTool({
          workspacePath: context.run.workspacePath,
          workspaceRepoDirNames: context.run.workspaceRepoDirNames,
          filePath: args.filePath
        });
      }
    };

    await executeToolForTest(runner, {
    profile: { agent: { tools: ["read"], pluginTools: [] } },
    run: {
      workspaceId: "ws_test",
      sessionId: "sess_test",
      runId: "run_test",
      workspacePath,
      workspaceRepoDirNames: ["repo-a"]
    },
    tool: pendingTool({ itemId: 901, toolName: "read", args: { filePath: "src/a.ts" } }),
    parentSessionId: "sess_test",
    signal: new AbortController().signal,
    promptContext: { tools: [] }
    });

    let failed: { status?: string; output?: Record<string, unknown> } | undefined;
    for (let index = updates.length - 1; index >= 0; index -= 1) {
      if (updates[index]?.status === "failed") {
        failed = updates[index];
        break;
      }
    }
    assert.ok(failed, "read error should persist a failed tool item");
    const error = String(failed.output?.error || "");
    const hint = "Path exists in registered workspace repo(s). Retry read with one of:\n- repo-a/src/a.ts";
    assert.match(error, /^ENOENT: no such file or directory, path: src\/a\.ts/);
    assert.equal(error.includes(workspacePath), false);
    assert.equal(error.endsWith(`\n\n${hint}`), true);
    assert.equal(typeof failed.output?.text, "string");
    assert.equal((failed.output?.text as string).includes("tool: read"), true);
    assert.equal((failed.output?.text as string).includes("status: failed"), true);
    assert.equal((failed.output?.text as string).includes(error), true);
    assert.equal((failed.output?.text as string).includes(workspacePath), false);
    assert.equal("result" in (failed.output ?? {}), false);
  });
});

test("普通 Provider reject 会保留 failed output 的调用身份、参数、文本和错误", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ itemId?: number; status?: string; output?: Record<string, unknown> }> = [];
    const runner = new AgentRunner(
      {
        async updateContextItem(input: { itemId?: number; status?: string; output?: Record<string, unknown> }) {
          updates.push(input);
          return { id: input.itemId };
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return true;
      },
      async execute() {
        throw new Error("fixture provider rejected");
      }
    };
    const tool = pendingTool({
      itemId: 1101,
      toolName: "bash",
      toolCallId: "call_provider_rejected",
      args: { command: "echo fixture", timeout: 3 }
    });

    const result = await executeToolForTest(runner, {
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      tool,
      parentSessionId: "sess_baseline",
      signal: new AbortController().signal,
      promptContext: testPromptContext()
    });

    assert.deepEqual(result, { paused: false });
    const failed = latestUpdate(updates, "failed");
    assert.ok(failed);
    assert.equal(failed.output?.toolName, "bash");
    assert.equal(failed.output?.toolCallId, "call_provider_rejected");
    assert.deepEqual(failed.output?.args, tool.args);
    assert.equal(failed.output?.error, "fixture provider rejected");
    assert.equal(failed.output?.text, "tool: bash\nstatus: failed\n\nfixture provider rejected");
    assert.equal("result" in (failed.output ?? {}), false);
    await assert.rejects(fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")));
  });
});

test("subtask existing 会话缺失会为模型和用户持久化可行动的业务错误", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ itemId?: number; status?: string; output?: Record<string, unknown> }> = [];
    const runner = new AgentRunner(
      {
        async updateContextItem(input: { itemId?: number; status?: string; output?: Record<string, unknown> }) {
          updates.push(input);
          return { id: input.itemId };
        },
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return true;
      },
      async execute() {
        throw new InternalRpcHttpError({
          method: "POST",
          endpoint: "/api/internal/agent/subtask/start",
          status: 404,
          apiCode: "AGENT_SUBTASK_SESSION_NOT_FOUND",
          safeMessage: "subtask session not found",
        });
      },
    };
    await executeToolForTest(runner, {
      profile: testProfile("subtask"),
      run: testRun(workspacePath),
      tool: pendingTool({
        itemId: 1104,
        toolName: "subtask",
        args: {
          agentId: "agent_test",
          description: "child",
          prompt: "do it",
          session: { mode: "existing", sessionId: "sess_missing" },
        },
      }),
      parentSessionId: "sess_baseline",
      signal: new AbortController().signal,
      promptContext: testPromptContext(),
    });

    const failed = latestUpdate(updates, "failed");
    assert.ok(failed);
    const error = String(failed.output?.error || "");
    assert.match(error, /指定的 existing 子任务会话不存在或已失效/);
    assert.match(error, /session\.mode="new" 或 "fork"/);
    assert.match(error, /AGENT_SUBTASK_SESSION_NOT_FOUND/);
    assert.match(error, /HTTP 状态：404/);
    assert.equal(failed.output?.text, `tool: subtask\nstatus: failed\n\n${error}`);
    assert.equal(error.includes("internal rpc failed:"), false);
  });
});

test("pending 预检禁用 writeback 期间取消时不发布 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const controller = new AbortController();
      const api = {
        updateContextItem: async (input) => { controller.abort(); return { id: input.itemId, ...input }; },
        updateRunState: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => false;
      await runner.executePendingTools({
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
        context: { pendingTools: [{ itemId: 15, status: "queued", toolName: "bash", toolCallId: "call_policy_abort", args: {} }], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
        availableToolNames: new Set(["bash"]), signal: controller.signal
      });
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    await assert.rejects(fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")));
  });
});

test("running recovery writeback 期间取消时不发布 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const controller = new AbortController();
      const api = {
        updateContextItem: async (input) => { controller.abort(); return { id: input.itemId, ...input }; },
        updateRunState: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      await runner.executePendingTools({
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
        context: { pendingTools: [{ itemId: 16, status: "running", toolName: "bash", toolCallId: "call_recovery_abort", args: {} }], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
        availableToolNames: new Set(["bash"]), signal: controller.signal
      });
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    await assert.rejects(fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")));
  });
});

test("pending 预检禁用 failed writeback 失败时额外发布 runtime artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const api = {
        updateContextItem: async () => { throw new Error("policy writeback rejected"); },
        updateRunState: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => false;
      try {
        await runner.executePendingTools({
          profile: { agent: { tools: ["bash"], pluginTools: [] } },
          run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
          context: { pendingTools: [{ itemId: 17, status: "queued", toolName: "bash", toolCallId: "call_policy_writeback", args: {} }], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
          availableToolNames: new Set(["bash"]), signal: new AbortController().signal
        });
      } catch {}
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    const dir = path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "session", "run");
    const policyArtifact = JSON.parse(await fs.readFile(path.join(dir, "17-call_policy_writeback.policy.json"), "utf8"));
    const runtimeArtifact = JSON.parse(await fs.readFile(path.join(dir, "17-call_policy_writeback.runtime.json"), "utf8"));
    assert.deepEqual(policyArtifact.events.map((event: any) => event.stage), ["tool_disabled_pending_precheck"]);
    assert.equal(runtimeArtifact.failureKind, "runtime");
    assert.deepEqual(runtimeArtifact.events.map((event: any) => event.stage), ["failed_writeback_failed"]);
    assert.deepEqual(runtimeArtifact.writebacks.map((writeback: any) => [writeback.role, writeback.outcome]), [["policy_failed", "failed"]]);
  });
});

test("running recovery failed writeback 失败时额外发布 runtime artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const api = {
        updateContextItem: async () => { throw new Error("recovery writeback rejected"); },
        updateRunState: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      try {
        await runner.executePendingTools({
          profile: { agent: { tools: ["bash"], pluginTools: [] } },
          run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
          context: { pendingTools: [{ itemId: 18, status: "running", toolName: "bash", toolCallId: "call_recovery_writeback", args: {} }], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
          availableToolNames: new Set(["bash"]), signal: new AbortController().signal
        });
      } catch {}
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    const dir = path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "session", "run");
    const recoveryArtifact = JSON.parse(await fs.readFile(path.join(dir, "18-call_recovery_writeback.recovery.json"), "utf8"));
    const runtimeArtifact = JSON.parse(await fs.readFile(path.join(dir, "18-call_recovery_writeback.runtime.json"), "utf8"));
    assert.deepEqual(recoveryArtifact.events.map((event: any) => event.stage), ["running_item_recovered_as_failed"]);
    assert.equal(runtimeArtifact.failureKind, "runtime");
    assert.deepEqual(runtimeArtifact.events.map((event: any) => event.stage), ["failed_writeback_failed"]);
    assert.deepEqual(runtimeArtifact.writebacks.map((writeback: any) => [writeback.role, writeback.outcome]), [["recovery_failed", "failed"]]);
  });
});

test("executeTool 内二次禁用检查会写 failed 且不会调用 Provider", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ status?: string; output?: Record<string, unknown> }> = [];
    let executeCount = 0;
    const runner = new AgentRunner(
      {
        async updateContextItem(input: { status?: string; output?: Record<string, unknown> }) {
          updates.push(input);
          return { id: 1102 };
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return false;
      },
      async execute() {
        executeCount += 1;
        return { ignored: true };
      }
    };

    await executeToolForTest(runner, {
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      tool: pendingTool({ itemId: 1102, toolName: "bash", toolCallId: "call_execute_disabled", args: { command: "echo no" } }),
      parentSessionId: "sess_baseline",
      signal: new AbortController().signal,
      promptContext: testPromptContext()
    });

    assert.equal(executeCount, 0);
    assert.deepEqual(updates.map((item) => item.status), ["failed"]);
    assert.equal(updates[0]?.output?.error, "tool is disabled for current agent: bash");
    assert.equal(updates[0]?.output?.text, "tool: bash\nstatus: failed\n\ntool is disabled for current agent: bash");
  });
});

test("executePendingTools 的快照预检禁用会写 failed 且不会调度 executeTool", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ itemId?: number; status?: string; output?: Record<string, unknown> }> = [];
    let executeToolCount = 0;
    const runner = new AgentRunner(
      {
        async updateContextItem(input: { itemId?: number; status?: string; output?: Record<string, unknown> }) {
          updates.push(input);
          return { id: input.itemId };
        },
        async updateRunState() {
          return;
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return false;
      }
    };
    (runner as any).executeTool = async () => {
      executeToolCount += 1;
      return { paused: false as const };
    };

    const result = await (runner as any).executePendingTools({
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      context: { ...testPromptContext(), pendingTools: [pendingTool({ itemId: 1103, toolName: "bash", toolCallId: "call_pending_disabled", args: { command: "echo no" } })] },
      availableToolNames: new Set(["bash"]),
      signal: new AbortController().signal
    });

    assert.deepEqual(result, { paused: false });
    assert.equal(executeToolCount, 0);
    const failed = latestUpdate(updates, "failed");
    assert.ok(failed);
    assert.equal(failed.output?.error, "tool is disabled for current agent: bash");
    assert.equal(failed.output?.text, "tool: bash\nstatus: failed\n\ntool is disabled for current agent: bash");
  });
});

test("executePendingTools 会把遗留 running 工具标为 failed 且不重放", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ itemId?: number; status?: string; output?: Record<string, unknown> }> = [];
    let executeToolCount = 0;
    const runner = new AgentRunner(
      {
        async updateContextItem(input: { itemId?: number; status?: string; output?: Record<string, unknown> }) {
          updates.push(input);
          return { id: input.itemId };
        },
        async updateRunState() {
          return;
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return true;
      }
    };
    (runner as any).executeTool = async () => {
      executeToolCount += 1;
      return { paused: false as const };
    };

    const tool = { ...pendingTool({ itemId: 1104, toolName: "bash", toolCallId: "call_recovery", args: { command: "echo interrupted" } }), status: "running" as const };
    const result = await (runner as any).executePendingTools({
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      context: { ...testPromptContext(), pendingTools: [tool] },
      availableToolNames: new Set(["bash"]),
      signal: new AbortController().signal
    });

    assert.deepEqual(result, { paused: false });
    assert.equal(executeToolCount, 0);
    const failed = latestUpdate(updates, "failed");
    assert.ok(failed);
    assert.equal(failed.output?.error, "tool execution interrupted, mark failed and wait next step");
    assert.equal(
      failed.output?.text,
      "tool: bash\nstatus: failed\n\ntool execution interrupted, mark failed and wait next step"
    );
  });
});

test("普通 Provider fulfilled 会写完整 completed output", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ status?: string; output?: Record<string, unknown> }> = [];
    const providerResult = { stdout: "fixture output", exitCode: 0 };
    const runner = new AgentRunner(
      {
        async updateContextItem(input: { status?: string; output?: Record<string, unknown> }) {
          updates.push(input);
          return { id: 1105 };
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return true;
      },
      async execute() {
        return providerResult;
      }
    };
    const tool = pendingTool({ itemId: 1105, toolName: "bash", toolCallId: "call_provider_fulfilled", args: { command: "echo fixture" } });

    await executeToolForTest(runner, {
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      tool,
      parentSessionId: "sess_baseline",
      signal: new AbortController().signal,
      promptContext: testPromptContext()
    });

    const completed = latestUpdate(updates, "completed");
    assert.ok(completed);
    assert.equal(completed.output?.toolName, "bash");
    assert.equal(completed.output?.toolCallId, "call_provider_fulfilled");
    assert.deepEqual(completed.output?.args, tool.args);
    assert.deepEqual(completed.output?.result, providerResult);
    assert.equal(completed.output?.text, "tool: bash\nstatus: completed\nexit_code: 0\n\nstdout:\nfixture output");
  });
});

test("completed writeback reject 后内层会尝试 failed，failed writeback 再 reject 时外层会再次尝试 failed", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ status?: string; output?: Record<string, unknown> }> = [];
    let completedAttempts = 0;
    let failedAttempts = 0;
    const runner = new AgentRunner(
      {
        async updateContextItem(input: { status?: string; output?: Record<string, unknown> }) {
          updates.push(input);
          if (input.status === "completed") {
            completedAttempts += 1;
            throw new Error("fixture completed writeback rejected");
          }
          if (input.status === "failed") {
            failedAttempts += 1;
            if (failedAttempts === 1) throw new Error("fixture inner failed writeback rejected");
          }
          return { id: 1106 };
        }
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return true;
      },
      async execute() {
        return { stdout: "already returned" };
      }
    };

    const result = await (runner as any).executeToolSafely({
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      tool: pendingTool({ itemId: 1106, toolName: "bash", toolCallId: "call_completed_writeback_rejected", args: { command: "echo fixture" } }),
      parentSessionId: "sess_baseline",
      signal: new AbortController().signal,
      promptContext: testPromptContext()
    });

    assert.deepEqual(result, { paused: false });
    assert.equal(completedAttempts, 1);
    assert.equal(failedAttempts, 2);
    assert.deepEqual(updates.map((item) => item.status), ["running", "completed", "failed", "failed"]);
    assert.equal(updates[2]?.output?.error, "fixture completed writeback rejected");
    assert.equal(updates[3]?.output?.error, "fixture inner failed writeback rejected");
  });
});

test("启用既有 Debug Dump 时失败仍只写 .debug，不生成未实现的 tool-errors 目录", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner, executeToolForTest } from "./apps/agent-worker/src/runtime/runner.ts";
      const workspacePath = process.env.AWB_TEST_WORKSPACE;
      const runner = new AgentRunner(
        { async updateContextItem() { return { id: 1107 }; } },
        {},
        { info() {}, warn() {}, error() {} },
        1
      );
      runner.toolRegistry = {
        async isToolEnabled() { return true; },
        async execute() { throw new Error("fixture debug dump reject"); }
      };
      await executeToolForTest(runner, {
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: {
          workspaceId: "ws_debug",
          sessionId: "sess_debug",
          runId: "run_debug",
          workspacePath,
          workspaceRepoDirNames: []
        },
        tool: {
          itemId: 1107,
          status: "queued",
          toolName: "bash",
          toolCallId: "call_debug_dump",
          args: { command: "echo fixture" }
        },
        parentSessionId: "sess_debug",
        signal: new AbortController().signal,
        promptContext: { pendingTools: [], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] }
      });
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, AWB_AGENT_DEBUG_DUMP: "1", AWB_TEST_WORKSPACE: workspacePath }
    });

    const debugLog = await fs.readFile(
      path.join(workspacePath, ".debug", "agent_context_item_logs", "tool", "1107.log"),
      "utf8"
    );
    assert.match(debugLog, /fixture debug dump reject/);
    await assert.rejects(fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")));
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
        workspacePath,
        workspaceRepoDirNames: []
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
        workspacePath,
        workspaceRepoDirNames: []
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
    sessionId: "sess_123",
    providerOptions: {}
  });

  assert.deepEqual(options, {
    promptCacheKey: "awb:sess_123"
  });
});

test("openai providerOptions 缺少 promptCacheKey 时自动补默认值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    sessionId: "sess_123",
    providerOptions: { temperature: 0.2 }
  });

  assert.deepEqual(options, {
    temperature: 0.2,
    promptCacheKey: "awb:sess_123"
  });
});

test("openai providerOptions 已配置 promptCacheKey 时保持原值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    sessionId: "sess_123",
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
    sessionId: "sess_123",
    providerOptions: { promptCacheKey: "" }
  });

  assert.deepEqual(options, {
    promptCacheKey: "awb:sess_123"
  });
});

test("openai providerOptions 的空白 promptCacheKey 会回退默认值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    sessionId: "sess_123",
    providerOptions: { promptCacheKey: "   " }
  });

  assert.deepEqual(options, {
    promptCacheKey: "awb:sess_123"
  });
});

test("openai providerOptions 的 null/undefined/非字符串 promptCacheKey 会回退默认值", () => {
  assert.deepEqual(
    buildProviderOptionsWithPromptCacheKeyForTest({
      providerNpm: "@ai-sdk/openai",
      sessionId: "sess_123",
      providerOptions: { promptCacheKey: null }
    }),
    { promptCacheKey: "awb:sess_123" }
  );
  assert.deepEqual(
    buildProviderOptionsWithPromptCacheKeyForTest({
      providerNpm: "@ai-sdk/openai",
      sessionId: "sess_123",
      providerOptions: { promptCacheKey: undefined, other: true }
    }),
    { promptCacheKey: "awb:sess_123", other: true }
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
  stubListedTools(runner, ["bash", "subtask", "read"]);

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
      workspacePath: process.cwd(),
      workspaceRepoDirNames: []
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
  stubListedTools(runner, ["bash", "subtask", "read"]);

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
      workspacePath: process.cwd(),
      workspaceRepoDirNames: []
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

test("中间工具仍会打断并发段", async () => {
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
  stubListedTools(runner, ["bash"]);

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
      workspacePath: process.cwd(),
      workspaceRepoDirNames: []
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
    "start:1:bash",
    "done:1",
    "start:2:read",
    "done:2",
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
  stubListedTools(runner, ["read", "write", "apply_patch"]);

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
      workspacePath: process.cwd(),
      workspaceRepoDirNames: []
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

test("executePendingTools 传入快照时复用 availableToolNames 且不重复 listTools", async () => {
  const updates: Array<{ itemId: number; status?: string }> = [];
  const runner = new AgentRunner(
    {
      async updateContextItem(input: { itemId: number; status?: string }) {
        updates.push({ itemId: input.itemId, status: input.status });
        return { id: input.itemId };
      },
      async updateRunState() {
        return;
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  let listToolsCallCount = 0;
  let receivedAvailableToolNames: ReadonlySet<string> | undefined;
  (runner as any).toolRegistry.listTools = async () => {
    listToolsCallCount += 1;
    return [
      {
        name: "write",
        description: "fixture write",
        inputSchema: { type: "object", properties: {} },
        source: "builtin"
      }
    ];
  };
  (runner as any).toolRegistry.isToolEnabled = async (_toolName: string, ctx: { availableToolNames?: ReadonlySet<string> }) => {
    receivedAvailableToolNames = ctx.availableToolNames;
    return true;
  };
  (runner as any).executeTool = async () => ({ paused: false as const });

  const snapshot = new Set<string>(["read"]);
  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["read"]
      }
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: process.cwd(),
      workspaceRepoDirNames: []
    },
    availableToolNames: snapshot,
    context: {
      pendingTools: [pendingTool({ itemId: 1, toolName: "read" })]
    },
    signal: new AbortController().signal
  });

  assert.equal(result.paused, false);
  assert.equal(listToolsCallCount, 0);
  assert.equal(receivedAvailableToolNames, snapshot);
  assert.deepEqual(updates, []);
});

test("executePendingTools 快照缺失时回退到当前 listTools", async () => {
  const runner = new AgentRunner(
    {
      async updateContextItem() {
        return { id: 1 };
      },
      async updateRunState() {
        return;
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  let listToolsCallCount = 0;
  let receivedAvailableToolNames: ReadonlySet<string> | undefined;
  (runner as any).toolRegistry.listTools = async () => {
    listToolsCallCount += 1;
    return [
      {
        name: "read",
        description: "fixture read",
        inputSchema: { type: "object", properties: {} },
        source: "builtin"
      }
    ];
  };
  (runner as any).toolRegistry.isToolEnabled = async (_toolName: string, ctx: { availableToolNames?: ReadonlySet<string> }) => {
    receivedAvailableToolNames = ctx.availableToolNames;
    return true;
  };
  (runner as any).executeTool = async () => ({ paused: false as const });

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["read"]
      }
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: process.cwd(),
      workspaceRepoDirNames: []
    },
    context: {
      pendingTools: [pendingTool({ itemId: 1, toolName: "read" })]
    },
    signal: new AbortController().signal
  });

  assert.equal(result.paused, false);
  assert.equal(listToolsCallCount, 1);
  assert.ok(receivedAvailableToolNames);
  assert.equal(receivedAvailableToolNames?.has("read"), true);
});

test("executePendingTools 传入快照时未知工具仍按失败处理且不回退 listTools", async () => {
  const updates: Array<{ itemId: number; status?: string; output?: unknown }> = [];
  const runner = new AgentRunner(
    {
      async updateContextItem(input: { itemId: number; status?: string; output?: unknown }) {
        updates.push(input);
        return { id: input.itemId };
      },
      async updateRunState() {
        return;
      }
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1
  );

  let listToolsCallCount = 0;
  (runner as any).toolRegistry.listTools = async () => {
    listToolsCallCount += 1;
    return [];
  };
  (runner as any).executeTool = async () => ({ paused: false as const });

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["read"],
        pluginTools: [],
        mcpServers: []
      }
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: process.cwd(),
      workspaceRepoDirNames: []
    },
    availableToolNames: new Set<string>(["read"]),
    context: {
      pendingTools: [pendingTool({ itemId: 1, toolName: "unknown_tool" })]
    },
    signal: new AbortController().signal
  });

  assert.equal(result.paused, false);
  assert.equal(listToolsCallCount, 0);
  assert.equal(updates.some((item) => item.itemId === 1 && item.status === "failed"), true);
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
    stubListedTools(runner, [toolName]);

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
        workspacePath: process.cwd(),
      workspaceRepoDirNames: []
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

test("启用错误落盘后 Provider reject 记录 tool artifact 的 args 和 error", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import fs from "node:fs/promises";
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      const updates = [];
      const api = { updateContextItem: async (input) => { updates.push(input); return { id: input.itemId, ...input }; } };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { throw Object.assign(new Error("provider fixture failure"), { diagnostic: { raw: "preserved" } }); };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { itemId: 7, status: "queued", toolName: "bash", toolCallId: "call_provider", args: { command: "fixture command", sensitiveNamedButModelVisible: "preserved" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
      console.log(JSON.stringify(updates));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: repositoryRoot,
      env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" }
    });
    assert.equal(JSON.parse(stdout.trim()).at(-1).status, "failed");
    const dir = path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "session", "run");
    const files = await fs.readdir(dir);
    assert.equal(files.some((file) => file === "7-call_provider.tool.json"), true);
    const artifact = JSON.parse(await fs.readFile(path.join(dir, "7-call_provider.tool.json"), "utf8"));
    assert.equal(artifact.failureKind, "tool");
    assert.deepEqual(artifact.events.map((event: any) => event.stage), ["provider_execute_rejected"]);
    assert.equal(artifact.execution.resultAvailability, "not_returned");
    assert.equal(artifact.execution.providerStarted, true);
    assert.deepEqual(artifact.writebacks.map((writeback: any) => [writeback.role, writeback.outcome]), [
      ["initial_running", "succeeded"],
      ["inner_failed", "succeeded"]
    ]);
    assert.equal(graphContainsString(artifact.tool.args, "fixture command"), true);
    assert.equal(graphContainsString(artifact.errors[0].value, "provider fixture failure"), true);
  });
});

test("启用错误落盘后 completed writeback 失败保留 provider result 和候选 output", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import fs from "node:fs/promises";
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      let count = 0;
      const api = { updateContextItem: async (input) => { count += 1; if (input.status === "completed") throw new Error("completed writeback failed"); return { id: input.itemId, ...input }; } };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => ({ stdout: "complete provider result", nested: { value: 42 } });
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { itemId: 8, status: "queued", toolName: "bash", toolCallId: "call_completed", args: { command: "complete fixture" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
      console.log(count);
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    const dir = path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "session", "run");
    const artifact = JSON.parse(await fs.readFile(path.join(dir, "8-call_completed.runtime.json"), "utf8"));
    assert.equal(artifact.failureKind, "runtime");
    assert.equal(artifact.execution.resultAvailability, "returned");
    assert.equal(artifact.execution.providerStarted, true);
    assert.equal(graphContainsString(artifact.execution.result, "complete provider result"), true);
    assert.deepEqual(artifact.events.map((event: any) => event.stage), ["completed_writeback_failed"]);
    assert.deepEqual(artifact.writebacks.map((writeback: any) => [writeback.role, writeback.outcome]), [
      ["initial_running", "succeeded"],
      ["completed", "failed"],
      ["inner_failed", "succeeded"]
    ]);
    assert.equal(graphContainsString(artifact.writebacks[1].output, "complete provider result"), true);
  });
});

test("启用错误落盘后 subtask 失败会记录 partial result", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      const api = { updateContextItem: async (input) => ({ id: input.itemId, ...input }) };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { const error = new Error("subtask fixture failure"); error.subtaskSessionId = "child-1"; error.subtaskResultText = "partial child text"; throw error; };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["subtask"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { itemId: 9, status: "queued", toolName: "subtask", toolCallId: "call_subtask", args: { prompt: "fixture" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    const artifact = JSON.parse(await fs.readFile(path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "session", "run", "9-call_subtask.tool.json"), "utf8"));
    assert.equal(artifact.failureKind, "tool");
    assert.equal(artifact.execution.resultAvailability, "partial_from_error");
    assert.deepEqual(artifact.events.map((event: any) => event.stage), ["provider_execute_rejected", "provider_partial_result"]);
    assert.deepEqual(artifact.writebacks.map((writeback: any) => [writeback.role, writeback.outcome]), [
      ["initial_running", "succeeded"],
      ["inner_failed", "succeeded"]
    ]);
    assert.equal(graphContainsString(artifact.execution.partialResults[0].value, "child-1"), true);
    assert.equal(graphContainsString(artifact.execution.partialResults[0].value, "partial child text"), true);
  });
});

test("启用错误落盘时 store 失败只 warning，不改变失败状态机", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const blocked = path.join(workspacePath, ".awb");
    await fs.writeFile(blocked, "not a directory");
    const script = `
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      const updates = [];
      const logger = { info() {}, error() {}, warn(message) { console.error("WARN:" + message); } };
      const api = { updateContextItem: async (input) => { updates.push(input); return { id: input.itemId, ...input }; } };
      const runner = new AgentRunner(api, {}, logger, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { throw new Error("provider failure with blocked store"); };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { itemId: 10, status: "queued", toolName: "bash", toolCallId: "call_store_fail", args: {} }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
      console.log(JSON.stringify(updates));
    `;
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    assert.equal(JSON.parse(stdout.trim()).at(-1).status, "failed");
    assert.equal(stderr.includes("[tool-error-store]"), true);
  });
});

test("启用错误落盘后 pending 快照预检禁用记录 policy artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const api = {
        updateContextItem: async (input) => ({ id: input.itemId, ...input }),
        updateRunState: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => false;
      await runner.executePendingTools({
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
        context: { pendingTools: [{ itemId: 11, status: "queued", toolName: "bash", toolCallId: "call_pending_policy", args: { command: "policy fixture" } }], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
        availableToolNames: new Set(["bash"]),
        signal: new AbortController().signal
      });
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    const artifact = JSON.parse(await fs.readFile(path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "session", "run", "11-call_pending_policy.policy.json"), "utf8"));
    assert.equal(artifact.failureKind, "policy");
    assert.equal(artifact.execution.resultAvailability, "not_started");
    assert.deepEqual(artifact.events.map((event: any) => event.stage), ["tool_disabled_pending_precheck"]);
    assert.deepEqual(artifact.writebacks.map((writeback: any) => [writeback.role, writeback.outcome]), [["policy_failed", "succeeded"]]);
    assert.equal(graphContainsString(artifact.tool.args, "policy fixture"), true);
  });
});

test("启用错误落盘后 executeTool 二次禁用检查记录独立 policy stage", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      const api = { updateContextItem: async (input) => ({ id: input.itemId, ...input }) };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => false;
      runner.toolRegistry.execute = async () => { throw new Error("must not execute"); };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { itemId: 12, status: "queued", toolName: "bash", toolCallId: "call_execute_policy", args: { command: "second policy fixture" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    const artifact = JSON.parse(await fs.readFile(path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "session", "run", "12-call_execute_policy.policy.json"), "utf8"));
    assert.equal(artifact.failureKind, "policy");
    assert.equal(artifact.execution.resultAvailability, "not_started");
    assert.deepEqual(artifact.events.map((event: any) => event.stage), ["tool_disabled_execute_check"]);
    assert.deepEqual(artifact.writebacks.map((writeback: any) => [writeback.role, writeback.outcome]), [["policy_failed", "succeeded"]]);
  });
});

test("启用错误落盘后遗留 running 工具记录 recovery artifact 且不重放", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const api = {
        updateContextItem: async (input) => ({ id: input.itemId, ...input }),
        updateRunState: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { throw new Error("must not execute"); };
      await runner.executePendingTools({
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
        context: { pendingTools: [{ itemId: 13, status: "running", toolName: "bash", toolCallId: "call_recovery", args: { command: "recovery fixture" } }], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
        availableToolNames: new Set(["bash"]),
        signal: new AbortController().signal
      });
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    const artifact = JSON.parse(await fs.readFile(path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "session", "run", "13-call_recovery.recovery.json"), "utf8"));
    assert.equal(artifact.failureKind, "recovery");
    assert.equal(artifact.execution.resultAvailability, "not_started");
    assert.deepEqual(artifact.events.map((event: any) => event.stage), ["running_item_recovered_as_failed"]);
    assert.deepEqual(artifact.writebacks.map((writeback: any) => [writeback.role, writeback.outcome]), [["recovery_failed", "succeeded"]]);
    assert.equal(graphContainsString(artifact.tool.args, "recovery fixture"), true);
  });
});

test("启用错误落盘时 Abort 不会发布 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      const api = { updateContextItem: async (input) => ({ id: input.itemId, ...input }) };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { throw new DOMException("cancelled", "AbortError"); };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { itemId: 14, status: "queued", toolName: "bash", toolCallId: "call_abort", args: { command: "abort fixture" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headItemId: null, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
    `;
    await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repositoryRoot, env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" } });
    await assert.rejects(fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")));
  });
});
