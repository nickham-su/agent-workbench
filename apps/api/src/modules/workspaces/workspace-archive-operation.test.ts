import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { test } from "node:test";
import { runWorkspaceArchiveOperation, type ArchiveOperationOptions } from "./workspace-archive-operation.js";
import { tarFixture, zipFixture } from "./workspace-archive-fixtures.js";
import { ArchiveOwnedNodes, ArchiveParentGuard } from "./workspace-archive-owned.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const testRoot = path.join(repoRoot, ".tmp-tests");
const exec = promisify(execFile);
const missing = async (abs: string) => assert.rejects(fs.lstat(abs), { code: "ENOENT" });
async function fixture(work: (value: { root: string; run: (options?: ArchiveOperationOptions, protectedNames?: string[]) => ReturnType<typeof runWorkspaceArchiveOperation> }) => Promise<void>, data = zipFixture([{ name: "dir/file", data: "hello" }, { name: "root-file", data: "world" }]), sourceChangedByTest = false) {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, "archive-operation-"));
  const input = path.join(root, "input.zip");
  try {
    await fs.writeFile(input, data);
    await work({ root, run: (options, protectedNames = []) => runWorkspaceArchiveOperation({ rootAbs: root, sourceInRegion: "input.zip", sourcePath: "input.zip", protectedTopLevelNames: new Set(protectedNames), options }) });
    if (!sourceChangedByTest) assert.deepEqual(await fs.readFile(input), data, "source archive remains unchanged on success and failure");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
const injected = (code: string) => Object.assign(new Error("fake private path /do-not-leak"), { code });

test("A-PUB-03/18: real no-replace publication, safe modes, alias unlink and full temporary cleanup", async () => {
  await fixture(async ({ root, run }) => {
    const response = await run();
    assert.deepEqual(response, { path: "input.zip", dir: "", format: "zip", topLevelCount: 2, fileCount: 2, directoryCount: 1, extractedBytes: 10 });
    assert.equal(await fs.readFile(path.join(root, "dir/file"), "utf8"), "hello");
    assert.equal((await fs.stat(path.join(root, "dir"))).mode & 0o7777, 0o755);
    assert.equal((await fs.stat(path.join(root, "dir/file"))).mode & 0o7777, 0o644);
    assert.deepEqual((await fs.readdir(root)).sort(), ["dir", "input.zip", "root-file"]);
  });
});

for (const kind of ["file", "empty-dir", "directory", "symlink", "dangling", "source"] as const) {
  test(`A-PUB-01: ${kind} top-level collision rejects entire archive without touching existing data`, async () => {
    const name = kind === "source" ? "input.zip" : "existing";
    await fixture(async ({ root, run }) => {
      const target = path.join(root, "existing");
      if (kind === "file") await fs.writeFile(target, "keep");
      if (kind === "empty-dir" || kind === "directory") await fs.mkdir(target);
      if (kind === "directory") await fs.writeFile(path.join(target, "nested"), "keep");
      if (kind === "symlink" || kind === "dangling") await fs.symlink(kind === "symlink" ? "input.zip" : "missing", target);
      const input = await fs.readFile(path.join(root, "input.zip"));
      await assert.rejects(run(), { code: "ARCHIVE_TARGET_CONFLICT", statusCode: 409 });
      assert.deepEqual(await fs.readFile(path.join(root, "input.zip")), input);
      await missing(path.join(root, "new-output"));
      assert.ok(!(await fs.readdir(root)).some((item) => item.startsWith(".awb-extract-")));
      if (kind === "file") assert.equal(await fs.readFile(target, "utf8"), "keep");
      if (kind === "directory") assert.equal(await fs.readFile(path.join(target, "nested"), "utf8"), "keep");
      if (kind === "symlink" || kind === "dangling") assert.equal(await fs.readlink(target), kind === "symlink" ? "input.zip" : "missing");
    }, zipFixture([{ name: "new-output", data: "new" }, { name, data: "never" }]));
  });
}

test("A-PUB-02: a DB-reserved but absent repository root is a protected top-level conflict", async () => {
  await fixture(async ({ root, run }) => {
    await assert.rejects(run({}, ["reserved-repo"]), { code: "ARCHIVE_TARGET_CONFLICT" });
    assert.deepEqual(await fs.readdir(root), ["input.zip"]);
  }, zipFixture([{ name: "reserved-repo/file", data: "x" }]));
});

for (const existing of ["file", "directory"] as const) {
  test(`A-PUB-04: a concurrent ${existing} after preflight is never replaced or removed`, async () => {
    await fixture(async ({ root, run }) => {
      await assert.rejects(run({ hooks: { onPhase: async ({ phase }) => {
        if (phase === "preflight-complete") {
          const target = path.join(root, "root-file");
          if (existing === "directory") await fs.mkdir(target); else await fs.writeFile(target, "concurrent");
        }
      } } }), { code: "ARCHIVE_TARGET_CONFLICT" });
      if (existing === "file") assert.equal(await fs.readFile(path.join(root, "root-file"), "utf8"), "concurrent");
      else assert.equal((await fs.lstat(path.join(root, "root-file"))).isDirectory(), true);
      await missing(path.join(root, "dir"));
      assert.ok(!(await fs.readdir(root)).some((item) => item.startsWith(".awb-extract-")));
    });
  });
}

for (const phase of ["source-opened", "snapshot-complete", "staging-complete", "preflight-complete", "published", "before-commit"] as const) {
  test(`A-PUB-05/06: ${phase} failure safely rolls back only owned output`, async () => {
    await fixture(async ({ root, run }) => {
      await fs.writeFile(path.join(root, "sentinel"), "unchanged");
      await assert.rejects(run({ hooks: { onPhase: ({ phase: current }) => { if (current === phase) throw injected("EIO"); } } }), { code: "ARCHIVE_IO_FAILED" });
      assert.deepEqual((await fs.readdir(root)).sort(), ["input.zip", "sentinel"]);
      assert.equal(await fs.readFile(path.join(root, "sentinel"), "utf8"), "unchanged");
    });
  });
}

test("A-PUB-07/08: unknown external children prevent recursive cleanup and are preserved", async () => {
  await fixture(async ({ root, run }) => {
    const summaries: unknown[] = [];
    await assert.rejects(run({ onFailure: (value) => summaries.push(value), hooks: { onPhase: async ({ phase, staging }) => {
      if (phase === "before-commit") {
        await fs.writeFile(path.join(root, "dir", "external"), "keep external");
        await fs.writeFile(path.join(staging!, "external"), "keep temporary external");
      }
    } } }), { code: "ARCHIVE_CLEANUP_INCOMPLETE" });
    assert.equal(await fs.readFile(path.join(root, "dir", "external"), "utf8"), "keep external");
    const stage = (await fs.readdir(root)).find((item) => item.startsWith(".awb-extract-"))!;
    assert.equal(await fs.readFile(path.join(root, stage, "external"), "utf8"), "keep temporary external");
    await missing(path.join(root, "dir/file"));
    assert.equal(summaries.length, 1);
    assert.ok(!JSON.stringify(summaries).includes(root));
  });
});

test("A-PUB-17: same-inode same-length external edits are preserved, including the staging alias", async () => {
  await fixture(async ({ root, run }) => {
    let stage: string | undefined;
    await assert.rejects(run({ hooks: { onPhase: async ({ phase, staging }) => {
      if (phase === "before-commit") {
        stage = staging;
        const target = path.join(root, "dir/file");
        const before = await fs.stat(target, { bigint: true });
        await fs.writeFile(target, "other");
        await fs.utimes(target, new Date(0), new Date(1000));
        const after = await fs.stat(target, { bigint: true });
        assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
      }
    } } }), { code: "ARCHIVE_CLEANUP_INCOMPLETE" });
    assert.equal(await fs.readFile(path.join(root, "dir/file"), "utf8"), "other");
    assert.equal(await fs.readFile(path.join(stage!, "payload/dir/file"), "utf8"), "other");
  });
});

test("A-PUB-17: mode-only external changes taint both output and its staging alias", async () => {
  await fixture(async ({ root, run }) => {
    let staged: string | undefined;
    await assert.rejects(run({ hooks: { onPhase: async ({ phase, staging }) => {
      if (phase === "before-commit") {
        staged = path.join(staging!, "payload/dir/file");
        await fs.chmod(path.join(root, "dir/file"), 0o600);
      }
    } } }), { code: "ARCHIVE_CLEANUP_INCOMPLETE" });
    assert.equal((await fs.lstat(path.join(root, "dir/file"))).mode & 0o7777, 0o600);
    assert.equal((await fs.lstat(staged!)).mode & 0o7777, 0o600);
  });
});

test("A-PUB-09: post-commit temporary cleanup failure keeps complete output and reports uncertain cleanup", async () => {
  await fixture(async ({ root, run }) => {
    await assert.rejects(run({ hooks: { beforeCleanupNode: ({ path: abs }) => {
      if (abs.endsWith("owner.json")) throw injected("EACCES");
    } } }), { code: "ARCHIVE_CLEANUP_INCOMPLETE" });
    assert.equal(await fs.readFile(path.join(root, "dir/file"), "utf8"), "hello");
    assert.equal(await fs.readFile(path.join(root, "root-file"), "utf8"), "world");
  });
});

for (const [errno, code, statusCode] of [["ENOSPC", "ARCHIVE_STORAGE_EXHAUSTED", 507], ["EACCES", "ARCHIVE_PERMISSION_DENIED", 403], ["EXDEV", "ARCHIVE_FILESYSTEM_UNSUPPORTED", 409], ["EOPNOTSUPP", "ARCHIVE_FILESYSTEM_UNSUPPORTED", 409]] as const) {
  test(`A-PUB-05/10: ${errno} is classified without exposing native paths`, async () => {
    await fixture(async ({ root, run }) => {
      await assert.rejects(run({ hooks: { onPhase: ({ phase }) => { if (phase === "before-publish") throw injected(errno); } } }), (error: any) => {
        assert.equal(error.code, code); assert.equal(error.statusCode, statusCode); assert.ok(!error.message.includes("do-not-leak")); return true;
      });
      assert.deepEqual(await fs.readdir(root), ["input.zip"]);
    });
  });
}

for (const changeAt of ["source-inspected", "snapshot-complete", "staging-complete"] as const) {
  test(`A-PUB-11: source replacement at ${changeAt} is detected without changing the replacement`, async () => {
    await fixture(async ({ root, run }) => {
      await assert.rejects(run({ hooks: { onPhase: async ({ phase, source }) => {
        if (phase === changeAt) { await fs.unlink(source); await fs.writeFile(source, "replacement"); }
      } } }), { code: "ARCHIVE_SOURCE_CHANGED" });
      assert.equal(await fs.readFile(path.join(root, "input.zip"), "utf8"), "replacement");
      assert.deepEqual(await fs.readdir(root), ["input.zip"]);
    }, undefined, true);
  });
}

test("A-PATH-07/PUB-16: changed destination parent identity stops publication without following the replacement", async () => {
  await fixture(async ({ root }) => {
    await fs.mkdir(path.join(root, "parent"));
    await fs.rename(path.join(root, "input.zip"), path.join(root, "parent/input.zip"));
    await assert.rejects(runWorkspaceArchiveOperation({ rootAbs: root, sourceInRegion: "parent/input.zip", sourcePath: "parent/input.zip", protectedTopLevelNames: new Set(), options: { hooks: { onPhase: async ({ phase }) => {
      if (phase === "staging-complete") {
        await fs.rename(path.join(root, "parent"), path.join(root, "old-parent"));
        await fs.mkdir(path.join(root, "parent"));
        await fs.writeFile(path.join(root, "parent/sentinel"), "keep");
      }
    } } } }), { code: "ARCHIVE_CLEANUP_INCOMPLETE" });
    assert.deepEqual(await fs.readdir(path.join(root, "parent")), ["sentinel"]);
    assert.equal(await fs.readFile(path.join(root, "parent/sentinel"), "utf8"), "keep");
    assert.ok((await fs.readdir(path.join(root, "old-parent"))).some((name) => name.startsWith(".awb-extract-")));
  }, undefined, true);
});

for (const replaced of [false, true]) {
  test(`A-PATH-12: ${replaced ? "lstat-then-replaced" : "existing"} FIFO refuses promptly without a writer`, { skip: process.platform !== "linux", timeout: 3000 }, async () => {
    await fixture(async ({ root, run }) => {
      const target = path.join(root, "input.zip");
      if (!replaced) { await fs.unlink(target); await exec("mkfifo", [target]); }
      const hooks = replaced ? { onPhase: async ({ phase, source }: any) => { if (phase === "source-inspected") { await fs.unlink(source); await exec("mkfifo", [source]); } } } : undefined;
      await assert.rejects(run({ hooks }), { code: "ARCHIVE_PATH_INVALID" });
      assert.equal((await fs.lstat(target)).isFIFO(), true);
      assert.deepEqual(await fs.readdir(root), ["input.zip"]);
    }, undefined, true);
  });
}

test("A-LIMIT-01: input cap is checked before staging; source remains intact", async () => {
  await fixture(async ({ root, run }) => {
    const before = await fs.readFile(path.join(root, "input.zip"));
    await assert.rejects(run({ limits: { inputBytes: before.length - 1 } }), { code: "ARCHIVE_LIMIT_EXCEEDED" });
    assert.deepEqual(await fs.readFile(path.join(root, "input.zip")), before);
    assert.deepEqual(await fs.readdir(root), ["input.zip"]);
  });
});

test("A-LIMIT-04: a processing deadline aborts after pending IO/hook settles, then cleans output", async () => {
  await fixture(async ({ root, run }) => {
    await assert.rejects(run({ limits: { timeoutMs: 5 }, hooks: { onPhase: async ({ phase, signal }) => {
      if (phase === "published") await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    } } }), { code: "ARCHIVE_TIMEOUT" });
    assert.deepEqual(await fs.readdir(root), ["input.zip"]);
  });
});

test("A-PUB-15: process termination can leave partial output; rerun does not perform blind recovery", { timeout: 10000 }, async () => {
  await fixture(async ({ root, run }) => {
    const source = new URL("./workspace-archive-operation.ts", import.meta.url).href;
    const code = `import {runWorkspaceArchiveOperation} from ${JSON.stringify(source)}; await runWorkspaceArchiveOperation({rootAbs:process.argv[1],sourceInRegion:'input.zip',sourcePath:'input.zip',protectedTopLevelNames:new Set(),options:{hooks:{onPhase:async(e)=>{if(e.phase==='published'){process.send('published'); await new Promise(()=>{});}}}}});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, root], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr!.on("data", (data) => { stderr += data; });
    try {
      await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`child exited before publication: ${stderr}`); })]);
      child.kill("SIGTERM");
      await once(child, "exit");
      const before = (await fs.readdir(root)).sort();
      assert.ok(before.includes("dir"));
      assert.ok(before.some((name) => name.startsWith(".awb-extract-")));
      await assert.rejects(run(), { code: "ARCHIVE_TARGET_CONFLICT" });
      assert.deepEqual((await fs.readdir(root)).sort(), before);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); } }
  });
});

test("A-FMT-01/02: all four filename routes and empty archives preserve sources and clean temporaries", async () => {
  await fixture(async ({ root }) => {
    const tar = tarFixture([{ name: "executable", data: "run", mode: 0o107777 }]);
    for (const [filename, bytes] of [["a.TAR", tar], ["b.TAR.GZ", gzipSync(tar)], ["c.TGZ", gzipSync(tar)], ["empty.zip", zipFixture([])], ["empty.tar", tarFixture([])]] as const) {
      await fs.writeFile(path.join(root, filename), bytes);
      const result = await runWorkspaceArchiveOperation({ rootAbs: root, sourceInRegion: filename, sourcePath: filename, protectedTopLevelNames: new Set() });
      assert.deepEqual(await fs.readFile(path.join(root, filename)), bytes);
      if (filename.startsWith("empty")) assert.equal(result.topLevelCount, 0);
      else { assert.equal((await fs.stat(path.join(root, "executable"))).mode & 0o7777, 0o755); await fs.unlink(path.join(root, "executable")); }
      assert.ok(!(await fs.readdir(root)).some((item) => item.startsWith(".awb-extract-")));
    }
  });
});

test("A-PUB-07: replaced output inode is not deleted and its former staging alias is retained", async () => {
  await fixture(async ({ root, run }) => {
    await assert.rejects(run({ hooks: { onPhase: async ({ phase }) => {
      if (phase === "before-commit") {
        await fs.unlink(path.join(root, "dir/file"));
        await fs.writeFile(path.join(root, "dir/file"), "external replacement");
      }
    } } }), { code: "ARCHIVE_CLEANUP_INCOMPLETE" });
    assert.equal(await fs.readFile(path.join(root, "dir/file"), "utf8"), "external replacement");
  });
});

test("A-LIMIT-01/PUB-11: actual snapshot bytes remain bounded if source grows after opening", async () => {
  await fixture(async ({ root, run }) => {
    const size = (await fs.stat(path.join(root, "input.zip"))).size;
    await assert.rejects(run({ limits: { inputBytes: size + 1 }, hooks: { onPhase: async ({ phase, source }) => {
      if (phase === "source-opened") await fs.appendFile(source, Buffer.alloc(64));
    } } }), { code: "ARCHIVE_LIMIT_EXCEEDED" });
    assert.equal((await fs.stat(path.join(root, "input.zip"))).size, size + 64);
    assert.deepEqual(await fs.readdir(root), ["input.zip"]);
  }, undefined, true);
});

test("A-PUB-11: source same-inode version changes during snapshot are rejected", async () => {
  await fixture(async ({ root, run }) => {
    await assert.rejects(run({ hooks: { onPhase: async ({ phase, source }) => {
      if (phase === "snapshot-complete") await fs.utimes(source, new Date(0), new Date(1000));
    } } }), { code: "ARCHIVE_SOURCE_CHANGED" });
    assert.deepEqual(await fs.readdir(root), ["input.zip"]);
  });
});

test("A-PUB-18: rollback unlinks final before staging and refreshes the surviving alias version", async () => {
  await fixture(async ({ root, run }) => {
    const removed: string[] = [];
    await assert.rejects(run({ hooks: {
      onPhase: ({ phase }) => { if (phase === "before-commit") throw injected("EIO"); },
      beforeCleanupNode: ({ action, path: abs }) => { if (action === "unlink") removed.push(abs); }
    } }), { code: "ARCHIVE_IO_FAILED" });
    const final = removed.indexOf(path.join(root, "dir/file"));
    const staged = removed.findIndex((abs) => abs.endsWith("/payload/dir/file"));
    assert.ok(final >= 0 && staged > final);
    assert.deepEqual(await fs.readdir(root), ["input.zip"]);
  });
});

test("A-PUB-04/06: an empty directory racing directory publication is never replaced, earlier files roll back", async () => {
  await fixture(async ({ root, run }) => {
    const target = path.join(root, "z-directory");
    let concurrentIdentity: bigint | undefined;
    await assert.rejects(run({ hooks: { onPhase: async ({ phase, path: publishing }) => {
      if (phase === "before-publish" && publishing === target) {
        await fs.mkdir(target);
        concurrentIdentity = (await fs.lstat(target, { bigint: true })).ino;
      }
    } } }), { code: "ARCHIVE_TARGET_CONFLICT" });
    assert.equal((await fs.lstat(target, { bigint: true })).ino, concurrentIdentity);
    assert.deepEqual(await fs.readdir(target), []);
    await missing(path.join(root, "a-file"));
    assert.deepEqual((await fs.readdir(root)).sort(), ["input.zip", "z-directory"]);
  }, zipFixture([{ name: "a-file", data: "first" }, { name: "z-directory/file", data: "never" }]));
});

test("A-LIMIT-04/PUB-16: abort during parent checks stops new publication but does not prevent cleanup", async () => {
  await fixture(async ({ root }) => {
    const controller = new AbortController();
    const guard = await ArchiveParentGuard.open(root, "");
    const ledger = new ArchiveOwnedNodes(guard, controller.signal);
    const source = path.join(root, "private-file");
    const output = path.join(root, "output");
    const handle = await ledger.createFile(source);
    try {
      await handle.writeFile("payload");
      ledger.settleWriter(source, await handle.stat({ bigint: true }));
    } finally { await handle.close(); }
    const assertParent = guard.assert.bind(guard);
    guard.assert = async (signal) => {
      await assertParent(signal);
      controller.abort();
    };
    await assert.rejects(ledger.link(source, output), { code: "ARCHIVE_TIMEOUT" });
    await missing(output);
    assert.equal(await ledger.cleanup(false), 0);
    await missing(source);
  });
});

test("A-PUB-07/18: settling a private writer cannot bless an externally added hard-link alias", async () => {
  await fixture(async ({ root }) => {
    const ledger = new ArchiveOwnedNodes(await ArchiveParentGuard.open(root, ""));
    const source = path.join(root, "private-file");
    const external = path.join(root, "external-alias");
    const handle = await ledger.createFile(source);
    try {
      await handle.writeFile("payload");
      await fs.link(source, external);
      const stat = await handle.stat({ bigint: true });
      assert.throws(() => ledger.settleWriter(source, stat), { code: "ARCHIVE_TARGET_CHANGED" });
    } finally { await handle.close(); }
    assert.ok(await ledger.cleanup(false) > 0);
    assert.equal(await fs.readFile(external, "utf8"), "payload");
    assert.equal(await fs.readFile(source, "utf8"), "payload");
  });
});


test("M3/PUB-15: stage-only process termination permits retry without deleting old stage or unknown content", { timeout: 10000 }, async () => {
  await fixture(async ({ root, run }) => {
    const source = new URL("./workspace-archive-operation.ts", import.meta.url).href;
    const code = `import {runWorkspaceArchiveOperation} from ${JSON.stringify(source)}; await runWorkspaceArchiveOperation({rootAbs:process.argv[1],sourceInRegion:'input.zip',sourcePath:'input.zip',protectedTopLevelNames:new Set(),options:{hooks:{onPhase:async(e)=>{if(e.phase==='staging-complete'){process.send('staged'); await new Promise(()=>{});}}}}});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, root], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr!.on("data", (data) => { stderr += data; });
    try {
      const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`child exited before staging: ${stderr}`); })]);
      assert.equal(message, "staged");
      child.kill("SIGTERM"); await once(child, "exit");
      const names = await fs.readdir(root);
      const stageName = names.find((name) => name.startsWith(".awb-extract-"))!;
      assert.ok(stageName);
      assert.deepEqual(names.sort(), [stageName, "input.zip"].sort());
      const stage = path.join(root, stageName);
      const identity = await fs.lstat(stage, { bigint: true });
      await fs.writeFile(path.join(stage, "foreign-sentinel"), "do not recover blindly");
      const before = (await fs.readdir(stage)).sort();
      const result = await run();
      assert.equal(result.fileCount, 2);
      assert.equal(await fs.readFile(path.join(root, "dir/file"), "utf8"), "hello");
      assert.equal((await fs.lstat(stage, { bigint: true })).ino, identity.ino);
      assert.deepEqual((await fs.readdir(stage)).sort(), before);
      assert.equal(await fs.readFile(path.join(stage, "foreign-sentinel"), "utf8"), "do not recover blindly");
      assert.equal(await fs.readFile(path.join(stage, "payload/dir/file"), "utf8"), "hello");
      assert.deepEqual((await fs.readdir(root)).sort(), [stageName, "dir", "input.zip", "root-file"].sort());
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    }
  });
});


