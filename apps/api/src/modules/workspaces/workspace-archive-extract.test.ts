import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { Parser } from "tar";
import type { WorkspaceArchiveFormat } from "@agent-workbench/shared";
import { ArchiveStagingArea } from "./workspace-archive-staging.js";
import { ArchiveTarGuard, extractArchiveToStaging } from "./workspace-archive-extract.js";
import { ARCHIVE_LIMITS, archiveLimits, normalizeArchiveEntryPath, validateArchiveSourcePath, type ArchiveLimitOverrides } from "./workspace-archive-policy.js";
import { paxFixture, tarFixture, zipFixture } from "./workspace-archive-fixtures.js";

const testRoot = fileURLToPath(new URL("../../../../../.tmp-tests/", import.meta.url));
type Fixture = { root: string; input: string; payload: string; area: ArchiveStagingArea; run: (signal?: AbortSignal) => Promise<void> };
async function withArchive(data: Buffer, format: WorkspaceArchiveFormat, work: (fixture: Fixture) => Promise<void>, limits: ArchiveLimitOverrides = {}): Promise<void> {
  await fs.mkdir(testRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(testRoot, "archive-parser-"));
  const input = path.join(root, "input.archive");
  const payload = path.join(root, "payload");
  try {
    await fs.writeFile(input, data, { flag: "wx", mode: 0o600 });
    await fs.mkdir(payload, { mode: 0o700 });
    await fs.writeFile(path.join(root, "sentinel"), "unchanged", { flag: "wx" });
    const area = await ArchiveStagingArea.open(payload, limits);
    await work({ root, input, payload, area, run: (signal) => extractArchiveToStaging({ inputPath: input, format, area, signal }) });
    assert.deepEqual(await fs.readFile(input), data, "source snapshot never modified");
    assert.equal(await fs.readFile(path.join(root, "sentinel"), "utf8"), "unchanged");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function rejectsArchive(data: Buffer, format: WorkspaceArchiveFormat, code?: string, limits: ArchiveLimitOverrides = {}): Promise<void> {
  await withArchive(data, format, async ({ run, area }) => {
    await assert.rejects(run(), (error: unknown) => {
      const value = error as { code?: string; message: string };
      assert.ok(value.code?.startsWith("ARCHIVE_"));
      if (code) assert.equal(value.code, code);
      assert.ok(!value.message.includes("sentinel"));
      return true;
    });
    // Failure returns only after writes/handles settle; each registered node can be inspected now.
    const before = await Promise.all([...area.nodes.values()].map(async (node) => (await fs.lstat(area.absolutePath(node.rel), { bigint: true })).size));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const after = await Promise.all([...area.nodes.values()].map(async (node) => (await fs.lstat(area.absolutePath(node.rel), { bigint: true })).size));
    assert.deepEqual(after, before);
  }, limits);
}

for (const format of ["zip", "tar", "tar-gzip"] as const) {
  test(`A-FMT-01: ${format} preserves hierarchy, files, empty nodes and safe permissions`, async () => {
    const entries = [{ name: "folder/a.txt", data: "hello" }, { name: ".env.example", data: "safe" }, { name: "empty" }, { name: "empty-dir/", type: "5", mode: 0o40777 }, { name: "run", data: "#!/bin/sh", mode: 0o107777 }];
    const tar = tarFixture(entries);
    const archive = format === "zip" ? zipFixture(entries.map((entry) => ({ ...entry, method: entry.name.endsWith(".txt") ? 8 : 0 }))) : format === "tar-gzip" ? gzipSync(tar) : tar;
    await withArchive(archive, format, async ({ run, area, payload }) => {
      await run();
      assert.equal(await fs.readFile(path.join(payload, "folder/a.txt"), "utf8"), "hello");
      assert.deepEqual(area.summary(), { topLevelCount: 5, fileCount: 4, directoryCount: 2, extractedBytes: 18 });
      assert.equal(area.nodes.get("folder")?.explicit, false);
      assert.equal(area.nodes.get("run")?.finalMode, 0o755);
      assert.equal(area.nodes.get(".env.example")?.finalMode, 0o644);
      assert.equal((await fs.stat(path.join(payload, "run"))).mode & 0o7777, 0o600);
      assert.equal((await fs.stat(path.join(payload, "empty-dir"))).mode & 0o7777, 0o700);
    });
  });
}

test("A-FMT-02: valid empty ZIP and TAR succeed; zero-byte and partial-zero sources fail", async () => {
  for (const [bytes, format] of [[zipFixture([]), "zip"], [tarFixture([]), "tar"], [gzipSync(tarFixture([])), "tar-gzip"]] as const) {
    await withArchive(bytes, format, async ({ run, area }) => { await run(); assert.equal(area.nodes.size, 0); });
  }
  for (const format of ["zip", "tar", "tar-gzip"] as const) await rejectsArchive(Buffer.alloc(0), format, "ARCHIVE_INVALID");
  await rejectsArchive(Buffer.alloc(512), "tar", "ARCHIVE_INVALID");
});

test("A-FMT-03: ZIP standard UTF-8, CP437 and Unicode Path extra use library decoding", async () => {
  const zip = zipFixture([
    { name: "中文-🙂", data: "u" }, { name: Buffer.from([0x82, 0x2e, 0x74, 0x78, 0x74]), data: "c" },
    { name: Buffer.from("legacy"), unicodeName: "有效Unicode", data: "e" }, { name: "ASCII", data: "a" }
  ]);
  await withArchive(zip, "zip", async ({ run, payload }) => {
    await run();
    for (const [name, value] of [["中文-🙂", "u"], ["é.txt", "c"], ["有效Unicode", "e"], ["ASCII", "a"]]) assert.equal(await fs.readFile(path.join(payload, name), "utf8"), value);
  });
});

test("A-FMT-03: malformed UTF-8 and unmarked legacy bytes follow decoder but still enforce duplicate safety", async () => {
  await withArchive(zipFixture([{ name: Buffer.from([0xff]), flags: 0x800 }, { name: Buffer.from([0xd6, 0xd0]) }]), "zip", async ({ run, area }) => {
    await run(); assert.equal(area.nodes.size, 2);
  });
  await rejectsArchive(zipFixture([{ name: Buffer.from([0xff]), flags: 0x800 }, { name: "�" }]), "zip", "ARCHIVE_ENTRY_INVALID");
});

test("A-FMT-04: bounded ZIP64 entries, stored and deflated streams", async () => {
  await withArchive(zipFixture([{ name: "small", data: "ok", zip64Size: 2n }, { name: "deflated", data: "repeat".repeat(100), method: 8 }]), "zip", async ({ run, area }) => {
    await run(); assert.equal(area.outputBytes, 602);
  });
  await rejectsArchive(zipFixture([{ name: "unsafe", zip64Size: 2n ** 53n }]), "zip", "ARCHIVE_INVALID");
  await rejectsArchive(zipFixture([{ name: "large", zip64Size: 100n, method: 8 }]), "zip", "ARCHIVE_LIMIT_EXCEEDED", { fileBytes: 99 });
});

test("A-FMT-05: CRC, declared size and truncated ZIP failures settle all writes", async () => {
  await rejectsArchive(zipFixture([{ name: "partial", data: "data", crc: 0 }]), "zip", "ARCHIVE_INVALID");
  await rejectsArchive(zipFixture([{ name: "partial", data: "data", size: 3 }]), "zip", "ARCHIVE_INVALID");
  await rejectsArchive(zipFixture([{ name: "partial", data: "data", method: 8, size: 9 }]), "zip", "ARCHIVE_INVALID");
  await rejectsArchive(zipFixture([{ name: "partial", data: "data" }]).subarray(0, 40), "zip", "ARCHIVE_INVALID");
});

test("A-FMT-06: ZIP encryption, methods, special types and directory data are refused", async () => {
  for (const entry of [{ name: "encrypted", flags: 1 }, { name: "method", method: 99 }]) await rejectsArchive(zipFixture([entry]), "zip", "ARCHIVE_FEATURE_UNSUPPORTED");
  for (const mode of [0o120777, 0o020600, 0o010600, 0o140600]) await rejectsArchive(zipFixture([{ name: "special", mode }]), "zip", "ARCHIVE_ENTRY_UNSUPPORTED");
  await rejectsArchive(zipFixture([{ name: "directory/", data: "bad", mode: 0o040755 }]), "zip", "ARCHIVE_ENTRY_INVALID");
  await rejectsArchive(zipFixture([{ name: "file/", mode: 0o100644 }]), "zip", "ARCHIVE_ENTRY_INVALID");
});

test("A-FMT-07: TAR root, normalization, implicit directories and repeated directory declarations", async () => {
  await withArchive(tarFixture([{ name: "./", type: "5" }, { name: "./a//./b", data: "v" }, { name: "a/", type: "5" }, { name: "./a//", type: "5" }]), "tar", async ({ run, area }) => {
    await run(); assert.deepEqual([...area.nodes.keys()], ["a", "a/b"]); assert.equal(area.nodes.get("a")?.explicit, true); assert.equal(area.records, 4);
  });
});

test("A-FMT-07/08: PAX final path and size, global metadata and GNU long names", async () => {
  const longName = "deep/" + "n".repeat(150);
  const tar = tarFixture([
    { name: "Global", type: "g", data: paxFixture({ uname: "ignored-owner" }) },
    { name: "Pax", type: "x", data: paxFixture({ path: "最终/文件", size: "6" }) },
    { name: "short", data: "123456", size: 1 },
    { name: "././@LongLink", type: "L", data: longName + "\0" }, { name: "short2", data: "long" }
  ]);
  await withArchive(tar, "tar", async ({ run, area, payload }) => {
    await run(); assert.equal(await fs.readFile(path.join(payload, "最终/文件"), "utf8"), "123456");
    assert.equal(await fs.readFile(path.join(payload, longName), "utf8"), "long"); assert.equal(area.outputBytes, 10);
  });
  for (const value of ["../sentinel", "safe/.GIT/config"]) await rejectsArchive(tarFixture([{ name: "pax", type: "x", data: paxFixture({ path: value }) }, { name: "safe", data: "x" }]), "tar", "ARCHIVE_ENTRY_INVALID");
});

test("A-FMT-08: PAX invalid and overflowing effective sizes fail", async () => {
  for (const size of ["-1", "9007199254740992"]) await rejectsArchive(tarFixture([{ name: "pax", type: "x", data: paxFixture({ size }) }, { name: "file", data: "x" }]), "tar", "ARCHIVE_INVALID");
});

test("A-FMT-09: TAR bad headers and truncated bodies fail; noncanonical endings inherit Parser", async () => {
  await rejectsArchive(tarFixture([{ name: "bad", badChecksum: true }]), "tar", "ARCHIVE_INVALID");
  await rejectsArchive(tarFixture([{ name: "bad", data: "x", size: 5000 }]), "tar", "ARCHIVE_INVALID");
  await withArchive(tarFixture([{ name: "file", data: "ok" }], false), "tar", async ({ run, area }) => { await run(); assert.equal(area.outputBytes, 2); });
});

test("A-FMT-10: gzip CRC, truncation, non-TAR and concatenated members", async () => {
  const good = gzipSync(tarFixture([{ name: "ok", data: "x" }]));
  const crc = Buffer.from(good); crc[crc.length - 8] ^= 1;
  await rejectsArchive(crc, "tar-gzip", "ARCHIVE_INVALID");
  await rejectsArchive(good.subarray(0, good.length - 3), "tar-gzip", "ARCHIVE_INVALID");
  await rejectsArchive(gzipSync(Buffer.from("not a TAR")), "tar-gzip", "ARCHIVE_INVALID");
  const tar = tarFixture([{ name: "split", data: "ok" }]);
  await withArchive(Buffer.concat([gzipSync(tar.subarray(0, 700)), gzipSync(tar.subarray(700))]), "tar-gzip", async ({ run, area }) => { await run(); assert.equal(area.outputBytes, 2); });
});

test("A-FMT-11/14: TAR links, special and ignored objects are not silently skipped", async () => {
  for (const type of ["1", "2", "3", "4", "6", "7", "S", "Z"]) await rejectsArchive(tarFixture([{ name: "special", type, link: ["1", "2"].includes(type) ? "target" : undefined }]), "tar", "ARCHIVE_ENTRY_UNSUPPORTED");
  for (const marker of ["GNU.sparse.map", "SCHILY.realsize", "SCHILY.filetype=sparse"]) await rejectsArchive(tarFixture([{ name: "pax", type: "x", data: paxFixture({ comment: marker }) }, { name: "ordinary", data: "x" }]), "tar", "ARCHIVE_ENTRY_UNSUPPORTED");
});

test("A-FMT-12: content mismatch fails and ZIP trailing data follows library", async () => {
  await rejectsArchive(zipFixture([{ name: "file" }]), "tar", "ARCHIVE_INVALID");
  await rejectsArchive(tarFixture([{ name: "file" }]), "zip", "ARCHIVE_INVALID");
  await rejectsArchive(Buffer.concat([zipFixture([{ name: "file", data: "x" }]), Buffer.from("trailing")]), "zip", "ARCHIVE_INVALID");
});

test("A-FMT-13: outer format and nested gzip cannot trigger Parser auto-decompression", async () => {
  const compressed = gzipSync(tarFixture([{ name: "x", data: "x" }]));
  await rejectsArchive(compressed, "tar", "ARCHIVE_INVALID");
  await rejectsArchive(gzipSync(compressed), "tar-gzip", "ARCHIVE_INVALID");
  await withArchive(tarFixture([]), "tar", async ({ area }) => {
    const guard = new ArchiveTarGuard(area);
    await assert.rejects(pipeline(Readable.from([Buffer.from([0x1f]), Buffer.from([0x8b]), Buffer.alloc(10)]), guard, new (await import("node:stream")).Writable({ write(_chunk, _encoding, callback) { callback(); } })), { code: "ARCHIVE_INVALID" });
    assert.ok(guard.bytes >= 2);
  });
});

test("A-FMT-14/A-LIMIT-03: metadata cap ignores are converted to 413 and cumulative metadata is bounded", async () => {
  await rejectsArchive(tarFixture([{ name: "pax", type: "x", data: paxFixture({ comment: "x".repeat(65_536) }) }]), "tar", "ARCHIVE_LIMIT_EXCEEDED");
  await rejectsArchive(tarFixture([{ name: "pax", type: "x", data: paxFixture({ comment: "x".repeat(100) }) }, { name: "file" }]), "tar", "ARCHIVE_LIMIT_EXCEEDED", { metadataRecordBytes: 64 });
  await rejectsArchive(zipFixture([{ name: "file", comment: Buffer.alloc(80) }]), "zip", "ARCHIVE_LIMIT_EXCEEDED", { metadataBytes: 40 });
  await rejectsArchive(zipFixture([], Buffer.alloc(80)), "zip", "ARCHIVE_LIMIT_EXCEEDED", { metadataBytes: 40 });
});

for (const name of ["../sentinel", "a/../sentinel", "/sentinel", "//host/file", "C:/file", "a\\file", "a:file", "a\0file", "a\rfile", "a\nfile", ".git/config", "a/.GIT/config"]) {
  test(`A-PATH-01/03: TAR rejects dangerous effective name ${JSON.stringify(name)}`, async () => {
    // PAX permits testing an effective NUL (the TAR fixed header itself uses NUL termination).
    const bytes = name.includes("\0") ? tarFixture([{ name: "pax", type: "x", data: paxFixture({ path: name }) }, { name: "safe" }]) : tarFixture([{ name, data: "x" }]);
    await rejectsArchive(bytes, "tar", "ARCHIVE_ENTRY_INVALID");
  });
}

test("A-PATH-02/04: root files, duplicate files, file parents and file/dir collisions fail in either order", async () => {
  for (const entries of [
    [{ name: ".", data: "" }], [{ name: "a", data: "x" }, { name: "./a", data: "x" }],
    [{ name: "a", data: "x" }, { name: "a/b", data: "x" }], [{ name: "a/b", data: "x" }, { name: "a", data: "x" }],
    [{ name: "a/", type: "5" }, { name: "a", data: "x" }], [{ name: "a", data: "x" }, { name: "a/", type: "5" }]
  ]) await rejectsArchive(tarFixture(entries), "tar", "ARCHIVE_ENTRY_INVALID");
});

test("A-PATH-05/09: Linux names remain distinct, Unicode and whitespace are not rewritten", async () => {
  const names = ["A", "a", "é", "é", " space ", ".dot"];
  await withArchive(zipFixture(names.map((name) => ({ name }))), "zip", async ({ run, payload }) => {
    await run(); assert.deepEqual((await fs.readdir(payload)).sort(), names.sort());
  });
});

test("A-PATH-06: output depth, path and UTF-8 segment exact boundaries", async () => {
  const limits = archiveLimits({ depth: 2, pathBytes: 8, segmentBytes: 4 });
  assert.equal(normalizeArchiveEntryPath("中/a", "file", limits), "中/a");
  assert.equal(normalizeArchiveEntryPath("./ab/cd", "file", limits), "ab/cd");
  for (const name of ["中中", "a/b/c", "././ab/cd"]) assert.throws(() => normalizeArchiveEntryPath(name, "file", limits), { code: "ARCHIVE_LIMIT_EXCEEDED" });
  await rejectsArchive(zipFixture([{ name: "中中" }]), "zip", "ARCHIVE_LIMIT_EXCEEDED", { segmentBytes: 4 });
});

test("A-LIMIT-01: input, declared and actual output bounds allow equality and stop excess", async () => {
  const zip = zipFixture([{ name: "file", data: "1234", method: 8 }]);
  await withArchive(zip, "zip", async ({ run }) => { await run(); }, { inputBytes: zip.length, fileBytes: 4, outputBytes: 4 });
  await rejectsArchive(zip, "zip", "ARCHIVE_LIMIT_EXCEEDED", { inputBytes: zip.length - 1 });
  await rejectsArchive(zip, "zip", "ARCHIVE_LIMIT_EXCEEDED", { fileBytes: 3 });
  await rejectsArchive(zipFixture([{ name: "a", data: "12" }, { name: "b", data: "34" }]), "zip", "ARCHIVE_LIMIT_EXCEEDED", { outputBytes: 3 });
  await rejectsArchive(gzipSync(tarFixture([{ name: "large", data: "x".repeat(6000) }])), "tar-gzip", "ARCHIVE_LIMIT_EXCEEDED", { tarStreamBytes: 1024 });
});

test("A-LIMIT-02: implicit directories, repeated records and roots count separately", async () => {
  await withArchive(tarFixture([{ name: "a/b", data: "x" }]), "tar", async ({ run, area }) => { await run(); assert.equal(area.nodes.size, 2); }, { nodes: 2, records: 1 });
  await rejectsArchive(tarFixture([{ name: "a/b", data: "x" }]), "tar", "ARCHIVE_LIMIT_EXCEEDED", { nodes: 1 });
  await rejectsArchive(tarFixture([{ name: "./", type: "5" }, { name: "./", type: "5" }]), "tar", "ARCHIVE_LIMIT_EXCEEDED", { records: 1 });
  await rejectsArchive(tarFixture([{ name: "a/", type: "5" }, { name: "./a/", type: "5" }]), "tar", "ARCHIVE_LIMIT_EXCEEDED", { records: 1 });
});

test("A-LIMIT-04: signal abort and content errors finish writes and retain an accurate cleanup ledger", async () => {
  await withArchive(tarFixture([]), "tar", async ({ area, payload }) => {
    const controller = new AbortController();
    async function* interrupted() { yield Buffer.from("first"); controller.abort(); yield Buffer.from("later"); }
    await assert.rejects(area.writeEntry({ name: "partial", kind: "file", size: 10, content: interrupted(), signal: controller.signal }), { code: "ARCHIVE_TIMEOUT" });
    assert.equal(await fs.readFile(path.join(payload, "partial"), "utf8"), "first");
    assert.equal(area.nodes.get("partial")?.stat?.size, 5n);
  });
  await withArchive(gzipSync(tarFixture([{ name: "file", data: "x".repeat(100_000) }])), "tar-gzip", async ({ run }) => {
    const signal = AbortSignal.abort();
    await assert.rejects(run(signal), { code: "ARCHIVE_TIMEOUT" });
  });
});

test("stage safety: no preexisting payload objects, symlinks, unknown additions or changed files are accepted", async () => {
  await withArchive(zipFixture([{ name: "safe", data: "x" }]), "zip", async ({ area, payload, run, root }) => {
    await run();
    await fs.writeFile(path.join(payload, "unknown"), "foreign");
    await assert.rejects(area.verify(), { code: "ARCHIVE_TARGET_CHANGED" });
    await assert.rejects(ArchiveStagingArea.open(payload), { code: "ARCHIVE_TARGET_CHANGED" });
    await fs.symlink(payload, path.join(root, "payload-link"));
    await assert.rejects(ArchiveStagingArea.open(path.join(root, "payload-link")), { code: "ARCHIVE_TARGET_CHANGED" });
  });
});

test("production limits are fixed; overrides can only reduce safe positive values", () => {
  assert.ok(Object.isFrozen(ARCHIVE_LIMITS));
  assert.equal(ARCHIVE_LIMITS.inputBytes, 512 * 1024 ** 2);
  assert.equal(ARCHIVE_LIMITS.outputBytes, 2 * 1024 ** 3);
  assert.equal(ARCHIVE_LIMITS.metadataRecordBytes, 65_536);
  assert.equal(ARCHIVE_LIMITS.timeoutMs, 120_000);
  for (const value of [0, -1, Infinity, 1.5, ARCHIVE_LIMITS.nodes + 1]) assert.throws(() => archiveLimits({ nodes: value }));
});

test("A-PATH-10/11: source canonical rules precede domain selection and have distinct byte errors", () => {
  assert.equal(validateArchiveSourcePath("repo/a.zip"), "repo/a.zip");
  assert.equal(validateArchiveSourcePath(" repo / a.zip "), " repo / a.zip ");
  for (const value of ["", "/a.zip", "./repo/a.zip", "repo//a.zip", "repo/./a.zip", "repo/../a.zip", "repo/a.zip/", "a\\b.zip", "C:a.zip", "a/.GIT/b.zip", "中".repeat(86)]) assert.throws(() => validateArchiveSourcePath(value), { code: "ARCHIVE_PATH_INVALID", statusCode: 400 });
  assert.equal(validateArchiveSourcePath("a".repeat(255)).length, 255);
  const maximum = Array(16).fill("a".repeat(255)).join("/") + "/a";
  assert.equal(Buffer.byteLength(maximum), 4097);
  assert.equal(Buffer.byteLength(maximum.slice(0, -2)), 4095);
  assert.throws(() => validateArchiveSourcePath(maximum), { code: "ARCHIVE_PATH_INVALID" });
});

test("ZIP64 EOCD, strong encryption and multi-disk archives exercise library-level rejection", async () => {
  await withArchive(zipFixture([{ name: "file", data: "ok", zip64Size: 2n }], Buffer.alloc(0), true), "zip", async ({ run, area }) => {
    await run(); assert.equal(area.outputBytes, 2);
  });
  await rejectsArchive(zipFixture([{ name: "encrypted", flags: 0x40 }]), "zip", "ARCHIVE_INVALID");
  const multi = zipFixture([]);
  multi.writeUInt16LE(1, 4);
  await rejectsArchive(multi, "zip", "ARCHIVE_INVALID");
});

test("ZIP local-header differences are not independently scanned; every output still has content CRC", async () => {
  const zip = zipFixture([{ name: "actual", data: "ok" }]);
  zip.writeUInt16LE(99, 8); // yauzl deliberately uses the central directory method.
  await withArchive(zip, "zip", async ({ run, payload }) => { await run(); assert.equal(await fs.readFile(path.join(payload, "actual"), "utf8"), "ok"); });
});

test("ZIP Unicode extra path overrides still pass through .git and traversal protection", async () => {
  for (const name of ["../sentinel", "a/.GIT/config", "a:b", "a\0b"]) {
    await rejectsArchive(zipFixture([{ name: Buffer.from("safe"), unicodeName: name }]), "zip");
  }
});

test("TAR global size plus local path produce one validated effective entry", async () => {
  await withArchive(tarFixture([
    { name: "global", type: "g", data: paxFixture({ size: "2", uname: "ignored" }) },
    { name: "local", type: "x", data: paxFixture({ path: "effective" }) },
    { name: "short", data: "ok", size: 1 }
  ]), "tar", async ({ run, payload }) => { await run(); assert.equal(await fs.readFile(path.join(payload, "effective"), "utf8"), "ok"); });
});

test("TAR OldFile and zero-size normal files work; nonintegral and textual PAX sizes fail", async () => {
  await withArchive(tarFixture([{ name: "old", type: "\0", data: "ok" }, { name: "empty" }]), "tar", async ({ run, area }) => { await run(); assert.equal(area.summary().fileCount, 2); });
  for (const size of ["2.5", "NaN", "Infinity", "wrong"]) await rejectsArchive(tarFixture([{ name: "meta", type: "x", data: paxFixture({ size }) }, { name: "file", data: "x" }]), "tar", "ARCHIVE_INVALID");
});

test("TAR metadata exact cap and cumulative observed metadata have independent limits", async () => {
  const metadata = paxFixture({ comment: "small" });
  const tar = tarFixture([{ name: "meta", type: "x", data: metadata }, { name: "file" }]);
  await withArchive(tar, "tar", async ({ run, area }) => { await run(); assert.equal(area.metadataBytes, Buffer.byteLength(metadata) + 4); }, { metadataRecordBytes: Buffer.byteLength(metadata), metadataBytes: Buffer.byteLength(metadata) + 4 });
  await rejectsArchive(tar, "tar", "ARCHIVE_LIMIT_EXCEEDED", { metadataBytes: Buffer.byteLength(metadata) + 3 });
  await rejectsArchive(Buffer.alloc(2048), "tar", "ARCHIVE_LIMIT_EXCEEDED", { tarStreamBytes: 1024 });
});

/** Observe public calls/events, never Parser's internal buffer or symbols. */
function observeTarParser(t: TestContext) {
  const observed = { eof: false, ended: false, writesAfterEof: 0, forwardedBytes: 0, maxChunk: 0 };
  const original = Parser.prototype.write;
  t.mock.method(Parser.prototype, "write", function(this: Parser, ...args: unknown[]) {
    if (observed.forwardedBytes === 0) {
      this.once("eof", () => { observed.eof = true; });
      this.once("end", () => { observed.ended = true; });
    }
    const chunk = args[0] as Buffer | string;
    if (observed.eof) observed.writesAfterEof++;
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    observed.forwardedBytes += size;
    observed.maxChunk = Math.max(observed.maxChunk, size);
    return Reflect.apply(original, this, args) as boolean;
  });
  return observed;
}

// Several entries and EOF fit in one upstream chunk: queued/paused entries must
// finish before EOF allows later chunks to be discarded. Tail stays modest;
// absence of any post-EOF write proves it cannot accumulate with longer input.
const eofEntries = Array.from({ length: 6 }, (_, i) => ({ name: `before-eof-${i}`, data: `${i}`.repeat(1024) }));
function tarWithLongTail(): Buffer {
  return Buffer.concat([tarFixture(eofEntries), Buffer.alloc(512 * 1024, 0x61)]);
}

for (const format of ["tar", "tar-gzip"] as const) {
  test(`H1: ${format} stops Parser writes after EOF but completes every queued entry`, async (t) => {
    const observed = observeTarParser(t);
    const tar = tarWithLongTail();
    await withArchive(format === "tar" ? tar : gzipSync(tar), format, async ({ run, payload, area }) => {
      await run();
      for (const entry of eofEntries) assert.equal(await fs.readFile(path.join(payload, entry.name), "utf8"), entry.data);
      assert.equal(area.summary().fileCount, eofEntries.length);
      await area.verify();
    });
    assert.equal(observed.eof, true);
    assert.equal(observed.ended, true);
    assert.equal(observed.writesAfterEof, 0);
    const chunkLimit = format === "tar" ? 64 * 1024 : 16 * 1024;
    assert.ok(observed.maxChunk <= chunkLimit);
    assert.ok(observed.forwardedBytes <= chunkLimit, "same-chunk EOF may retain only bounded tail, not the whole input");
  });

  test(`H1: ${format} long tail still exceeds TAR stream quota after Parser EOF`, async (t) => {
    const observed = observeTarParser(t);
    const tar = tarWithLongTail();
    // Leave room for bounded pipeline read-ahead while entry IO delays the
    // public EOF event, so this specifically exercises counting after EOF.
    await rejectsArchive(format === "tar" ? tar : gzipSync(tar), format, "ARCHIVE_LIMIT_EXCEEDED", { tarStreamBytes: 384 * 1024 });
    assert.equal(observed.eof, true, "quota failure occurs after valid TAR EOF");
    assert.equal(observed.writesAfterEof, 0);
  });
}

for (const [name, offset] of [["CRC", 8], ["length", 4]] as const) {
  test(`H1: gzip trailer ${name} corruption is rejected after Parser EOF and long tail`, async (t) => {
    const observed = observeTarParser(t);
    const gzip = gzipSync(tarWithLongTail());
    gzip[gzip.length - offset] ^= 1;
    await rejectsArchive(gzip, "tar-gzip", "ARCHIVE_INVALID");
    assert.equal(observed.eof, true, "complete gzip validation must continue beyond TAR EOF");
    assert.equal(observed.writesAfterEof, 0);
  });
}

test("staging content iterator applies real write backpressure and closes partial files on read failure", async () => {
  await withArchive(tarFixture([]), "tar", async ({ area, payload }) => {
    async function* chunks() {
      yield Buffer.from("first");
      assert.equal(await fs.readFile(path.join(payload, "sequential"), "utf8"), "first", "next chunk is not requested before prior write finishes");
      yield Buffer.from("second");
    }
    await area.writeEntry({ name: "sequential", kind: "file", size: 11, content: chunks() });
    assert.equal(await fs.readFile(path.join(payload, "sequential"), "utf8"), "firstsecond");
    async function* failed() { yield Buffer.from("owned"); throw new Error("test-only read failure"); }
    await assert.rejects(area.writeEntry({ name: "partial", kind: "file", size: 10, content: failed() }), { code: "ARCHIVE_IO_FAILED" });
    assert.equal(area.nodes.get("partial")?.stat?.size, 5n);
    await fs.unlink(path.join(payload, "partial")); // No pending writer can recreate it.
  });
});

test("a live TAR abort drains parser and output work rather than leaving background writes", async () => {
  await withArchive(gzipSync(tarFixture(Array.from({ length: 20 }, (_, i) => ({ name: `file-${i}`, data: "x".repeat(1000) })))), "tar-gzip", async ({ area, run, payload }) => {
    const controller = new AbortController();
    const original = area.writeEntry.bind(area);
    area.writeEntry = async (options) => { await original(options); controller.abort(); };
    await assert.rejects(run(controller.signal), { code: "ARCHIVE_TIMEOUT" });
    const names = await fs.readdir(payload);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await fs.readdir(payload), names);
  });
});

test("existing unknown payload names and symlink parents cannot be adopted as implicit directories", async () => {
  await withArchive(zipFixture([{ name: "foreign/file", data: "x" }]), "zip", async ({ run, payload, root }) => {
    const outsidePayload = path.join(root, "other");
    await fs.mkdir(outsidePayload);
    await fs.symlink(outsidePayload, path.join(payload, "foreign"));
    await assert.rejects(run(), { code: "ARCHIVE_ENTRY_INVALID" });
    assert.deepEqual(await fs.readdir(outsidePayload), []);
  });
});

test("completed staging file versions detect same-length in-place changes", async () => {
  await withArchive(zipFixture([{ name: "file", data: "old" }]), "zip", async ({ run, area, payload }) => {
    await run();
    const previous = area.nodes.get("file")!.stat!;
    await fs.writeFile(path.join(payload, "file"), "new");
    // Some local filesystems coalesce writes within one timestamp tick. Force an
    // observable version change, rather than incorrectly promising a content hash.
    const changedTime = new Date(Number(previous.mtimeNs / 1_000_000n) + 1000);
    await fs.utimes(path.join(payload, "file"), changedTime, changedTime);
    const current = await fs.lstat(path.join(payload, "file"), { bigint: true });
    assert.equal(current.ino, previous.ino); assert.equal(current.size, previous.size);
    await assert.rejects(area.verify(), { code: "ARCHIVE_TARGET_CHANGED" });
  });
});

test("raw entry path limits include normalized and pre-normalized UTF-8 lengths", () => {
  const limits = archiveLimits({ pathBytes: 8, segmentBytes: 4, depth: 2 });
  assert.equal(normalizeArchiveEntryPath("abcd/xyz", "file", limits), "abcd/xyz");
  assert.throws(() => normalizeArchiveEntryPath("abcd/xyzz", "file", limits), { code: "ARCHIVE_LIMIT_EXCEEDED" });
  const source4096 = Array(15).fill("a".repeat(255)).concat("a".repeat(254), "a").join("/");
  assert.equal(Buffer.byteLength(source4096), 4096);
  assert.equal(validateArchiveSourcePath(source4096), source4096);
  assert.throws(() => validateArchiveSourcePath(source4096 + "a"), { code: "ARCHIVE_PATH_INVALID" });
});

test("a live ZIP abort closes the random reader and does not continue lazy enumeration", async () => {
  await withArchive(zipFixture(Array.from({ length: 20 }, (_, i) => ({ name: `file-${i}`, data: "x".repeat(1000), method: 8 }))), "zip", async ({ area, run, payload }) => {
    const controller = new AbortController();
    const original = area.writeEntry.bind(area);
    area.writeEntry = async (options) => { await original(options); controller.abort(); };
    await assert.rejects(run(controller.signal), { code: "ARCHIVE_TIMEOUT" });
    const names = await fs.readdir(payload);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(await fs.readdir(payload), names);
    assert.equal(names.length, 1);
  });
});
