import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after } from "node:test";
import {
  AgentRunner,
  buildProviderOptionsWithPromptCacheKeyForTest,
  buildToolExecutionBatchesForTest,
  executeToolForTest,
  finalizeToolTextForTest,
  warnToolErrorStoreFailureForTest,
  hasValidPromptCacheKeyForTest,
} from "./runner.js";
import { getBashToolAppendix, startBashToolProbe } from "./bashTools.js";
import { runReadTool } from "./fileTools.js";
import { InternalRpcHttpError } from "./apiClient.js";

const execFileAsync = promisify(execFile);
const runnerModuleUrl = new URL("./runner.ts", import.meta.url).href;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
// 部分 executePendingTools 场景故意触发 policy/runtime 错误。即使调用者将
// AWB_TOOL_ERROR_STORE_ENABLED=1 注入测试进程，也只能落到此临时 Workspace，
// 不得在仓库根创建 .awb 副产物。
const isolatedExecutionWorkspacePath = await fs.mkdtemp(
  path.join(os.tmpdir(), "awb-runner-execution-test-"),
);
after(async () => {
  await fs.rm(isolatedExecutionWorkspacePath, { recursive: true, force: true });
});

function encodedNodeValues(graph: any) {
  return Object.values(graph.nodes ?? {}) as Array<any>;
}

function graphContainsString(snapshot: any, expected: string) {
  return (
    encodedNodeValues(snapshot.graph).some((node) =>
      JSON.stringify(node).includes(JSON.stringify(expected)),
    ) || JSON.stringify(snapshot.graph.root).includes(JSON.stringify(expected))
  );
}

function pendingTool(input: {
  executionId: string;
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
}) {
  return {
    toolExecutionId: input.executionId,
    callPartId: `part_${input.executionId}`,
    assistantMessageId: `message_${input.executionId}`,
    status: "queued" as const,
    toolName: input.toolName,
    toolCallId: input.toolCallId ?? `call_${input.executionId}`,
    args: input.args ?? {},
  };
}

function stubListedTools(runner: AgentRunner, names: string[]) {
  (runner as any).toolRegistry.listTools = async () =>
    names.map((name) => ({
      name,
      description: `fixture ${name}`,
      inputSchema: { type: "object", properties: {} },
      source: name.startsWith("plugin_")
        ? "plugin"
        : name.startsWith("mcp_")
          ? "mcp"
          : "builtin",
    }));
}

async function withTempWorkspace(fn: (workspacePath: string) => Promise<void>) {
  const workspacePath = await fs.mkdtemp(
    path.join(os.tmpdir(), "awb-runner-tool-output-"),
  );
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
      pluginTools: [],
    },
  };
}

function testRun(workspacePath: string) {
  return {
    workspaceId: "ws_baseline",
    sessionId: "sess_baseline",
    runId: "run_baseline",
    workspacePath,
    workspaceRepoDirNames: [],
  };
}

function testPromptContext() {
  return {
    pendingTools: [],
    tools: [],
    headMessageId: null,
    sessionRevision: 0,
    system: "",
    messages: [],
    lastResponseTotalTokens: null,
    uiLocale: null,
    externalSkillRoots: [],
  };
}

function latestUpdate(
  updates: Array<{
    toolExecutionId?: string;
    status?: string;
    resultPreview?: string;
    structuredResult?: unknown;
    error?: string;
    resultTruncated?: boolean;
    resultArtifactPath?: string;
  }>,
  status: string,
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
      {
        info() {},
        warn(message) {
          warnings.push(message);
        },
        error() {},
      },
      1,
      { warningNowMs: () => warningNow },
    );
    const input = {
      workspacePath,
      relativePath:
        ".awb/agent/tool-errors/by_run/session/run/execution-1-call.tool.json",
      operation: "publish_link",
      error: Object.assign(new Error("filesystem failure"), {
        code: "eio",
        artifactPayload: { events: ["must not log"] },
      }),
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
    assert.equal(
      warnings[1]?.includes("\n") || warnings[1]?.includes("\r"),
      false,
    );
    assert.equal((warnings[1] ?? "").length <= 512, true);
  });
});

test("bash tool appendix uses English labels", async () => {
  startBashToolProbe({ warn() {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const appendix = getBashToolAppendix();
  if (!appendix) return;
  assert.equal(
    appendix.includes("Known available tools:") ||
      appendix.includes("Runtime environment:"),
    true,
  );
  assert.equal(appendix.includes("已知可用工具:"), false);
  assert.equal(appendix.includes("运行环境:"), false);
});

test("subtask 长输出不截断且不生成 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const longText = "S".repeat(9_500);
    const output = await finalizeToolTextForTest({
      workspacePath,
      toolExecutionId: "execution-1",
      toolName: "subtask",
      text: longText,
    });

    assert.equal(output.text, longText);
    assert.equal(output.textTruncated, false);
    assert.equal(output.textArtifactPath, undefined);
    await assert.rejects(
      fs.access(
        path.join(workspacePath, ".awb", "agent", "artifacts", "by_tool_execution", "execution-1.txt"),
      ),
    );
  });
});

test("read 的 repo 路径提示错误仍以 failed 工具项持久化且没有 result", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      status?: string;
      output?: Record<string, unknown>;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const runner = new AgentRunner(
      {
        async updateToolExecution(input: {
          status?: string;
          output?: Record<string, unknown>;
          resultPreview?: string;
          structuredResult?: unknown;
          error?: string;
          resultTruncated?: boolean;
          resultArtifactPath?: string;
        }) {
          updates.push(input);
          return { id: 1 };
        },
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    await fs.mkdir(path.join(workspacePath, "repo-a", "src"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspacePath, "repo-a", "src", "a.ts"),
      "export {};",
      "utf8",
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return true;
      },
      async execute(
        _toolName: string,
        args: { filePath: string },
        context: {
          run: { workspacePath: string; workspaceRepoDirNames: string[] };
        },
      ) {
        return await runReadTool({
          workspacePath: context.run.workspacePath,
          workspaceRepoDirNames: context.run.workspaceRepoDirNames,
          filePath: args.filePath,
        });
      },
    };

    await executeToolForTest(runner, {
      profile: { agent: { tools: ["read"], pluginTools: [] } },
      run: {
        workspaceId: "ws_test",
        sessionId: "sess_test",
        runId: "run_test",
        workspacePath,
        workspaceRepoDirNames: ["repo-a"],
      },
      tool: pendingTool({
        executionId: "execution-901",
        toolName: "read",
        args: { filePath: "src/a.ts" },
      }),
      parentSessionId: "sess_test",
      signal: new AbortController().signal,
      promptContext: { tools: [] },
    });

    let failed:
      | {
          status?: string;
          output?: Record<string, unknown>;
          resultPreview?: string;
          structuredResult?: unknown;
          error?: string;
          resultTruncated?: boolean;
          resultArtifactPath?: string;
        }
      | undefined;
    for (let index = updates.length - 1; index >= 0; index -= 1) {
      if (updates[index]?.status === "failed") {
        failed = updates[index];
        break;
      }
    }
    assert.ok(failed, "read error should persist a failed tool item");
    const error = String(failed.error || "");
    const hint =
      "Path exists in registered workspace repo(s). Retry read with one of:\n- repo-a/src/a.ts";
    assert.match(error, /^ENOENT: no such file or directory, path: src\/a\.ts/);
    assert.equal(error.includes(workspacePath), false);
    assert.equal(error.endsWith(`\n\n${hint}`), true);
    assert.equal(typeof failed.resultPreview, "string");
    assert.equal((failed.resultPreview as string).includes("tool: read"), true);
    assert.equal(
      (failed.resultPreview as string).includes("status: failed"),
      true,
    );
    assert.equal((failed.resultPreview as string).includes(error), true);
    assert.equal(
      (failed.resultPreview as string).includes(workspacePath),
      false,
    );
    assert.equal(failed.structuredResult, undefined);
  });
});

test("普通 Provider reject 会保留 failed output 的调用身份、参数、文本和错误", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      toolExecutionId?: string;
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const runner = new AgentRunner(
      {
        async updateToolExecution(input: {
          toolExecutionId?: string;
          status?: string;
          resultPreview?: string;
          structuredResult?: unknown;
          error?: string;
          resultTruncated?: boolean;
          resultArtifactPath?: string;
        }) {
          updates.push(input);
          return { result: "updated" };
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
        throw new Error("fixture provider rejected");
      },
    };
    const tool = pendingTool({
      executionId: "execution-1101",
      toolName: "bash",
      toolCallId: "call_provider_rejected",
      args: { command: "echo fixture", timeout: 3 },
    });

    const result = await executeToolForTest(runner, {
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      tool,
      parentSessionId: "sess_baseline",
      signal: new AbortController().signal,
      promptContext: testPromptContext(),
    });

    assert.deepEqual(result, { paused: false });
    const failed = latestUpdate(updates, "failed");
    assert.ok(failed);
    assert.equal(failed.toolExecutionId, tool.toolExecutionId);
    assert.equal(failed.error, "fixture provider rejected");
    assert.equal(
      failed.resultPreview,
      "tool: bash\nstatus: failed\n\nfixture provider rejected",
    );
    assert.equal(failed.structuredResult, undefined);
    await assert.rejects(
      fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")),
    );
  });
});

