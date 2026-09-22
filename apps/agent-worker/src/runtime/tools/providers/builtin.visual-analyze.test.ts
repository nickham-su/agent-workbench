import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ToolExecutionContext } from "../types.js";
import { BuiltinToolProvider } from "./builtin.js";

class CapturingBuiltinToolProvider extends BuiltinToolProvider {
  capturedTimeoutMs: number | null | undefined;

  protected override async generateSingleCallSummary(params: any) {
    this.capturedTimeoutMs = params.input.timeoutMs;
    return { text: "visual findings", totalTokens: null };
  }
}

function createContext(workspacePath: string, modelTotalTimeoutMs: number) {
  return {
    profile: {
      provider: { id: "provider", npm: "@ai-sdk/openai", options: {} },
      model: { id: "model" },
      vision: null,
      runtime: { modelTotalTimeoutMs },
    },
    run: {
      workspaceId: "ws_test",
      sessionId: "session_test",
      runId: "run_test",
      workspacePath,
      workspaceRepoDirNames: [],
    },
    signal: new AbortController().signal,
  } as unknown as ToolExecutionContext;
}

test("visual_analyze 使用 execution profile 的单次请求超时，0 关闭本地超时", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-visual-timeout-"));
  try {
    await fs.writeFile(path.join(workspacePath, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    for (const [configuredTimeoutMs, expectedTimeoutMs] of [[12_345, 12_345], [0, null]] as const) {
      const provider = new CapturingBuiltinToolProvider();
      const result = await provider.execute(
        "visual_analyze",
        { paths: ["image.png"] },
        createContext(workspacePath, configuredTimeoutMs),
      );

      assert.equal(provider.capturedTimeoutMs, expectedTimeoutMs);
      assert.deepEqual(result, {
        text: "visual findings",
        files: ["image.png"],
        source: "agent_default_fallback",
      });
    }
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
