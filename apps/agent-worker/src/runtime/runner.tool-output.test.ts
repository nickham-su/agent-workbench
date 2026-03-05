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
          tools: ["bash"],
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
          tools: ["bash"],
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
          tools: ["bash"],
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
          tools: ["bash"],
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