test("subtask existing 会话缺失会为模型和用户持久化可行动的业务错误", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      toolExecutionId?: string;
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const runner = new AgentRunner(
      {
        async updateToolExecution(input: {
          toolExecutionId?: string;
          status?: string;
          resultPreview?: string;
          structuredResult?: unknown;
          error?: string;
          resultTruncated?: boolean;
          resultArtifactPath?: string;
        }) {
          updates.push(input);
          return { result: "updated" };
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
        executionId: "execution-1104",
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
    const error = String(failed.error || "");
    assert.match(error, /指定的 existing 子任务会话不存在或已失效/);
    assert.match(error, /session\.mode="new" 或 "fork"/);
    assert.match(error, /AGENT_SUBTASK_SESSION_NOT_FOUND/);
    assert.match(error, /HTTP 状态：404/);
    assert.equal(
      failed.resultPreview,
      `tool: subtask\nstatus: failed\n\n${error}`,
    );
    assert.equal(error.includes("internal rpc failed:"), false);
  });
});

test("pending 预检禁用 writeback 期间取消时不发布 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const controller = new AbortController();
      const api = {
        updateToolExecution: async (input) => { controller.abort(); return { result: "updated", ...input }; },
        updateRunNotice: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => false;
      await runner.executePendingTools({
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
        context: { pendingTools: [{ toolExecutionId: "execution-15", callPartId: "part-15", assistantMessageId: "message-15", status: "queued", toolName: "bash", toolCallId: "call_policy_abort", args: {} }], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
        availableToolNames: new Set(["bash"]), signal: controller.signal
      });
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    await assert.rejects(
      fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")),
    );
  });
});

test("running recovery writeback 期间取消时不发布 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const controller = new AbortController();
      const api = {
        updateToolExecution: async (input) => { controller.abort(); return { result: "updated", ...input }; },
        updateRunNotice: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      await runner.executePendingTools({
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
        context: { pendingTools: [{ toolExecutionId: "execution-16", callPartId: "part-16", assistantMessageId: "message-16", status: "running", toolName: "bash", toolCallId: "call_recovery_abort", args: {} }], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
        availableToolNames: new Set(["bash"]), signal: controller.signal
      });
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    await assert.rejects(
      fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")),
    );
  });
});

test("pending 预检禁用 failed writeback 失败时额外发布 runtime artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const api = {
        updateToolExecution: async () => { throw new Error("policy writeback rejected"); },
        updateRunNotice: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => false;
      try {
        await runner.executePendingTools({
          profile: { agent: { tools: ["bash"], pluginTools: [] } },
          run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
          context: { pendingTools: [{ toolExecutionId: "execution-17", callPartId: "part-17", assistantMessageId: "message-17", status: "queued", toolName: "bash", toolCallId: "call_policy_writeback", args: {} }], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
          availableToolNames: new Set(["bash"]), signal: new AbortController().signal
        });
      } catch {}
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    const dir = path.join(
      workspacePath,
      ".awb",
      "agent",
      "tool-errors",
      "by_run",
      "session",
      "run",
    );
    const policyArtifact = JSON.parse(
      await fs.readFile(
        path.join(dir, "execution-17-call_policy_writeback.policy.json"),
        "utf8",
      ),
    );
    const runtimeArtifact = JSON.parse(
      await fs.readFile(
        path.join(dir, "execution-17-call_policy_writeback.runtime.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      policyArtifact.events.map((event: any) => event.stage),
      ["tool_disabled_pending_precheck"],
    );
    assert.equal(runtimeArtifact.failureKind, "runtime");
    assert.deepEqual(
      runtimeArtifact.events.map((event: any) => event.stage),
      ["failed_writeback_failed"],
    );
    assert.deepEqual(
      runtimeArtifact.writebacks.map((writeback: any) => [
        writeback.role,
        writeback.outcome,
      ]),
      [["policy_failed", "failed"]],
    );
  });
});

