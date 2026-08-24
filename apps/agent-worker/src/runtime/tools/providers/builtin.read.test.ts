import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentApiClient, ExecutionProfile, PromptContext } from "../../apiClient.js";
import type { ToolExecutionContext } from "../types.js";
import { BuiltinToolProvider } from "./builtin.js";

const tempDirectories: string[] = [];

test.afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function createWorkspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "awb-builtin-read-"));
  tempDirectories.push(directory);
  return directory;
}

function createToolContext(params: {
  workspacePath: string;
  workspaceRepoDirNames: string[];
  apiClient?: AgentApiClient;
  processNestedRun?: ToolExecutionContext["processNestedRun"];
}): ToolExecutionContext {
  return {
    profile: {} as ExecutionProfile,
    run: {
      workspaceId: "ws_parent",
      sessionId: "sess_parent",
      runId: "run_parent",
      workspacePath: params.workspacePath,
      workspaceRepoDirNames: params.workspaceRepoDirNames
    },
    pendingTool: {
      itemId: 1,
      status: "queued",
      toolName: "subtask",
      toolCallId: "call_subtask",
      args: {}
    },
    signal: new AbortController().signal,
    apiClient: params.apiClient ?? ({} as AgentApiClient),
    promptContext: {} as PromptContext,
    processNestedRun: params.processNestedRun ?? (async () => undefined),
    updateToolItem: async () => undefined,
    nowMs: () => Date.now(),
    renderToolText: () => "rendered"
  };
}

test("read provider 原样透传 parent workspaceRepoDirNames", async () => {
  const workspacePath = await createWorkspace();
  await fs.mkdir(path.join(workspacePath, "repo-a", "src"), { recursive: true });
  await fs.writeFile(path.join(workspacePath, "repo-a", "src", "a.ts"), "export {};", "utf8");
  const provider = new BuiltinToolProvider();
  const context = createToolContext({ workspacePath, workspaceRepoDirNames: ["repo-a"] });

  await assert.rejects(
    () => provider.execute("read", { filePath: "src/a.ts" }, context),
    /- repo-a\/src\/a\.ts$/
  );
});

for (const mode of ["new", "existing", "fork"] as const) {
  test(`subtask ${mode} nested run 复制 parent workspaceRepoDirNames`, async () => {
    const provider = new BuiltinToolProvider();
    const parentNames = ["repo-a", "repo-b"];
    let nestedRepoDirNames: string[] | null = null;
    const apiClient = {
      async startSubtaskRun() {
        return { sessionId: "sess_child", runId: "run_child", workspacePath: process.cwd(), agentName: "Child", reused: false };
      },
      async getSubtaskStatus() {
        return { status: "completed" as const };
      },
      async getSubtaskResult() {
        return { resultText: "done" };
      }
    } as unknown as AgentApiClient;
    const context = createToolContext({
      workspacePath: process.cwd(),
      workspaceRepoDirNames: parentNames,
      apiClient,
      processNestedRun: async (run) => {
        nestedRepoDirNames = run.workspaceRepoDirNames;
      }
    });

    await provider.execute("subtask", {
      description: "child",
      prompt: "work",
      agentId: "default",
      session: mode === "existing" ? { mode, sessionId: "sess_existing" } : { mode }
    }, context);

    assert.deepEqual(nestedRepoDirNames, ["repo-a", "repo-b"]);
    assert.notEqual(nestedRepoDirNames, parentNames);
  });
}
