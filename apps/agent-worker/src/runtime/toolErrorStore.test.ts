import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildToolErrorArtifactRelativePath,
  formatToolErrorStoreWarning,
  storeToolErrorArtifact,
  type ToolErrorArtifact
} from "./toolErrorStore.js";
import { safePathSegment } from "./workspaceSafeIo.js";

async function withWorkspace(fn: (workspacePath: string) => Promise<void>) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-tool-error-store-"));
  try {
    await fn(workspacePath);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

function fixtureArtifact(overrides: Partial<ToolErrorArtifact> = {}): ToolErrorArtifact {
  return {
    schemaVersion: 1,
    kind: "tool_error",
    captureId: "capture_1",
    recordedAt: 1_700_000_000_000,
    failureKind: "tool",
    identity: {
      workspaceId: "ws_1",
      sessionId: "sess_1",
      runId: "run_1",
      itemId: 42,
      toolCallId: "call_1"
    },
    events: [{ sequence: 1, stage: "provider_execute_rejected" }],
    ...overrides
  };
}

test("safePathSegment 保持 Runner 合同", () => {
  assert.equal(safePathSegment("  session / nested  "), "session___nested");
  assert.equal(safePathSegment(""), "unknown");
  assert.equal(safePathSegment("x".repeat(121)), "x".repeat(120));
});

test("构造固定 by_run 相对路径并拒绝无效 itemId", () => {
  const relativePath = buildToolErrorArtifactRelativePath(fixtureArtifact().identity, "runtime");
  assert.equal(relativePath, path.join(".awb", "agent", "tool-errors", "by_run", "sess_1", "run_1", "42-call_1.runtime.json"));
  assert.throws(
    () => buildToolErrorArtifactRelativePath({ ...fixtureArtifact().identity, itemId: 0 }, "tool"),
    /positive safe integer/
  );
});

test("安全发布 canonical 文件，权限最小且 JSON 完整", async () => {
  await withWorkspace(async (workspacePath) => {
    const artifact = fixtureArtifact();
    const result = await storeToolErrorArtifact({ workspacePath, artifact });

    assert.equal(result.outcome, "published");
    assert.equal(result.conflict, false);
    assert.equal(result.relativePath, path.join(".awb", "agent", "tool-errors", "by_run", "sess_1", "run_1", "42-call_1.tool.json"));
    const saved = JSON.parse(await fs.readFile(result.path, "utf8"));
    assert.deepEqual(saved, artifact);
    const stat = await fs.stat(result.path);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o077, 0);
  });
});

test("相同身份 canonical 视为幂等且绝不覆盖", async () => {
  await withWorkspace(async (workspacePath) => {
    const artifact = fixtureArtifact();
    const first = await storeToolErrorArtifact({ workspacePath, artifact });
    assert.equal(first.outcome, "published");
    const initial = await fs.readFile(first.path, "utf8");

    const second = await storeToolErrorArtifact({ workspacePath, artifact: { ...artifact, captureId: "capture_2", events: [{ sequence: 99 }] } });
    assert.equal(second.outcome, "idempotent");
    assert.equal(second.path, first.path);
    assert.equal(await fs.readFile(first.path, "utf8"), initial);
  });
});

test("路径安全化冲突或 canonical 内容冲突时发布独立 conflict 文件", async () => {
  await withWorkspace(async (workspacePath) => {
    const first = fixtureArtifact({ identity: { ...fixtureArtifact().identity, toolCallId: "call/a" } });
    const firstResult = await storeToolErrorArtifact({ workspacePath, artifact: first });
    assert.equal(firstResult.outcome, "published");

    const conflicting = fixtureArtifact({
      captureId: "capture_2",
      identity: { ...fixtureArtifact().identity, toolCallId: "call:a" }
    });
    const result = await storeToolErrorArtifact({ workspacePath, artifact: conflicting });
    assert.equal(result.outcome, "published");
    assert.equal(result.conflict, true);
    assert.match(path.basename(result.path), /^42-call_a\.tool\.conflict-1700000000000-1\.json$/);
    assert.deepEqual(JSON.parse(await fs.readFile(result.path, "utf8")), conflicting);
  });
});