test("running ToolExecution 不由 Worker 恢复执行、写回或发布 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      let writes = 0;
      const api = {
        updateToolExecution: async () => { writes += 1; return { result: "updated" }; },
        updateRunNotice: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      await runner.executePendingTools({
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
        context: { pendingTools: [{ toolExecutionId: "execution-18", callPartId: "part-18", assistantMessageId: "message-18", status: "running", toolName: "bash", toolCallId: "call_recovery_writeback", args: {} }], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
        availableToolNames: new Set(["bash"]), signal: new AbortController().signal
      });
      if (writes !== 0) throw new Error(\`unexpected writes: \${writes}\`);
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    await assert.rejects(fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")));
  });
});

test("executeTool 内二次禁用检查会写 failed 且不会调用 Provider", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      status?: string;
      output?: Record<string, unknown>;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    let executeCount = 0;
    const runner = new AgentRunner(
      {
        async updateToolExecution(input: {
          status?: string;
          output?: Record<string, unknown>;
          resultPreview?: string;
          structuredResult?: unknown;
          error?: string;
          resultTruncated?: boolean;
          resultArtifactPath?: string;
        }) {
          updates.push(input);
          return { id: 1102 };
        },
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return false;
      },
      async execute() {
        executeCount += 1;
        return { ignored: true };
      },
    };

    await executeToolForTest(runner, {
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      tool: pendingTool({
        executionId: "execution-1102",
        toolName: "bash",
        toolCallId: "call_execute_disabled",
        args: { command: "echo no" },
      }),
      parentSessionId: "sess_baseline",
      signal: new AbortController().signal,
      promptContext: testPromptContext(),
    });

    assert.equal(executeCount, 0);
    assert.deepEqual(
      updates.map((item) => item.status),
      ["failed"],
    );
    assert.equal(updates[0]?.error, "tool is disabled for current agent: bash");
    assert.equal(
      updates[0]?.resultPreview,
      "tool: bash\nstatus: failed\n\ntool is disabled for current agent: bash",
    );
  });
});

test("executePendingTools 的快照预检禁用会写 failed 且不会调度 executeTool", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      toolExecutionId?: string;
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    let executeToolCount = 0;
    const runner = new AgentRunner(
      {
        async updateToolExecution(input: {
          toolExecutionId?: string;
          status?: string;
          resultPreview?: string;
          structuredResult?: unknown;
          error?: string;
          resultTruncated?: boolean;
          resultArtifactPath?: string;
        }) {
          updates.push(input);
          return { result: "updated" };
        },
        async updateRunNotice() {
          return;
        },
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    (runner as any).toolRegistry = {
      async isToolEnabled() {
        return false;
      },
    };
    (runner as any).executeTool = async () => {
      executeToolCount += 1;
      return { paused: false as const };
    };

    const result = await (runner as any).executePendingTools({
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      context: {
        ...testPromptContext(),
        pendingTools: [
          pendingTool({
            executionId: "execution-1103",
            toolName: "bash",
            toolCallId: "call_pending_disabled",
            args: { command: "echo no" },
          }),
        ],
      },
      availableToolNames: new Set(["bash"]),
      signal: new AbortController().signal,
    });

    assert.deepEqual(result, { paused: false });
    assert.equal(executeToolCount, 0);
    const failed = latestUpdate(updates, "failed");
    assert.ok(failed);
    assert.equal(failed.error, "tool is disabled for current agent: bash");
    assert.equal(
      failed.resultPreview,
      "tool: bash\nstatus: failed\n\ntool is disabled for current agent: bash",
    );
  });
});

test("executePendingTools 忽略遗留 running 工具，不重放也不伪造失败", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      toolExecutionId?: string;
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    let executeToolCount = 0;
    const runner = new AgentRunner(
      {
        async updateToolExecution(input: {
          toolExecutionId?: string;
          status?: string;
          resultPreview?: string;
          structuredResult?: unknown;
          error?: string;
          resultTruncated?: boolean;
          resultArtifactPath?: string;
        }) {
          updates.push(input);
          return { result: "updated" };
        },
        async updateRunNotice() {
          return;
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
    };
    (runner as any).executeTool = async () => {
      executeToolCount += 1;
      return { paused: false as const };
    };

    const tool = {
      ...pendingTool({
        executionId: "execution-1104",
        toolName: "bash",
        toolCallId: "call_recovery",
        args: { command: "echo interrupted" },
      }),
      status: "running" as const,
    };
    const result = await (runner as any).executePendingTools({
      profile: testProfile("bash"),
      run: testRun(workspacePath),
      context: { ...testPromptContext(), pendingTools: [tool] },
      availableToolNames: new Set(["bash"]),
      signal: new AbortController().signal,
    });

    assert.deepEqual(result, { paused: false });
    assert.equal(executeToolCount, 0);
    assert.equal(updates.length, 0);
  });
});

for (const toolName of ["read", "bash", "plugin_fixture"] as const) test(`普通工具 ${toolName} completed writeback 不保留 structuredResult`, async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      status?: string;
      output?: Record<string, unknown>;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const providerResult = { stdout: "fixture output", exitCode: 0 };
    const runner = new AgentRunner(
      {
        async updateToolExecution(input: {
          status?: string;
          output?: Record<string, unknown>;
          resultPreview?: string;
          structuredResult?: unknown;
          error?: string;
          resultTruncated?: boolean;
          resultArtifactPath?: string;
        }) {
          updates.push(input);
          return { id: 1105 };
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
        return providerResult;
      },
    };
    const tool = pendingTool({
      executionId: "execution-1105",
      toolName,
      toolCallId: "call_provider_fulfilled",
      args: { command: "echo fixture" },
    });

    await executeToolForTest(runner, {
      profile: testProfile(toolName),
      run: testRun(workspacePath),
      tool,
      parentSessionId: "sess_baseline",
      signal: new AbortController().signal,
      promptContext: testPromptContext(),
    });

    const completed = latestUpdate(updates, "completed");
    assert.ok(completed);
    assert.equal(completed.toolExecutionId, tool.toolExecutionId);
    assert.equal(completed.structuredResult, undefined);
    assert.match(completed.resultPreview ?? "", new RegExp(`^tool: ${toolName}\\nstatus: completed`));
    assert.match(completed.resultPreview ?? "", /fixture output/);
  });
});

for (const toolName of ["apply_patch", "todolist", "subtask", "write", "scratchpad"] as const) test(`白名单工具 ${toolName} completed writeback 保留 structuredResult`, async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ status?: string; structuredResult?: unknown }> = [];
    const providerResult = { toolName, marker: true };
    const runner = new AgentRunner({
      async updateToolExecution(input: { status?: string; structuredResult?: unknown }) {
        updates.push(input);
        return { result: "updated" };
      },
    } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).toolRegistry = {
      async isToolEnabled() { return true; },
      async execute() { return providerResult; },
    };
    const tool = pendingTool({ executionId: `execution-${toolName}`, toolName, toolCallId: `call_${toolName}` });

    await executeToolForTest(runner, {
      profile: testProfile(toolName), run: testRun(workspacePath), tool,
      parentSessionId: "sess_baseline", signal: new AbortController().signal,
      promptContext: testPromptContext(),
    });

    assert.deepEqual(latestUpdate(updates, "completed")?.structuredResult, providerResult);
  });
});

test("completed writeback 永久失败会停止工具流程，不继续写 failed", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{ status?: string }> = [];
    const runner = new AgentRunner({
      async updateToolExecution(input: { status?: string }) {
        updates.push(input);
        if (input.status === "completed") throw new Error("fixture completed writeback rejected");
        return { id: 1106 };
      },
    } as any, {} as any, { info() {}, warn() {}, error() {} }, 1);
    (runner as any).toolRegistry = {
      async isToolEnabled() { return true; },
      async execute() { return { stdout: "L".repeat(9_000) }; },
    };

    await assert.rejects(
      (runner as any).executeToolSafely({
        profile: testProfile("bash"), run: testRun(workspacePath),
        tool: pendingTool({ executionId: "execution-1106", toolName: "bash", toolCallId: "call_completed_writeback_rejected", args: { command: "echo fixture" } }),
        parentSessionId: "sess_baseline", signal: new AbortController().signal, promptContext: testPromptContext(),
      }),
      /control write permanently failed: tool execution completed/
    );
    assert.deepEqual(updates.map((item) => item.status), ["running", "completed"]);
    const artifactPath = path.join(workspacePath, ".awb", "agent", "artifacts", "by_tool_execution", "execution-1106.txt");
    assert.equal((await fs.readFile(artifactPath, "utf8")).length > 8_000, true);
  });
});

test("启用既有 Debug Dump 时失败仍只写 .debug，不生成未实现的 tool-errors 目录", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner, executeToolForTest } from ${JSON.stringify(runnerModuleUrl)};
      const workspacePath = process.env.AWB_TEST_WORKSPACE;
      const runner = new AgentRunner(
        { async updateToolExecution() { return { result: "updated" }; } },
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
          toolExecutionId: "execution-1107",
          status: "queued",
          toolName: "bash",
          toolCallId: "call_debug_dump",
          args: { command: "echo fixture" }
        },
        parentSessionId: "sess_debug",
        signal: new AbortController().signal,
        promptContext: { pendingTools: [], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] }
      });
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AWB_AGENT_DEBUG_DUMP: "1",
          AWB_TEST_WORKSPACE: workspacePath,
        },
      },
    );

    const debugLog = await fs.readFile(
      path.join(
        workspacePath,
        ".debug",
        "agent_message_logs",
        "tool",
        "execution-1107.log",
      ),
      "utf8",
    );
    assert.match(debugLog, /fixture debug dump reject/);
    await assert.rejects(
      fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")),
    );
  });
});

test("非 subtask 长输出仍截断并写入 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const longText = "B".repeat(9_500);
    const output = await finalizeToolTextForTest({
      workspacePath,
      toolExecutionId: "execution-2",
      toolName: "bash",
      text: longText,
    });

    assert.equal(output.textTruncated, true);
    assert.equal(output.text.includes("[truncated]"), true);
    assert.equal(
      output.textArtifactPath,
      ".awb/agent/artifacts/by_tool_execution/execution-2.txt",
    );
    assert.equal(
      await fs.readFile(
        path.join(workspacePath, output.textArtifactPath),
        "utf8",
      ),
      longText,
    );
  });
});

test("普通工具按 8k/3k/200k 规则截断，并按 execution ID 幂等重写", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const small = await finalizeToolTextForTest({
      workspacePath, toolExecutionId: "execution-small", toolName: "bash", text: "S".repeat(8_000),
    });
    assert.equal(small.textTruncated, false);
    assert.equal(small.text.length, 8_000);

    const first = await finalizeToolTextForTest({
      workspacePath, toolExecutionId: "execution-rewrite", toolName: "bash", text: "A".repeat(8_001),
    });
    assert.equal(first.textTruncated, true);
    assert.equal(first.text.startsWith("A".repeat(3_000)), true);
    assert.equal(first.textArtifactPath, ".awb/agent/artifacts/by_tool_execution/execution-rewrite.txt");
    await finalizeToolTextForTest({
      workspacePath, toolExecutionId: "execution-rewrite", toolName: "bash", text: "R".repeat(8_001),
    });
    assert.equal(await fs.readFile(path.join(workspacePath, first.textArtifactPath!), "utf8"), "R".repeat(8_001));

    const oversized = await finalizeToolTextForTest({
      workspacePath, toolExecutionId: "execution-large", toolName: "bash", text: "L".repeat(200_001),
    });
    const artifact = await fs.readFile(path.join(workspacePath, oversized.textArtifactPath!), "utf8");
    assert.equal(artifact.startsWith("L".repeat(200_000)), true);
    assert.equal(artifact.endsWith("\n\n[truncated]"), true);
  });
});

test("artifact 拒绝非法 execution ID 及父目录、目标符号链接", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await assert.rejects(finalizeToolTextForTest({
      workspacePath, toolExecutionId: "../outside", toolName: "bash", text: "X".repeat(8_001),
    }), /invalid tool execution id/);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-artifact-outside-"));
    try {
      await fs.mkdir(path.join(workspacePath, ".awb", "agent", "artifacts"), { recursive: true });
      await fs.symlink(outside, path.join(workspacePath, ".awb", "agent", "artifacts", "by_tool_execution"));
      await assert.rejects(finalizeToolTextForTest({
        workspacePath, toolExecutionId: "execution-parent-link", toolName: "bash", text: "X".repeat(8_001),
      }), /symlink/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
  await withTempWorkspace(async (workspacePath) => {
    const artifactDir = path.join(workspacePath, ".awb", "agent", "artifacts", "by_tool_execution");
    await fs.mkdir(artifactDir, { recursive: true });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-artifact-target-"));
    try {
      await fs.symlink(path.join(outside, "target.txt"), path.join(artifactDir, "execution-target-link.txt"));
      await assert.rejects(finalizeToolTextForTest({
        workspacePath, toolExecutionId: "execution-target-link", toolName: "bash", text: "X".repeat(8_001),
      }), /target symlink/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("artifact 提交前目标被替换为外部 symlink 时不跟随并安全覆盖链接本身", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  await withTempWorkspace(async (workspacePath) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-artifact-race-target-"));
    const outsideTarget = path.join(outside, "outside.txt");
    await fs.writeFile(outsideTarget, "outside-original", "utf8");
    const artifactDir = path.join(workspacePath, ".awb", "agent", "artifacts", "by_tool_execution");
    try {
      const output = await finalizeToolTextForTest({
        workspacePath,
        toolExecutionId: "execution-race-target",
        toolName: "bash",
        text: "X".repeat(8_001),
        async beforeArtifactCommit() {
          await fs.symlink(outsideTarget, path.join(artifactDir, "execution-race-target.txt"));
        },
      });
      assert.equal(await fs.readFile(outsideTarget, "utf8"), "outside-original");
      assert.equal(await fs.readFile(path.join(workspacePath, output.textArtifactPath!), "utf8"), "X".repeat(8_001));
      assert.equal((await fs.lstat(path.join(artifactDir, "execution-race-target.txt"))).isSymbolicLink(), false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("artifact 提交前父目录被替换为外部 symlink 时拒绝且不写入外部路径", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  await withTempWorkspace(async (workspacePath) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-artifact-race-parent-"));
    const artifactDir = path.join(workspacePath, ".awb", "agent", "artifacts", "by_tool_execution");
    const movedArtifactDir = `${artifactDir}.moved`;
    try {
      await assert.rejects(finalizeToolTextForTest({
        workspacePath,
        toolExecutionId: "execution-race-parent",
        toolName: "bash",
        text: "X".repeat(8_001),
        async beforeArtifactCommit() {
          await fs.rename(artifactDir, movedArtifactDir);
          await fs.symlink(outside, artifactDir);
        },
      }), /parent directory changed/);
      await assert.rejects(fs.access(path.join(outside, "execution-race-parent.txt")));
    } finally {
      await fs.rm(path.join(workspacePath, ".awb"), { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("artifact rename 前 temp pathname 被替换时拒绝，外部目标和最终文件均不被发布", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  await withTempWorkspace(async (workspacePath) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-artifact-race-temp-"));
    const outsideTarget = path.join(outside, "outside.txt");
    await fs.writeFile(outsideTarget, "outside-original", "utf8");
    const artifactDir = path.join(workspacePath, ".awb", "agent", "artifacts", "by_tool_execution");
    try {
      await assert.rejects(finalizeToolTextForTest({
        workspacePath,
        toolExecutionId: "execution-race-temp",
        toolName: "bash",
        text: "X".repeat(8_001),
        async onArtifactWritePhase(phase) {
          if (phase !== "before_rename") return;
          const [tempName] = (await fs.readdir(artifactDir)).filter((name) => name.endsWith(".tmp"));
          assert.ok(tempName);
          await fs.unlink(path.join(artifactDir, tempName!));
          await fs.symlink(outsideTarget, path.join(artifactDir, tempName!));
        },
      }), /temp path changed/);
      assert.equal(await fs.readFile(outsideTarget, "utf8"), "outside-original");
      await assert.rejects(fs.access(path.join(artifactDir, "execution-race-temp.txt")));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("artifact rename 后父目录被移动或替换时撤回精确目录项且拒绝成功", async () => {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  await withTempWorkspace(async (workspacePath) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "awb-artifact-race-post-"));
    const artifactDir = path.join(workspacePath, ".awb", "agent", "artifacts", "by_tool_execution");
    const movedArtifactDir = `${artifactDir}.moved`;
    try {
      await assert.rejects(finalizeToolTextForTest({
        workspacePath,
        toolExecutionId: "execution-race-post",
        toolName: "bash",
        text: "X".repeat(8_001),
        async onArtifactWritePhase(phase) {
          if (phase !== "after_rename") return;
          await fs.rename(artifactDir, movedArtifactDir);
          await fs.symlink(outside, artifactDir);
        },
      }), /parent directory changed/);
      assert.equal(await fs.readFile(path.join(outside, "execution-race-post.txt")).catch(() => null), null);
      assert.equal(await fs.readFile(path.join(movedArtifactDir, "execution-race-post.txt")).catch(() => null), null);
    } finally {
      await fs.rm(path.join(workspacePath, ".awb"), { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("artifact 成功发布后正式路径可读且与 Worker 写入内容一致", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const body = "Y".repeat(8_001);
    const output = await finalizeToolTextForTest({
      workspacePath,
      toolExecutionId: "execution-formal-read",
      toolName: "bash",
      text: body,
    });
    const formalPath = path.join(workspacePath, output.textArtifactPath!);
    const stat = await fs.lstat(formalPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(await fs.readFile(formalPath, "utf8"), body);
  });
});

test("subtask executeTool 成功时 completed output 保留完整长文本且无 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      status?: string;
      output?: Record<string, unknown>;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const longText = "R".repeat(9_500);
    const apiClient = {
      async updateToolExecution(input: {
        status?: string;
        output?: Record<string, unknown>;
        resultPreview?: string;
        structuredResult?: unknown;
        error?: string;
        resultTruncated?: boolean;
        resultArtifactPath?: string;
      }) {
        updates.push({
          status: input.status,
          resultPreview: input.resultPreview,
          structuredResult: input.structuredResult,
          error: input.error,
          resultTruncated: input.resultTruncated,
          resultArtifactPath: input.resultArtifactPath,
        });
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
      async startSubtaskRun() {
        return {
          sessionId: "sub_succ",
          runId: "run_sub_succ",
          workspacePath,
          agentName: "Researcher",
        };
      },
      async getSubtaskStatus() {
        return { status: "completed" as const };
      },
      async getSubtaskResult() {
        return { resultText: longText };
      },
    };

    const runner = new AgentRunner(
      apiClient as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    (runner as any).processRun = async () => {};

    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["subtask"],
          pluginTools: [],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath,
        workspaceRepoDirNames: [],
      },
      tool: pendingTool({
        executionId: "execution-201",
        toolName: "subtask",
        toolCallId: "call_subtask_execute_success",
        args: {
          description: "desc",
          prompt: "prompt",
          agentId: "agent_a",
          session: { mode: "new" },
        },
      }),
      signal: new AbortController().signal,
      promptContext: { tools: [] },
    });

    assert.equal(result.paused, false);
    let completed: {
      status?: string;
      output?: Record<string, unknown>;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "completed") {
        completed = item;
        break;
      }
    }
    assert.ok(completed, "should have completed update");
    const output = {
      text: completed.resultPreview,
      result: completed.structuredResult,
      textTruncated: completed.resultTruncated,
      textArtifactPath: completed.resultArtifactPath,
    } as Record<string, unknown>;
    assert.equal(
      output.text,
      `tool: subtask\nstatus: completed\nsubtask_session_id: sub_succ\n\n${longText}`,
    );
    assert.equal(output.textTruncated, undefined);
    assert.equal(output.textArtifactPath, undefined);
    assert.deepEqual(output.result, {
      subtaskSessionId: "sub_succ",
      subtaskAgentId: "agent_a",
      subtaskAgentName: "Researcher",
      resultText: longText,
    });
  });
});

test("subtask executeTool 失败时 failed output 保留错误状态与完整结果且无 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      status?: string;
      output?: Record<string, unknown>;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const longText = "F".repeat(9_500);
    const apiClient = {
      async updateToolExecution(input: {
        status?: string;
        output?: Record<string, unknown>;
        resultPreview?: string;
        structuredResult?: unknown;
        error?: string;
        resultTruncated?: boolean;
        resultArtifactPath?: string;
      }) {
        updates.push({
          status: input.status,
          resultPreview: input.resultPreview,
          structuredResult: input.structuredResult,
          error: input.error,
          resultTruncated: input.resultTruncated,
          resultArtifactPath: input.resultArtifactPath,
        });
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
      async startSubtaskRun() {
        return {
          sessionId: "sub_fail",
          runId: "run_sub_fail",
          workspacePath,
          agentName: "Researcher",
        };
      },
      async getSubtaskStatus() {
        return { status: "failed" as const };
      },
      async getSubtaskResult() {
        return { resultText: longText };
      },
    };

    const runner = new AgentRunner(
      apiClient as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    (runner as any).processRun = async () => {};

    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["subtask"],
          pluginTools: [],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath,
        workspaceRepoDirNames: [],
      },
      tool: pendingTool({
        executionId: "execution-202",
        toolName: "subtask",
        toolCallId: "call_subtask_execute_failed",
        args: {
          description: "desc",
          prompt: "prompt",
          agentId: "agent_a",
          session: { mode: "new" },
        },
      }),
      signal: new AbortController().signal,
      promptContext: { tools: [] },
    });

    assert.equal(result.paused, false);
    let failed: {
      status?: string;
      output?: Record<string, unknown>;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = {
      text: failed.resultPreview,
      result: failed.structuredResult,
      error: failed.error,
      textTruncated: failed.resultTruncated,
      textArtifactPath: failed.resultArtifactPath,
    } as Record<string, unknown>;
    assert.equal(
      output.text,
      `tool: subtask\nstatus: failed\nsubtask_session_id: sub_fail\n\nsubtask failed\n\n${longText}`,
    );
    assert.equal(output.textTruncated, undefined);
    assert.equal(output.textArtifactPath, undefined);
    assert.equal(output.error, "subtask failed");
    assert.deepEqual(output.result, {
      subtaskSessionId: "sub_fail",
      resultText: longText,
    });
  });
});

test("bash 后接 subtask 时拆成两个并发段", () => {
  const batches = buildToolExecutionBatchesForTest([
    pendingTool({ executionId: "execution-1", toolName: "bash" }),
    pendingTool({ executionId: "execution-2", toolName: "subtask" }),
    pendingTool({ executionId: "execution-3", toolName: "bash" }),
  ]);

  assert.deepEqual(
    batches.map((batch) => ({
      mode: batch.mode,
      toolExecutionIds: batch.tools.map((tool) => tool.toolExecutionId),
    })),
    [
      { mode: "parallel", toolExecutionIds: ["execution-1"] },
      { mode: "parallel", toolExecutionIds: ["execution-2"] },
      { mode: "parallel", toolExecutionIds: ["execution-3"] },
    ],
  );
});

test("openai providerOptions 为空时自动补 promptCacheKey", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    sessionId: "sess_123",
    providerOptions: {},
  });

  assert.deepEqual(options, {
    promptCacheKey: "awb:sess_123",
  });
});

test("openai providerOptions 缺少 promptCacheKey 时自动补默认值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    sessionId: "sess_123",
    providerOptions: { temperature: 0.2 },
  });

  assert.deepEqual(options, {
    temperature: 0.2,
    promptCacheKey: "awb:sess_123",
  });
});

test("openai providerOptions 已配置 promptCacheKey 时保持原值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    sessionId: "sess_123",
    providerOptions: { temperature: 0.2, promptCacheKey: "user-defined" },
  });

  assert.deepEqual(options, {
    temperature: 0.2,
    promptCacheKey: "user-defined",
  });
});

test("仅有效非空字符串 promptCacheKey 才视为已配置", () => {
  assert.equal(
    hasValidPromptCacheKeyForTest({ promptCacheKey: "user-defined" }),
    true,
  );
  assert.equal(
    hasValidPromptCacheKeyForTest({ promptCacheKey: "  user-defined  " }),
    true,
  );
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: "" }), false);
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: "   " }), false);
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: null }), false);
  assert.equal(
    hasValidPromptCacheKeyForTest({ promptCacheKey: undefined }),
    false,
  );
  assert.equal(hasValidPromptCacheKeyForTest({ promptCacheKey: 123 }), false);
});

test("openai providerOptions 的空字符串 promptCacheKey 会回退默认值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    sessionId: "sess_123",
    providerOptions: { promptCacheKey: "" },
  });

  assert.deepEqual(options, {
    promptCacheKey: "awb:sess_123",
  });
});

test("openai providerOptions 的空白 promptCacheKey 会回退默认值", () => {
  const options = buildProviderOptionsWithPromptCacheKeyForTest({
    providerNpm: "@ai-sdk/openai",
    sessionId: "sess_123",
    providerOptions: { promptCacheKey: "   " },
  });

  assert.deepEqual(options, {
    promptCacheKey: "awb:sess_123",
  });
});

test("openai providerOptions 的 null/undefined/非字符串 promptCacheKey 会回退默认值", () => {
  assert.deepEqual(
    buildProviderOptionsWithPromptCacheKeyForTest({
      providerNpm: "@ai-sdk/openai",
      sessionId: "sess_123",
      providerOptions: { promptCacheKey: null },
    }),
    { promptCacheKey: "awb:sess_123" },
  );
  assert.deepEqual(
    buildProviderOptionsWithPromptCacheKeyForTest({
      providerNpm: "@ai-sdk/openai",
      sessionId: "sess_123",
      providerOptions: { promptCacheKey: undefined, other: true },
    }),
    { promptCacheKey: "awb:sess_123", other: true },
  );
});

test("subtask 后接 bash 时拆成两个并发段", () => {
  const batches = buildToolExecutionBatchesForTest([
    pendingTool({ executionId: "execution-1", toolName: "subtask" }),
    pendingTool({ executionId: "execution-2", toolName: "bash" }),
    pendingTool({ executionId: "execution-3", toolName: "subtask" }),
  ]);

  assert.deepEqual(
    batches.map((batch) => ({
      mode: batch.mode,
      toolExecutionIds: batch.tools.map((tool) => tool.toolExecutionId),
    })),
    [
      { mode: "parallel", toolExecutionIds: ["execution-1"] },
      { mode: "parallel", toolExecutionIds: ["execution-2"] },
      { mode: "parallel", toolExecutionIds: ["execution-3"] },
    ],
  );
});

test("非并发工具会打断并发段", () => {
  const batches = buildToolExecutionBatchesForTest([
    pendingTool({ executionId: "execution-1", toolName: "bash" }),
    pendingTool({ executionId: "execution-2", toolName: "bash" }),
    pendingTool({ executionId: "execution-3", toolName: "read" }),
    pendingTool({ executionId: "execution-4", toolName: "subtask" }),
    pendingTool({ executionId: "execution-5", toolName: "subtask" }),
  ]);

  assert.deepEqual(
    batches.map((batch) => ({
      mode: batch.mode,
      toolExecutionIds: batch.tools.map((tool) => tool.toolExecutionId),
    })),
    [
      { mode: "parallel", toolExecutionIds: ["execution-1", "execution-2"] },
      { mode: "serial", toolExecutionIds: ["execution-3"] },
      { mode: "parallel", toolExecutionIds: ["execution-4", "execution-5"] },
    ],
  );
});

test("并发段超过上限时自动拆段", () => {
  const batches = buildToolExecutionBatchesForTest([
    pendingTool({ executionId: "execution-1", toolName: "bash" }),
    pendingTool({ executionId: "execution-2", toolName: "bash" }),
    pendingTool({ executionId: "execution-3", toolName: "bash" }),
    pendingTool({ executionId: "execution-4", toolName: "bash" }),
    pendingTool({ executionId: "execution-5", toolName: "bash" }),
  ]);

  assert.deepEqual(
    batches.map((batch) => ({
      mode: batch.mode,
      toolExecutionIds: batch.tools.map((tool) => tool.toolExecutionId),
    })),
    [
      {
        mode: "parallel",
        toolExecutionIds: ["execution-1", "execution-2", "execution-3"],
      },
      { mode: "parallel", toolExecutionIds: ["execution-4", "execution-5"] },
    ],
  );
});

test("并发段中单个工具失败不影响其他工具与后续段", async () => {
  await withTempWorkspace(async (workspacePath) => {
  const executionOrder: string[] = [];
  const runner = new AgentRunner(
    {
      async updateToolExecution() {
        return { id: 1 };
      },
      async updateRunNotice() {
        executionOrder.push("updateRunNotice");
      },
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1,
  );
  stubListedTools(runner, ["bash", "subtask", "read"]);

  (runner as any).executeTool = async ({
    tool,
  }: {
    tool: { toolExecutionId: string; toolName: string };
  }) => {
    executionOrder.push(`start:${tool.toolExecutionId}:${tool.toolName}`);
    if (tool.toolExecutionId === "execution-1") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      executionOrder.push(`done:${tool.toolExecutionId}`);
      return { paused: false as const };
    }
    if (tool.toolExecutionId === "execution-2") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(`fail:${tool.toolExecutionId}`);
      throw new Error("simulated failure");
    }
    executionOrder.push(`done:${tool.toolExecutionId}`);
    return { paused: false as const };
  };

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["bash", "subtask", "read"],
      },
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath,
      workspaceRepoDirNames: [],
    },
    context: {
      pendingTools: [
        pendingTool({ executionId: "execution-1", toolName: "bash" }),
        pendingTool({ executionId: "execution-2", toolName: "bash" }),
        pendingTool({ executionId: "execution-3", toolName: "read" }),
      ],
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.paused, false);
  assert.deepEqual(executionOrder, [
    "start:execution-1:bash",
    "start:execution-2:bash",
    "fail:execution-2",
    "done:execution-1",
    "start:execution-3:read",
    "done:execution-3",
    "updateRunNotice",
  ]);
  });
});

test("并发段中某个工具 paused 时当前 step 返回 paused 且后续段不再启动", async () => {
  const executionOrder: string[] = [];
  const runner = new AgentRunner(
    {
      async updateToolExecution() {
        return { id: 1 };
      },
      async updateRunNotice() {
        executionOrder.push("updateRunNotice");
      },
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1,
  );
  stubListedTools(runner, ["bash", "subtask", "read"]);

  (runner as any).executeTool = async ({
    tool,
  }: {
    tool: { toolExecutionId: string; toolName: string };
  }) => {
    executionOrder.push(`start:${tool.toolExecutionId}:${tool.toolName}`);
    if (tool.toolExecutionId === "execution-1") {
      await new Promise((resolve) => setTimeout(resolve, 25));
      executionOrder.push(`done:${tool.toolExecutionId}`);
      return { paused: false as const };
    }
    if (tool.toolExecutionId === "execution-2") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(`paused:${tool.toolExecutionId}`);
      return { paused: true as const };
    }
    executionOrder.push(`done:${tool.toolExecutionId}`);
    return { paused: false as const };
  };

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["bash", "subtask", "read"],
      },
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: isolatedExecutionWorkspacePath,
      workspaceRepoDirNames: [],
    },
    context: {
      pendingTools: [
        pendingTool({ executionId: "execution-1", toolName: "bash" }),
        pendingTool({ executionId: "execution-2", toolName: "bash" }),
        pendingTool({ executionId: "execution-3", toolName: "read" }),
      ],
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.paused, true);
  assert.deepEqual(executionOrder, [
    "start:execution-1:bash",
    "start:execution-2:bash",
    "paused:execution-2",
    "done:execution-1",
  ]);
});

test("中间工具仍会打断并发段", async () => {
  const executionOrder: string[] = [];
  const runner = new AgentRunner(
    {
      async updateToolExecution(input: {
        toolExecutionId: string;
        status?: string;
      }) {
        executionOrder.push(
          `update:${input.toolExecutionId}:${input.status ?? ""}`,
        );
        return { id: input.toolExecutionId };
      },
      async updateRunNotice() {
        executionOrder.push("updateRunNotice");
      },
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1,
  );
  stubListedTools(runner, ["bash"]);

  (runner as any).executeTool = async ({
    tool,
  }: {
    tool: { toolExecutionId: string; toolName: string };
  }) => {
    executionOrder.push(`start:${tool.toolExecutionId}:${tool.toolName}`);
    await new Promise((resolve) =>
      setTimeout(resolve, tool.toolExecutionId === "execution-1" ? 25 : 5),
    );
    executionOrder.push(`done:${tool.toolExecutionId}`);
    return { paused: false as const };
  };

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["bash"],
      },
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: isolatedExecutionWorkspacePath,
      workspaceRepoDirNames: [],
    },
    context: {
      pendingTools: [
        pendingTool({ executionId: "execution-1", toolName: "bash" }),
        pendingTool({ executionId: "execution-2", toolName: "read" }),
        pendingTool({ executionId: "execution-3", toolName: "bash" }),
      ],
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.paused, false);
  assert.deepEqual(executionOrder, [
    "start:execution-1:bash",
    "done:execution-1",
    "start:execution-2:read",
    "done:execution-2",
    "start:execution-3:bash",
    "done:execution-3",
    "updateRunNotice",
  ]);
});

test("纯非并发多工具保持原有串行语义", async () => {
  const executionOrder: string[] = [];
  const runner = new AgentRunner(
    {
      async updateToolExecution() {
        return { id: 1 };
      },
      async updateRunNotice() {
        executionOrder.push("updateRunNotice");
      },
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1,
  );
  stubListedTools(runner, ["read", "write", "apply_patch"]);

  (runner as any).executeTool = async ({
    tool,
  }: {
    tool: { toolExecutionId: string; toolName: string };
  }) => {
    executionOrder.push(`start:${tool.toolExecutionId}:${tool.toolName}`);
    await new Promise((resolve) =>
      setTimeout(resolve, tool.toolExecutionId === "execution-1" ? 25 : 5),
    );
    executionOrder.push(`done:${tool.toolExecutionId}`);
    return { paused: false as const };
  };

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["read", "write", "apply_patch"],
      },
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: isolatedExecutionWorkspacePath,
      workspaceRepoDirNames: [],
    },
    context: {
      pendingTools: [
        pendingTool({ executionId: "execution-1", toolName: "read" }),
        pendingTool({ executionId: "execution-2", toolName: "write" }),
        pendingTool({ executionId: "execution-3", toolName: "apply_patch" }),
      ],
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.paused, false);
  assert.deepEqual(executionOrder, [
    "start:execution-1:read",
    "done:execution-1",
    "start:execution-2:write",
    "done:execution-2",
    "start:execution-3:apply_patch",
    "done:execution-3",
    "updateRunNotice",
  ]);
});

test("executePendingTools 传入快照时复用 availableToolNames 且不重复 listTools", async () => {
  const updates: Array<{ toolExecutionId: string; status?: string }> = [];
  const runner = new AgentRunner(
    {
      async updateToolExecution(input: {
        toolExecutionId: string;
        status?: string;
      }) {
        updates.push({
          toolExecutionId: input.toolExecutionId,
          status: input.status,
        });
        return { id: input.toolExecutionId };
      },
      async updateRunNotice() {
        return;
      },
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1,
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
        source: "builtin",
      },
    ];
  };
  (runner as any).toolRegistry.isToolEnabled = async (
    _toolName: string,
    ctx: { availableToolNames?: ReadonlySet<string> },
  ) => {
    receivedAvailableToolNames = ctx.availableToolNames;
    return true;
  };
  (runner as any).executeTool = async () => ({ paused: false as const });

  const snapshot = new Set<string>(["read"]);
  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["read"],
      },
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: isolatedExecutionWorkspacePath,
      workspaceRepoDirNames: [],
    },
    availableToolNames: snapshot,
    context: {
      pendingTools: [
        pendingTool({ executionId: "execution-1", toolName: "read" }),
      ],
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.paused, false);
  assert.equal(listToolsCallCount, 0);
  assert.equal(receivedAvailableToolNames, snapshot);
  assert.deepEqual(updates, []);
});

test("executePendingTools 快照缺失时回退到当前 listTools", async () => {
  const runner = new AgentRunner(
    {
      async updateToolExecution() {
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1,
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
        source: "builtin",
      },
    ];
  };
  (runner as any).toolRegistry.isToolEnabled = async (
    _toolName: string,
    ctx: { availableToolNames?: ReadonlySet<string> },
  ) => {
    receivedAvailableToolNames = ctx.availableToolNames;
    return true;
  };
  (runner as any).executeTool = async () => ({ paused: false as const });

  const result = await (runner as any).executePendingTools({
    profile: {
      agent: {
        tools: ["read"],
      },
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: isolatedExecutionWorkspacePath,
      workspaceRepoDirNames: [],
    },
    context: {
      pendingTools: [
        pendingTool({ executionId: "execution-1", toolName: "read" }),
      ],
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.paused, false);
  assert.equal(listToolsCallCount, 1);
  assert.ok(receivedAvailableToolNames);
  assert.equal(receivedAvailableToolNames?.has("read"), true);
});

test("executePendingTools 传入快照时未知工具仍按失败处理且不回退 listTools", async () => {
  const updates: Array<{
    toolExecutionId: string;
    status?: string;
    output?: unknown;
  }> = [];
  const runner = new AgentRunner(
    {
      async updateToolExecution(input: {
        toolExecutionId: string;
        status?: string;
        output?: unknown;
      }) {
        updates.push(input);
        return { id: input.toolExecutionId };
      },
      async updateRunNotice() {
        return;
      },
    } as any,
    {} as any,
    { info() {}, warn() {}, error() {} },
    1,
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
        mcpServers: [],
      },
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "ses_test",
      runId: "run_test",
      workspacePath: isolatedExecutionWorkspacePath,
      workspaceRepoDirNames: [],
    },
    availableToolNames: new Set<string>(["read"]),
    context: {
      pendingTools: [
        pendingTool({ executionId: "execution-1", toolName: "unknown_tool" }),
      ],
    },
    signal: new AbortController().signal,
  });

  assert.equal(result.paused, false);
  assert.equal(listToolsCallCount, 0);
  assert.equal(
    updates.some(
      (item) =>
        item.toolExecutionId === "execution-1" && item.status === "failed",
    ),
    true,
  );
});

test("单个 bash 或 subtask 仍按单段执行，行为与旧实现一致", async () => {
  for (const toolName of ["bash", "subtask"] as const) {
    const executionOrder: string[] = [];
    const runner = new AgentRunner(
      {
        async updateToolExecution() {
          return { id: 1 };
        },
        async updateRunNotice() {
          executionOrder.push("updateRunNotice");
        },
      } as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    stubListedTools(runner, [toolName]);

    (runner as any).executeTool = async ({
      tool,
    }: {
      tool: { toolExecutionId: string; toolName: string };
    }) => {
      executionOrder.push(`start:${tool.toolExecutionId}:${tool.toolName}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      executionOrder.push(`done:${tool.toolExecutionId}`);
      return { paused: false as const };
    };

    const result = await (runner as any).executePendingTools({
      profile: {
        agent: {
          tools: [toolName],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: `ses_${toolName}`,
        runId: `run_${toolName}`,
        workspacePath: isolatedExecutionWorkspacePath,
        workspaceRepoDirNames: [],
      },
      context: {
        pendingTools: [pendingTool({ executionId: "execution-1", toolName })],
      },
      signal: new AbortController().signal,
    });

    assert.equal(result.paused, false);
    assert.deepEqual(executionOrder, [
      `start:execution-1:${toolName}`,
      "done:execution-1",
      "updateRunNotice",
    ]);
  }
});

test("tool 文本过长且 artifact 不可写时降级为 completed + artifact unavailable", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const bigFilePath = path.join(workspacePath, "big.txt");
    const bigContent = `${Array.from({ length: 2600 }, (_, i) => `line-${i.toString().padStart(4, "0")} abcdefghijklmnopqrstuvwxyz`).join("\n")}\n`;
    await fs.writeFile(bigFilePath, bigContent, "utf8");

    // 将 .awb 占位为普通文件,让 artifact 目录无法创建,触发降级分支。
    await fs.writeFile(path.join(workspacePath, ".awb"), "blocked", "utf8");

    const updates: Array<{
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const apiClient = {
      async updateToolExecution(input: {
        status?: string;
        resultPreview?: string;
        structuredResult?: unknown;
        error?: string;
        resultTruncated?: boolean;
        resultArtifactPath?: string;
      }) {
        updates.push({
          status: input.status,
          resultPreview: input.resultPreview,
          structuredResult: input.structuredResult,
          error: input.error,
          resultTruncated: input.resultTruncated,
          resultArtifactPath: input.resultArtifactPath,
        });
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
    };

    const runner = new AgentRunner(
      apiClient as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["read"],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath,
      },
      tool: {
        toolExecutionId: "execution-123",
        status: "queued",
        toolName: "read",
        toolCallId: "call_read_1",
        args: {
          filePath: "big.txt",
          offset: 1,
          limit: 2000,
        },
      },
      signal: new AbortController().signal,
    });

    assert.equal(result.paused, false);
    assert.equal(
      updates.some((item) => item.status === "failed"),
      false,
    );

    let completed: {
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "completed") {
        completed = item;
        break;
      }
    }
    assert.ok(completed, "should have completed update");

    const output = {
      text: completed.resultPreview,
      result: completed.structuredResult,
      textTruncated: completed.resultTruncated,
      textArtifactPath: completed.resultArtifactPath,
    } as Record<string, unknown>;
    assert.equal(typeof output.text, "string");
    assert.equal(
      String(output.text || "").includes("artifact: unavailable"),
      true,
    );
    assert.equal(output.textTruncated, true);
    assert.equal(output.textArtifactPath, undefined);
  });
});

