import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRunner } from "./runner.js";

async function withTempWorkspace(fn: (workspacePath: string) => Promise<void>) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-runner-tool-output-"));
  try {
    await fn(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

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
          tools: ["read"],
          permissions: {
            allowRead: true,
            allowWrite: true,
            allowBash: true
          }
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
