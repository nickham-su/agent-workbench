import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { test, mock } from "node:test";
import { discoverWorkspaceContextFiles, WorkspaceContextScanError, type WorkspaceContextScanFileSystem } from "./workspace-context-discovery.js";

// Fixtures live inside the project and are removed only by their owning test.
async function withWorkspace(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(process.cwd(), ".workspace-context-scan-test-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function file(root: string, relative: string, contents = "text") {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
}

function scanFileSystem(overrides: Partial<WorkspaceContextScanFileSystem> = {}): WorkspaceContextScanFileSystem {
  return {
    lstat: (entryPath) => fs.lstat(entryPath),
    realpath: (entryPath) => fs.realpath(entryPath),
    readdir: (dirPath) => fs.readdir(dirPath, { withFileTypes: true }),
    ...overrides,
  };
}

test("discovers depth 0 through 4 once, stops at depth 5 and sorts by UTF-8", async () => {
  await withWorkspace(async (root) => {
    for (const relative of [
      "SKILL.md", "AGENTS.md", "z/SKILL.md", "a/SKILL.md", "a/AGENTS.md",
      "r/.claude/skills/review/SKILL.md", "r/.claude/skills/review/AGENTS.md",
      "r/.claude/skills/review/deep/AGENTS.md", "r/.claude/skills/review/deep/SKILL.md",
      "agents.md", "a/skill.md", "a/AGENTS.MD", "a/SKILL.MD",
    ]) await file(root, relative);
    const result = await discoverWorkspaceContextFiles(root);
    assert.deepEqual(result.skills.map(({ skillId }) => skillId), ["a", "r/.claude/skills/review", "z"]);
    assert.deepEqual(result.agentsInstructions.map(({ path: p }) => p), [
      "AGENTS.md", "a/AGENTS.md", "r/.claude/skills/review/AGENTS.md",
    ]);
    assert.deepEqual(result.skills[1], {
      skillId: "r/.claude/skills/review", skillFilePath: "r/.claude/skills/review/SKILL.md",
    });
  });
});

test("independent depth-five Skill and AGENTS are excluded without any ancestor Skill", async () => {
  await withWorkspace(async (root) => {
    await file(root, "one/two/three/four/SKILL.md");
    await file(root, "one/two/three/four/AGENTS.md");
    await file(root, "outside/a/b/c/d/SKILL.md");
    await file(root, "outside/a/b/c/d/AGENTS.md");
    const result = await discoverWorkspaceContextFiles(root);
    assert.deepEqual(result.skills.map(({ skillId }) => skillId), ["one/two/three/four"]);
    assert.deepEqual(result.agentsInstructions.map(({ path }) => path), ["one/two/three/four/AGENTS.md"]);
  });
});

test("a directory replaced during readdir fails instead of returning a truncated success", async () => {
  await withWorkspace(async (root) => {
    await file(root, "a/SKILL.md");
    await file(root, "z/AGENTS.md");
    await fs.mkdir(path.join(root, "replacement"));
    const fileSystem = scanFileSystem({
      readdir: async (dirPath) => {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        if (dirPath === path.join(root, "a")) {
          await fs.rename(dirPath, path.join(root, "old-a"));
          await fs.rename(path.join(root, "replacement"), dirPath);
        }
        return entries;
      },
    });
    await assert.rejects(discoverWorkspaceContextFiles(root, fileSystem), WorkspaceContextScanError);
  });
});

test("a queued directory replaced before readdir fails; a naturally vanished directory may be skipped", async () => {
  await withWorkspace(async (root) => {
    await file(root, "a/SKILL.md");
    await file(root, "z/AGENTS.md");
    await fs.mkdir(path.join(root, "replacement"));
    let checks = 0;
    const changed = scanFileSystem({
      lstat: async (entryPath) => {
        if (entryPath === path.join(root, "a") && ++checks === 3) {
          await fs.rename(entryPath, path.join(root, "old-a"));
          await fs.rename(path.join(root, "replacement"), entryPath);
        }
        return fs.lstat(entryPath);
      },
    });
    await assert.rejects(discoverWorkspaceContextFiles(root, changed), WorkspaceContextScanError);

    await file(root, "missing/SKILL.md");
    checks = 0;
    const gone = scanFileSystem({
      lstat: async (entryPath) => {
        if (entryPath === path.join(root, "missing") && ++checks === 3) {
          await fs.rename(entryPath, path.join(root, "old-missing"));
        }
        return fs.lstat(entryPath);
      },
    });
    const snapshot = await discoverWorkspaceContextFiles(root, gone);
    assert.equal(snapshot.skills.some((item) => item.skillId === "missing"), false);
    assert.deepEqual(snapshot.agentsInstructions.map((item) => item.path), ["z/AGENTS.md"]);
  });
});

test("identity changes between directory lstat and realpath fail the complete scan", async () => {
  await withWorkspace(async (root) => {
    await file(root, "a/SKILL.md");
    await fs.mkdir(path.join(root, "replacement"));
    const fileSystem = scanFileSystem({
      realpath: async (entryPath) => {
        if (entryPath === path.join(root, "a")) {
          await fs.rename(entryPath, path.join(root, "old-a"));
          await fs.rename(path.join(root, "replacement"), entryPath);
        }
        return fs.realpath(entryPath);
      },
    });
    await assert.rejects(discoverWorkspaceContextFiles(root, fileSystem), WorkspaceContextScanError);
  });
});

test("unknown Dirent type is checked by lstat and a real directory remains discoverable", async () => {
  await withWorkspace(async (root) => {
    await file(root, "mystery/SKILL.md");
    await file(root, "mystery/child/AGENTS.md");
    const fileSystem = scanFileSystem({
      readdir: async (dirPath) => (await fs.readdir(dirPath, { withFileTypes: true })).map((entry) => {
        if (dirPath !== root || entry.name !== "mystery") return entry;
        return {
          name: entry.name,
          parentPath: entry.parentPath,
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
        } as Dirent;
      }),
    });
    const snapshot = await discoverWorkspaceContextFiles(root, fileSystem);
    assert.deepEqual(snapshot.skills.map((item) => item.skillId), ["mystery"]);
    assert.deepEqual(snapshot.agentsInstructions.map((item) => item.path), ["mystery/child/AGENTS.md"]);
  });
});

test("root symlink is rejected and directory entries cannot masquerade as candidate files", async () => {
  await withWorkspace(async (root) => {
    await fs.mkdir(path.join(root, "not-a-file", "SKILL.md"), { recursive: true });
    await fs.mkdir(path.join(root, "not-a-file", "AGENTS.md"));
    await fs.symlink(root, path.join(root, "root-link"), "dir");
    await assert.rejects(discoverWorkspaceContextFiles(path.join(root, "root-link")), WorkspaceContextScanError);
    const snapshot = await discoverWorkspaceContextFiles(root);
    assert.deepEqual(snapshot, { skills: [], agentsInstructions: [] });
  });
});

test("scan failures in readdir and realpath never return a partial candidate snapshot", async () => {
  await withWorkspace(async (root) => {
    await file(root, "a/SKILL.md");
    await file(root, "z/AGENTS.md");
    const originalReaddir = fs.readdir.bind(fs);
    const originalRealpath = fs.realpath.bind(fs);
    try {
      mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
        if (String(args[0]) === path.join(root, "z")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return originalReaddir(...args);
      });
      await assert.rejects(discoverWorkspaceContextFiles(root), WorkspaceContextScanError);
      mock.restoreAll();

      mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
        if (String(args[0]) === path.join(root, "a/SKILL.md")) throw Object.assign(new Error("I/O error"), { code: "EIO" });
        return originalRealpath(...args);
      });
      await assert.rejects(discoverWorkspaceContextFiles(root), WorkspaceContextScanError);
    } finally {
      mock.restoreAll();
    }
  });
});