test("read offset 越界时应 completed 且不输出误导性的请求 range", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.writeFile(
      path.join(workspacePath, "small.txt"),
      "alpha\nbeta\n",
      "utf8",
    );

    const updates: Array<{
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const apiClient = {
      async updateToolExecution(input: {
        status?: string;
        resultPreview?: string;
        structuredResult?: unknown;
        error?: string;
        resultTruncated?: boolean;
        resultArtifactPath?: string;
      }) {
        updates.push({
          status: input.status,
          resultPreview: input.resultPreview,
          structuredResult: input.structuredResult,
          error: input.error,
          resultTruncated: input.resultTruncated,
          resultArtifactPath: input.resultArtifactPath,
        });
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
    };

    const runner = new AgentRunner(
      apiClient as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["read"],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath,
      },
      tool: {
        toolExecutionId: "execution-124",
        status: "queued",
        toolName: "read",
        toolCallId: "call_read_2",
        args: {
          filePath: "small.txt",
          offset: 5,
          limit: 20,
        },
      },
      signal: new AbortController().signal,
    });

    assert.equal(result.paused, false);
    assert.equal(
      updates.some((item) => item.status === "failed"),
      false,
    );

    let completed: {
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "completed") {
        completed = item;
        break;
      }
    }
    assert.ok(completed, "should have completed update");

    const output = {
      text: completed.resultPreview,
      result: completed.structuredResult,
      textTruncated: completed.resultTruncated,
      textArtifactPath: completed.resultArtifactPath,
    } as Record<string, unknown>;
    const text = String(output.text || "");
    assert.equal(String(output.error || ""), "");
    assert.equal(text.includes("tool: read"), true);
    assert.equal(text.includes("status: completed"), true);
    assert.equal(
      text.includes(
        "End of file - total 2 lines. Requested offset=5 exceeds file length. No more content to read. Do not call read again for this file unless the file changes.",
      ),
      true,
    );
    assert.equal(text.includes("range: 5-24"), false);
    assert.equal(text.includes("range: 5"), false);
  });
});