test("既有 canonical symlink 被拒绝，绝不读取其工作区外目标", async () => {
  await withWorkspace(async (workspacePath) => {
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-tool-error-canonical-outside-"));
    try {
      const artifact = fixtureArtifact();
      const relativePath = buildToolErrorArtifactRelativePath(artifact.identity, artifact.failureKind);
      const canonicalPath = path.join(workspacePath, relativePath);
      await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
      await fs.writeFile(path.join(outsidePath, "artifact.json"), JSON.stringify(artifact));
      await fs.symlink(path.join(outsidePath, "artifact.json"), canonicalPath);

      const result = await storeToolErrorArtifact({ workspacePath, artifact });
      assert.equal(result.outcome, "published");
      assert.equal(result.conflict, true);
      assert.equal(await fs.lstat(canonicalPath).then((stat) => stat.isSymbolicLink()), true);
      assert.deepEqual(JSON.parse(await fs.readFile(result.path, "utf8")), artifact);
    } finally {
      await fs.rm(outsidePath, { recursive: true, force: true });
    }
  });
});

test("预创建 symlink 路径会安全失败且不写出工作区", async () => {
  await withWorkspace(async (workspacePath) => {
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-tool-error-outside-"));
    try {
      await fs.symlink(outsidePath, path.join(workspacePath, ".awb"));
      const result = await storeToolErrorArtifact({ workspacePath, artifact: fixtureArtifact() });
      assert.equal(result.outcome, "failed");
      assert.equal(await fs.readdir(outsidePath).then((items) => items.length), 0);
    } finally {
      await fs.rm(outsidePath, { recursive: true, force: true });
    }
  });
});

test("无 no-follow 能力时安全失败，不发布 final", async () => {
  await withWorkspace(async (workspacePath) => {
    const result = await storeToolErrorArtifact(
      { workspacePath, artifact: fixtureArtifact() },
      { requireNoFollowFlag: () => { throw new Error("no-follow unavailable"); } }
    );
    assert.equal(result.outcome, "failed");
    assert.equal(result.relativePath, path.join(".awb", "agent", "tool-errors", "by_run", "sess_1", "run_1", "42-call_1.tool.json"));
    assert.equal(formatToolErrorStoreWarning(result).includes(`path=${result.relativePath}`), true);
    await assert.rejects(fs.access(path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "sess_1", "run_1", "42-call_1.tool.json")));
  });
});

test("hard link 不支持时安全失败并清理 temp", async () => {
  await withWorkspace(async (workspacePath) => {
    const result = await storeToolErrorArtifact(
      { workspacePath, artifact: fixtureArtifact() },
      {
        link: async () => {
          const error = Object.assign(new Error("link unsupported"), { code: "EOPNOTSUPP" });
          throw error;
        }
      }
    );
    assert.equal(result.outcome, "failed");
    assert.equal(result.relativePath, path.join(".awb", "agent", "tool-errors", "by_run", "sess_1", "run_1", "42-call_1.tool.json"));
    const finalDirectory = path.join(workspacePath, ".awb", "agent", "tool-errors", "by_run", "sess_1", "run_1");
    const items = await fs.readdir(finalDirectory);
    assert.deepEqual(items, []);
  });
});

test("warning 摘要保持单行且最长 512 字符，不暴露 payload", () => {
  const warning = formatToolErrorStoreWarning({
    relativePath: "a\nb",
    operation: "publish\r\nlink",
    error: Object.assign(new Error(`secret payload ${"x".repeat(1_000)}\u2028more`), { code: "EIO" }),
    suppressed: 3
  });
  assert.equal(warning.includes("\n") || warning.includes("\r") || warning.includes("\u2028"), false);
  assert.equal(warning.length <= 512, true);
  assert.match(warning, /^\[tool-error-store\] /);
  assert.match(warning, /operation=publish link/);
  assert.match(warning, /suppressed=3/);
  assert.equal(warning.includes('{"events"'), false);
});

test("当前平台具备 no-follow 时可验证真实支持能力", () => {
  assert.equal(typeof fsConstants.O_NOFOLLOW === "number" && fsConstants.O_NOFOLLOW !== 0, true);
});