test("a missing SKILL.md at metadata check does not suppress descendant Skill", async () => {
  await withWorkspace(async (root) => {
    await file(root, "p/SKILL.md");
    await file(root, "p/child/SKILL.md");
    const originalRealpath = fs.realpath.bind(fs);
    try {
      mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
        if (String(args[0]) === path.join(root, "p/SKILL.md")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return originalRealpath(...args);
      });
      assert.deepEqual((await discoverWorkspaceContextFiles(root)).skills.map((item) => item.skillId), ["p/child"]);
    } finally {
      mock.restoreAll();
    }
  });
});

test("nested SKILL.md suppresses child Skill registration but never child AGENTS.md", async () => {
  await withWorkspace(async (root) => {
    await file(root, "p/SKILL.md", "\u0000binary");
    await file(root, "p/child/SKILL.md");
    await file(root, "p/child/AGENTS.md");
    await file(root, "p/child/deeper/AGENTS.md");
    const snapshot = await discoverWorkspaceContextFiles(root);
    assert.deepEqual(snapshot.skills.map((skill) => skill.skillId), ["p"]);
    assert.deepEqual(snapshot.agentsInstructions.map((item) => item.path), ["p/child/AGENTS.md", "p/child/deeper/AGENTS.md"]);
    await fs.rm(path.join(root, "p/SKILL.md"));
    assert.deepEqual((await discoverWorkspaceContextFiles(root)).skills.map((item) => item.skillId), ["p/child"]);
  });
});