test("read 目录 offset 越界时应 completed 且不输出误导性的请求 range", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.mkdir(path.join(workspacePath, "nested"), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "nested", "a.txt"),
      "a",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspacePath, "nested", "b.txt"),
      "b",
      "utf8",
    );

    const updates: Array<{
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const apiClient = {
      async updateToolExecution(input: {
        status?: string;
        resultPreview?: string;
        structuredResult?: unknown;
        error?: string;
        resultTruncated?: boolean;
        resultArtifactPath?: string;
      }) {
        updates.push({
          status: input.status,
          resultPreview: input.resultPreview,
          structuredResult: input.structuredResult,
          error: input.error,
          resultTruncated: input.resultTruncated,
          resultArtifactPath: input.resultArtifactPath,
        });
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
    };

    const runner = new AgentRunner(
      apiClient as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["read"],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath,
      },
      tool: {
        toolExecutionId: "execution-125",
        status: "queued",
        toolName: "read",
        toolCallId: "call_read_3",
        args: {
          filePath: "nested",
          offset: 5,
          limit: 20,
        },
      },
      signal: new AbortController().signal,
    });

    assert.equal(result.paused, false);
    assert.equal(
      updates.some((item) => item.status === "failed"),
      false,
    );

    let completed: {
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "completed") {
        completed = item;
        break;
      }
    }
    assert.ok(completed, "should have completed update");
    const text = String(
      (
        {
          text: completed.resultPreview,
          result: completed.structuredResult,
          textTruncated: completed.resultTruncated,
          textArtifactPath: completed.resultArtifactPath,
        } as Record<string, unknown>
      ).text || "",
    );
    assert.equal(
      text.includes(
        "End of directory - total 2 entries. Requested offset=5 exceeds directory length. No more entries to read. Do not call read again for this directory unless the directory contents change.",
      ),
      true,
    );
    assert.equal(text.includes("range: 5-24"), false);
    assert.equal(text.includes("range: 5"), false);
  });
});