for (const [label, filename, unix, fileMode, expectedMode] of [
  ["DOS ZIP", "metadata.zip", false, 0o107777, 0o644],
  ["untyped Unix ZIP", "metadata.zip", true, 0o7777, 0o644],
  ["typed Unix ZIP", "metadata.zip", true, 0o107777, 0o755],
  ["TAR", "metadata.tar", true, 0o7777, 0o755],
  ["TAR.GZ", "metadata.tar.gz", true, 0o7777, 0o755],
  ["TGZ", "metadata.tgz", true, 0o7777, 0o755]
] as const) {
  test(`M4/PATH-08: ${label} uses safe final modes and current ownership/time without changing source permissions`, { skip: !process.getuid || !process.getgid }, async () => {
    await fixture(async ({ root }) => {
      const uid = process.getuid!(); const gid = process.getgid!();
      const archivedUid = uid === 123 ? 124 : 123;
      const archivedGid = gid === 456 ? 457 : 456;
      const oldZipTime = new Date("2000-01-02T03:04:06.000Z");
      const extra = Buffer.alloc(15);
      extra.writeUInt16LE(0x7875, 0); extra.writeUInt16LE(11, 2); extra[4] = 1; extra[5] = 4;
      extra.writeUInt32LE(archivedUid, 6); extra[10] = 4; extra.writeUInt32LE(archivedGid, 11);
      const tar = tarFixture([
        { name: "metadata-dir/", type: "5", mode: 0o7777, uid: archivedUid, gid: archivedGid, mtime: 1 },
        { name: "metadata-dir/file", data: "metadata", mode: fileMode, uid: archivedUid, gid: archivedGid, mtime: 1 }
      ]);
      const bytes = filename.endsWith(".zip") ? zipFixture([
        { name: "metadata-dir/", unix, mode: 0o047777, extra, mtime: oldZipTime },
        { name: "metadata-dir/file", data: "metadata", unix, mode: fileMode, extra, mtime: oldZipTime }
      ]) : filename.endsWith(".tar") ? tar : gzipSync(tar);
      const input = path.join(root, filename);
      await fs.writeFile(input, bytes);
      await fs.chmod(input, 0o640);
      await fs.utimes(input, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
      const sourceBefore = await fs.stat(input, { bigint: true });
      await runWorkspaceArchiveOperation({ rootAbs: root, sourceInRegion: filename, sourcePath: filename, protectedTopLevelNames: new Set() });
      const file = await fs.stat(path.join(root, "metadata-dir/file"));
      const directory = await fs.stat(path.join(root, "metadata-dir"));
      assert.equal(file.mode & 0o7777, expectedMode);
      assert.equal(directory.mode & 0o7777, 0o755);
      for (const actual of [file, directory]) {
        assert.equal(actual.uid, uid); assert.equal(actual.gid, gid);
        assert.notEqual(actual.uid, archivedUid); assert.notEqual(actual.gid, archivedGid);
        assert.notEqual(actual.mtimeMs, filename.endsWith(".zip") ? oldZipTime.getTime() : 1000);
      }
      const sourceAfter = await fs.stat(input, { bigint: true });
      assert.equal(sourceAfter.mode, sourceBefore.mode);
      assert.equal(sourceAfter.mtimeNs, sourceBefore.mtimeNs);
      assert.equal(sourceAfter.uid, sourceBefore.uid); assert.equal(sourceAfter.gid, sourceBefore.gid);
      assert.deepEqual(await fs.readFile(input), bytes);
      assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith(".awb-extract-")));
    });
  });
}