test("ignored directories and builtin namespace do not prevent unrelated or descendant AGENTS discovery", async () => {
  await withWorkspace(async (root) => {
    for (const name of [".git", "node_modules", ".agent-workbench", ".claude", "builtin", "other"]) {
      await file(root, `${name}/review/SKILL.md`);
      await file(root, `${name}/review/AGENTS.md`);
    }
    const snapshot = await discoverWorkspaceContextFiles(root);
    assert.deepEqual(snapshot.skills.map((item) => item.skillId), [".claude/review", "other/review"]);
    assert.deepEqual(snapshot.agentsInstructions.map((item) => item.path), [
      ".claude/review/AGENTS.md", "builtin/review/AGENTS.md", "other/review/AGENTS.md",
    ]);
  });
});

test("skips symlink dirs and files; invalid segments prune their subtrees", async () => {
  await withWorkspace(async (root) => {
    await file(root, "safe/SKILL.md");
    await file(root, "safe/AGENTS.md");
    await fs.symlink(path.join(root, "safe"), path.join(root, "alias"), "dir");
    await fs.mkdir(path.join(root, "linked"));
    await fs.symlink(path.join(root, "safe/SKILL.md"), path.join(root, "linked/SKILL.md"));
    await fs.symlink(path.join(root, "safe/AGENTS.md"), path.join(root, "linked/AGENTS.md"));
    await file(root, "bad`name/child/SKILL.md");
    await file(root, "bad`name/child/AGENTS.md");
    await file(root, "合法/子/SKILL.md");
    const snapshot = await discoverWorkspaceContextFiles(root);
    assert.deepEqual(snapshot.skills.map((item) => item.skillId), ["safe", "合法/子"]);
    assert.deepEqual(snapshot.agentsInstructions.map((item) => item.path), ["safe/AGENTS.md"]);
  });
});

test("missing workspace root fails with no absolute path in the error", async () => {
  await withWorkspace(async (root) => {
    const missing = path.join(root, "no-such-root");
    await assert.rejects(discoverWorkspaceContextFiles(missing), (error: unknown) => {
      assert.ok(error instanceof WorkspaceContextScanError);
      assert.equal(error.code, "WORKSPACE_CONTEXT_SCAN_FAILED");
      assert.equal(error.message.includes(missing), false);
      return true;
    });
  });
});

test("ENOENT and ENOTDIR during scan skip vanished entries; EACCES and unknown I/O fail as a whole", async () => {
  await withWorkspace(async (root) => {
    await file(root, "p/SKILL.md");
    await file(root, "p/child/SKILL.md");
    await file(root, "p/child/AGENTS.md");
    const originalLstat = fs.lstat.bind(fs);
    try {
      for (const code of ["ENOENT", "ENOTDIR"]) {
        mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
          if (String(args[0]) === path.join(root, "p/SKILL.md")) throw Object.assign(new Error("gone"), { code });
          return originalLstat(...args);
        });
        const result = await discoverWorkspaceContextFiles(root);
        assert.deepEqual(result.skills.map((item) => item.skillId), ["p/child"]);
        mock.restoreAll();
      }
      for (const code of ["EACCES", "EPERM", "EIO"]) {
        mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
          if (String(args[0]) === path.join(root, "p/SKILL.md")) throw Object.assign(new Error("private path"), { code });
          return originalLstat(...args);
        });
        await assert.rejects(discoverWorkspaceContextFiles(root), (error: unknown) => {
          assert.ok(error instanceof WorkspaceContextScanError);
          assert.equal(error.message.includes(root), false);
          return true;
        });
        mock.restoreAll();
      }
    } finally {
      mock.restoreAll();
    }
  });
});