test("bash workdir 不存在时应提示 bash.workdir not found", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const updates: Array<{
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const apiClient = {
      async updateToolExecution(input: {
        status?: string;
        resultPreview?: string;
        structuredResult?: unknown;
        error?: string;
        resultTruncated?: boolean;
        resultArtifactPath?: string;
      }) {
        updates.push({
          status: input.status,
          resultPreview: input.resultPreview,
          structuredResult: input.structuredResult,
          error: input.error,
          resultTruncated: input.resultTruncated,
          resultArtifactPath: input.resultArtifactPath,
        });
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
    };

    const runner = new AgentRunner(
      apiClient as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["bash"],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath,
      },
      tool: {
        toolExecutionId: "execution-456",
        status: "queued",
        toolName: "bash",
        toolCallId: "call_bash_1",
        args: {
          command: "pwd",
          workdir: "missing_dir",
        },
      },
      signal: new AbortController().signal,
    });

    assert.equal(result.paused, false);

    let failed: {
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = {
      text: failed?.resultPreview,
      result: failed?.structuredResult,
      error: failed?.error,
      textTruncated: failed?.resultTruncated,
      textArtifactPath: failed?.resultArtifactPath,
    } as Record<string, unknown>;
    assert.equal(
      String(output.error || ""),
      "bash.workdir not found: missing_dir",
    );
    assert.equal(
      String(output.text || "").includes("bash.workdir not found: missing_dir"),
      true,
    );
  });
});

test("bash workdir 为文件时应提示 bash.workdir must be a directory", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, "not_dir"), "x", "utf8");

    const updates: Array<{
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const apiClient = {
      async updateToolExecution(input: {
        status?: string;
        resultPreview?: string;
        structuredResult?: unknown;
        error?: string;
        resultTruncated?: boolean;
        resultArtifactPath?: string;
      }) {
        updates.push({
          status: input.status,
          resultPreview: input.resultPreview,
          structuredResult: input.structuredResult,
          error: input.error,
          resultTruncated: input.resultTruncated,
          resultArtifactPath: input.resultArtifactPath,
        });
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
    };

    const runner = new AgentRunner(
      apiClient as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["bash"],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath,
      },
      tool: {
        toolExecutionId: "execution-789",
        status: "queued",
        toolName: "bash",
        toolCallId: "call_bash_2",
        args: {
          command: "pwd",
          workdir: "not_dir",
        },
      },
      signal: new AbortController().signal,
    });

    assert.equal(result.paused, false);

    let failed: {
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = {
      text: failed?.resultPreview,
      result: failed?.structuredResult,
      error: failed?.error,
      textTruncated: failed?.resultTruncated,
      textArtifactPath: failed?.resultArtifactPath,
    } as Record<string, unknown>;
    assert.equal(
      String(output.error || ""),
      "bash.workdir must be a directory: not_dir",
    );
    assert.equal(
      String(output.text || "").includes(
        "bash.workdir must be a directory: not_dir",
      ),
      true,
    );
  });
});

test("bash 未传 workdir 且 workspace 根目录不存在时应提示 bash.cwd not found", async () => {
  await withTempWorkspace(async (workspacePath) => {
    // 移除 workspace 根目录,确保不会进入 spawn 分支。
    await fs.rm(workspacePath, { recursive: true, force: true });

    const updates: Array<{
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const apiClient = {
      async updateToolExecution(input: {
        status?: string;
        resultPreview?: string;
        structuredResult?: unknown;
        error?: string;
        resultTruncated?: boolean;
        resultArtifactPath?: string;
      }) {
        updates.push({
          status: input.status,
          resultPreview: input.resultPreview,
          structuredResult: input.structuredResult,
          error: input.error,
          resultTruncated: input.resultTruncated,
          resultArtifactPath: input.resultArtifactPath,
        });
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
    };

    const runner = new AgentRunner(
      apiClient as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["bash"],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath,
      },
      tool: {
        toolExecutionId: "execution-101",
        status: "queued",
        toolName: "bash",
        toolCallId: "call_bash_3",
        args: {
          command: "pwd",
        },
      },
      signal: new AbortController().signal,
    });

    assert.equal(result.paused, false);

    let failed: {
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = {
      text: failed?.resultPreview,
      result: failed?.structuredResult,
      error: failed?.error,
      textTruncated: failed?.resultTruncated,
      textArtifactPath: failed?.resultArtifactPath,
    } as Record<string, unknown>;
    assert.equal(
      String(output.error || ""),
      "bash.cwd not found: workspace root",
    );
    assert.equal(
      String(output.text || "").includes("bash.cwd not found: workspace root"),
      true,
    );
  });
});

test("bash workdir 某级为文件导致 ENOTDIR 时应提示 must be a directory", async () => {
  await withTempWorkspace(async (workspacePath) => {
    await fs.writeFile(path.join(workspacePath, "file"), "x", "utf8");

    const updates: Array<{
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    }> = [];
    const apiClient = {
      async updateToolExecution(input: {
        status?: string;
        resultPreview?: string;
        structuredResult?: unknown;
        error?: string;
        resultTruncated?: boolean;
        resultArtifactPath?: string;
      }) {
        updates.push({
          status: input.status,
          resultPreview: input.resultPreview,
          structuredResult: input.structuredResult,
          error: input.error,
          resultTruncated: input.resultTruncated,
          resultArtifactPath: input.resultArtifactPath,
        });
        return { id: 1 };
      },
      async updateRunNotice() {
        return;
      },
    };

    const runner = new AgentRunner(
      apiClient as any,
      {} as any,
      { info() {}, warn() {}, error() {} },
      1,
    );
    const result = await (runner as any).executeTool({
      profile: {
        agent: {
          tools: ["bash"],
        },
      },
      run: {
        workspaceId: "ws_test",
        sessionId: "ses_test",
        runId: "run_test",
        workspacePath,
      },
      tool: {
        toolExecutionId: "execution-102",
        status: "queued",
        toolName: "bash",
        toolCallId: "call_bash_4",
        args: {
          command: "pwd",
          workdir: "file/sub",
        },
      },
      signal: new AbortController().signal,
    });

    assert.equal(result.paused, false);

    let failed: {
      status?: string;
      resultPreview?: string;
      structuredResult?: unknown;
      error?: string;
      resultTruncated?: boolean;
      resultArtifactPath?: string;
    } | null = null;
    for (let i = updates.length - 1; i >= 0; i -= 1) {
      const item = updates[i];
      if (item?.status === "failed") {
        failed = item;
        break;
      }
    }
    assert.ok(failed, "should have failed update");
    const output = {
      text: failed?.resultPreview,
      result: failed?.structuredResult,
      error: failed?.error,
      textTruncated: failed?.resultTruncated,
      textArtifactPath: failed?.resultArtifactPath,
    } as Record<string, unknown>;
    assert.equal(
      String(output.error || ""),
      "bash.workdir must be a directory: file/sub",
    );
    assert.equal(
      String(output.text || "").includes(
        "bash.workdir must be a directory: file/sub",
      ),
      true,
    );
  });
});

test("启用错误落盘后 Provider reject 记录 tool artifact 的 args 和 error", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import fs from "node:fs/promises";
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      const updates = [];
      const api = { updateToolExecution: async (input) => { updates.push(input); return { id: input.toolExecutionId, ...input }; } };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { throw Object.assign(new Error("provider fixture failure"), { diagnostic: { raw: "preserved" } }); };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { toolExecutionId: "execution-7", callPartId: "part-7", assistantMessageId: "message-7", status: "queued", toolName: "bash", toolCallId: "call_provider", args: { command: "fixture command", sensitiveNamedButModelVisible: "preserved" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
      console.log(JSON.stringify(updates));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    assert.equal(JSON.parse(stdout.trim()).at(-1).status, "failed");
    const dir = path.join(
      workspacePath,
      ".awb",
      "agent",
      "tool-errors",
      "by_run",
      "session",
      "run",
    );
    const files = await fs.readdir(dir);
    assert.equal(
      files.some((file) => file === "execution-7-call_provider.tool.json"),
      true,
    );
    const artifact = JSON.parse(
      await fs.readFile(
        path.join(dir, "execution-7-call_provider.tool.json"),
        "utf8",
      ),
    );
    assert.equal(artifact.failureKind, "tool");
    assert.deepEqual(
      artifact.events.map((event: any) => event.stage),
      ["provider_execute_rejected"],
    );
    assert.equal(artifact.execution.resultAvailability, "not_returned");
    assert.equal(artifact.execution.providerStarted, true);
    assert.deepEqual(
      artifact.writebacks.map((writeback: any) => [
        writeback.role,
        writeback.outcome,
      ]),
      [
        ["initial_running", "succeeded"],
        ["inner_failed", "succeeded"],
      ],
    );
    assert.equal(
      graphContainsString(artifact.tool.args, "fixture command"),
      true,
    );
    assert.equal(
      graphContainsString(artifact.errors[0].value, "provider fixture failure"),
      true,
    );
  });
});

test("启用错误落盘后 completed writeback 失败保留 provider result 和候选 output", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import fs from "node:fs/promises";
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      let count = 0;
      const api = { updateToolExecution: async (input) => { count += 1; if (input.status === "completed") throw new Error("completed writeback failed"); return { id: input.toolExecutionId, ...input }; } };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => ({ stdout: "complete provider result", nested: { value: 42 } });
      try { await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { toolExecutionId: "execution-8", callPartId: "part-8", assistantMessageId: "message-8", status: "queued", toolName: "bash", toolCallId: "call_completed", args: { command: "complete fixture" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } }); } catch (error) { if (!String(error?.message ?? error).includes("control write permanently failed")) throw error; }
      console.log(count);
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    const dir = path.join(
      workspacePath,
      ".awb",
      "agent",
      "tool-errors",
      "by_run",
      "session",
      "run",
    );
    const artifact = JSON.parse(
      await fs.readFile(
        path.join(dir, "execution-8-call_completed.runtime.json"),
        "utf8",
      ),
    );
    assert.equal(artifact.failureKind, "runtime");
    assert.equal(artifact.execution.resultAvailability, "returned");
    assert.equal(artifact.execution.providerStarted, true);
    assert.equal(
      graphContainsString(
        artifact.execution.result,
        "complete provider result",
      ),
      true,
    );
    assert.deepEqual(
      artifact.events.map((event: any) => event.stage),
      ["completed_writeback_failed"],
    );
    assert.deepEqual(
      artifact.writebacks.map((writeback: any) => [
        writeback.role,
        writeback.outcome,
      ]),
      [
        ["initial_running", "succeeded"],
        ["completed", "failed"],
      ],
    );
    assert.equal(
      graphContainsString(
        artifact.writebacks[1].output,
        "complete provider result",
      ),
      true,
    );
  });
});

test("启用错误落盘后 subtask 失败会记录 partial result", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      const api = { updateToolExecution: async (input) => ({ id: input.toolExecutionId, ...input }) };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { const error = new Error("subtask fixture failure"); error.subtaskSessionId = "child-1"; error.subtaskResultText = "partial child text"; throw error; };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["subtask"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { toolExecutionId: "execution-9", callPartId: "part-9", assistantMessageId: "message-9", status: "queued", toolName: "subtask", toolCallId: "call_subtask", args: { prompt: "fixture" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    const artifact = JSON.parse(
      await fs.readFile(
        path.join(
          workspacePath,
          ".awb",
          "agent",
          "tool-errors",
          "by_run",
          "session",
          "run",
          "execution-9-call_subtask.tool.json",
        ),
        "utf8",
      ),
    );
    assert.equal(artifact.failureKind, "tool");
    assert.equal(artifact.execution.resultAvailability, "partial_from_error");
    assert.deepEqual(
      artifact.events.map((event: any) => event.stage),
      ["provider_execute_rejected", "provider_partial_result"],
    );
    assert.deepEqual(
      artifact.writebacks.map((writeback: any) => [
        writeback.role,
        writeback.outcome,
      ]),
      [
        ["initial_running", "succeeded"],
        ["inner_failed", "succeeded"],
      ],
    );
    assert.equal(
      graphContainsString(
        artifact.execution.partialResults[0].value,
        "child-1",
      ),
      true,
    );
    assert.equal(
      graphContainsString(
        artifact.execution.partialResults[0].value,
        "partial child text",
      ),
      true,
    );
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
      const api = { updateToolExecution: async (input) => { updates.push(input); return { id: input.toolExecutionId, ...input }; } };
      const runner = new AgentRunner(api, {}, logger, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { throw new Error("provider failure with blocked store"); };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { toolExecutionId: "execution-10", callPartId: "part-10", assistantMessageId: "message-10", status: "queued", toolName: "bash", toolCallId: "call_store_fail", args: {} }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
      console.log(JSON.stringify(updates));
    `;
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    assert.equal(JSON.parse(stdout.trim()).at(-1).status, "failed");
    assert.equal(stderr.includes("[tool-error-store]"), true);
  });
});

test("启用错误落盘后 pending 快照预检禁用记录 policy artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      const api = {
        updateToolExecution: async (input) => ({ id: input.toolExecutionId, ...input }),
        updateRunNotice: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => false;
      await runner.executePendingTools({
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
        context: { pendingTools: [{ toolExecutionId: "execution-11", callPartId: "part-11", assistantMessageId: "message-11", status: "queued", toolName: "bash", toolCallId: "call_pending_policy", args: { command: "policy fixture" } }], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
        availableToolNames: new Set(["bash"]),
        signal: new AbortController().signal
      });
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    const artifact = JSON.parse(
      await fs.readFile(
        path.join(
          workspacePath,
          ".awb",
          "agent",
          "tool-errors",
          "by_run",
          "session",
          "run",
          "execution-11-call_pending_policy.policy.json",
        ),
        "utf8",
      ),
    );
    assert.equal(artifact.failureKind, "policy");
    assert.equal(artifact.execution.resultAvailability, "not_started");
    assert.deepEqual(
      artifact.events.map((event: any) => event.stage),
      ["tool_disabled_pending_precheck"],
    );
    assert.deepEqual(
      artifact.writebacks.map((writeback: any) => [
        writeback.role,
        writeback.outcome,
      ]),
      [["policy_failed", "succeeded"]],
    );
    assert.equal(
      graphContainsString(artifact.tool.args, "policy fixture"),
      true,
    );
  });
});

test("启用错误落盘后 executeTool 二次禁用检查记录独立 policy stage", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      const api = { updateToolExecution: async (input) => ({ id: input.toolExecutionId, ...input }) };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => false;
      runner.toolRegistry.execute = async () => { throw new Error("must not execute"); };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { toolExecutionId: "execution-12", callPartId: "part-12", assistantMessageId: "message-12", status: "queued", toolName: "bash", toolCallId: "call_execute_policy", args: { command: "second policy fixture" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    const artifact = JSON.parse(
      await fs.readFile(
        path.join(
          workspacePath,
          ".awb",
          "agent",
          "tool-errors",
          "by_run",
          "session",
          "run",
          "execution-12-call_execute_policy.policy.json",
        ),
        "utf8",
      ),
    );
    assert.equal(artifact.failureKind, "policy");
    assert.equal(artifact.execution.resultAvailability, "not_started");
    assert.deepEqual(
      artifact.events.map((event: any) => event.stage),
      ["tool_disabled_execute_check"],
    );
    assert.deepEqual(
      artifact.writebacks.map((writeback: any) => [
        writeback.role,
        writeback.outcome,
      ]),
      [["policy_failed", "succeeded"]],
    );
  });
});

test("启用错误落盘后遗留 running 工具保持静默且不重放", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner } from ${JSON.stringify(runnerModuleUrl)};
      let writes = 0;
      const api = {
        updateToolExecution: async () => { writes += 1; return { result: "updated" }; },
        updateRunNotice: async () => undefined
      };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { throw new Error("must not execute"); };
      await runner.executePendingTools({
        profile: { agent: { tools: ["bash"], pluginTools: [] } },
        run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] },
        context: { pendingTools: [{ toolExecutionId: "execution-13", callPartId: "part-13", assistantMessageId: "message-13", status: "running", toolName: "bash", toolCallId: "call_recovery", args: { command: "recovery fixture" } }], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] },
        availableToolNames: new Set(["bash"]),
        signal: new AbortController().signal
      });
      if (writes !== 0) throw new Error(\`unexpected writes: \${writes}\`);
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    await assert.rejects(fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")));
  });
});

test("启用错误落盘时 Abort 不会发布 artifact", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const script = `
      import { AgentRunner, executeToolSafelyForTest } from ${JSON.stringify(runnerModuleUrl)};
      const api = { updateToolExecution: async (input) => ({ id: input.toolExecutionId, ...input }) };
      const runner = new AgentRunner(api, {}, console, 1);
      runner.toolRegistry.isToolEnabled = async () => true;
      runner.toolRegistry.execute = async () => { throw new DOMException("cancelled", "AbortError"); };
      await executeToolSafelyForTest(runner, { profile: { agent: { tools: ["bash"], pluginTools: [] } }, run: { workspaceId: "ws", sessionId: "session", runId: "run", workspacePath: ${JSON.stringify(workspacePath)}, workspaceRepoDirNames: [] }, tool: { toolExecutionId: "execution-14", callPartId: "part-14", assistantMessageId: "message-14", status: "queued", toolName: "bash", toolCallId: "call_abort", args: { command: "abort fixture" } }, parentSessionId: "session", signal: new AbortController().signal, promptContext: { pendingTools: [], tools: [], headMessageId: null,
    sessionRevision: 0, system: "", messages: [], lastResponseTotalTokens: null, uiLocale: null, externalSkillRoots: [] } });
    `;
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: repositoryRoot,
        env: { ...process.env, AWB_TOOL_ERROR_STORE_ENABLED: "1" },
      },
    );
    await assert.rejects(
      fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors")),
    );
  });
});
