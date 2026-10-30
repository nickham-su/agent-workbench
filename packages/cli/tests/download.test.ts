import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { downloadFile, validateDownloadPath, type DownloadFileSystem } from "../src/download.js";
import { CliError, errorObject } from "../src/errors.js";
import { HttpClient } from "../src/http.js";
import { runCli } from "../src/program.js";
import { connectionStore } from "./agent-fixture.js";
import { captureIO, cookieHeader, httpServer, temporaryDirectory } from "./helpers.js";

async function directory(t: TestContext) { const root = await temporaryDirectory("download"); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
const failure = (code: string) => Object.assign(new Error("private fixture error must not escape"), { code });
async function expectFailure(operation: Promise<unknown>, code: number, published = false) {
  await assert.rejects(operation, (error: unknown) => error instanceof CliError && error.exitCode === code && error.details.context?.published === published && !error.message.includes("private fixture"));
}
function streamHttp(bytes: Uint8Array, headers: Record<string, string> = { "content-type": "application/octet-stream" }) {
  return new HttpClient(async () => new Response(new Uint8Array(bytes), { headers }));
}

test("A-DOWNLOAD-PATH: lexical paths reject dangerous syntax locally and preserve percent data once", async () => {
  for (const path of ["", " ", "/etc", "\\\\host\\file", "C:file", "a/../b", "..", "a\\b", "-bad", ":bad", "a\u001b"]) assert.throws(() => validateDownloadPath(path), CliError);
  for (const path of [".", "reports/a b.txt", "%2e%2e/file", "a/./b"]) assert.equal(validateDownloadPath(path), path);
  for (const args of [["--path", "../x", "--output", "x"], ["--path", "."], ["--output", "x"]]) {
    const io = captureIO(); let connects = 0;
    assert.equal(await runCli(["file", "download", "-w", "w", ...args], { io: io.io, createConfigStore: () => { connects++; return connectionStore(); } }), 2);
    assert.equal(connects, 0); assert.equal(io.output(), "");
  }
});

test("A-DOWNLOAD-TYPES/SIZE: file and unknown-length ZIP stream into exclusive temp and publish exact bytes", async (t) => {
  const root = await directory(t);
  for (const format of ["file", "zip"] as const) {
    const content = Buffer.alloc(2 * 1024 * 1024, format === "file" ? 13 : 42); let fetched = 0;
    const server = await httpServer((_request, response) => {
      fetched++; response.setHeader("content-type", format === "file" ? "application/octet-stream" : "application/zip");
      response.setHeader("content-disposition", 'attachment; filename="../../do-not-use"');
      if (format === "file") response.setHeader("content-length", content.length);
      let offset = 0; const write = () => { while (offset < content.length) { const chunk = content.subarray(offset, offset + 16_384); offset += chunk.length; if (!response.write(chunk)) { response.once("drain", write); return; } } response.end(); }; write();
    }); t.after(server.close);
    const io = captureIO(); const output = join(root, `${format}.bin`);
    await downloadFile({ workspaceId: "w", path: "%2e%2e/name", output }, { io: io.io, json: true, config: connectionStore(server.origin), http: new HttpClient() });
    assert.deepEqual(await fs.readFile(output), content); assert.equal(fetched, 1);
    const summary = JSON.parse(io.output()); assert.equal(summary.data.format, format); assert.equal(summary.data.bytes, content.length); assert.equal(summary.data.published, true);
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith(".awb-download-")), []);
    if (process.platform !== "win32") assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  }
});

test("A-DOWNLOAD-EXISTING: files, directories and dangling symlinks are never replaced", async (t) => {
  const root = await directory(t); await fs.writeFile(join(root, "file"), "owned by user"); await fs.mkdir(join(root, "directory")); await fs.symlink("missing", join(root, "symlink"));
  let fetches = 0; const http = new HttpClient(async () => { fetches++; return new Response("x"); });
  for (const name of ["file", "directory", "symlink"]) {
    await expectFailure(downloadFile({ workspaceId: "w", path: ".", output: join(root, name) }, { io: captureIO().io, config: connectionStore(), http }), 7);
  }
  assert.equal(fetches, 0); assert.equal(await fs.readFile(join(root, "file"), "utf8"), "owned by user"); assert.equal(await fs.readlink(join(root, "symlink")), "missing");
});

test("A-DOWNLOAD-EXISTING/PUBLISH: concurrent target creation wins, unsupported publication never falls back", async (t) => {
  const root = await directory(t);
  for (const code of ["EEXIST", "EOPNOTSUPP", "EXDEV", "EIO"]) {
    const target = join(root, code); let links = 0;
    const disk: DownloadFileSystem = { ...fs, link: async (_source, output) => { links++; if (code === "EEXIST") await fs.writeFile(output, "racer"); throw failure(code); } };
    await expectFailure(downloadFile({ workspaceId: "w", path: "x", output: target }, { io: captureIO().io, config: connectionStore(), http: streamHttp(Buffer.from("download")), files: disk }), 7);
    assert.equal(links, 1); if (code === "EEXIST") assert.equal(await fs.readFile(target, "utf8"), "racer"); else await assert.rejects(fs.lstat(target), { code: "ENOENT" });
  }
  assert.deepEqual(await fs.readdir(root), ["EEXIST"]);
});

test("A-DOWNLOAD-HEADERS: HTTP JSON/HTML, redirect, successful error page and invalid length never publish", async (t) => {
  const root = await directory(t);
  for (const [index, [status, type, length]] of [[401, "application/json", undefined], [409, "text/html", undefined], [302, "text/html", undefined], [200, "text/html", undefined], [200, "application/json", undefined], [200, "application/octet-stream", "oops"]].entries()) {
    const output = join(root, String(index)); const io = captureIO();
    const http = new HttpClient(async (_url, options) => { assert.equal(options?.redirect, "manual"); return new Response("fixture private body", { status: Number(status), headers: { "content-type": String(type), ...(length ? { "content-length": String(length) } : {}), location: "http://other.test/" } }); });
    await expectFailure(downloadFile({ workspaceId: "w", path: "x", output }, { io: io.io, config: connectionStore(), http }), status === 401 ? 4 : 6);
    assert.equal(io.output(), ""); await assert.rejects(fs.lstat(output), { code: "ENOENT" });
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test("A-DOWNLOAD-TRUNCATE: length mismatch, broken TCP and full-body timeout leave no partial target", async (t) => {
  const root = await directory(t);
  for (const length of ["2", "20"]) await expectFailure(downloadFile({ workspaceId: "w", path: "x", output: join(root, `length${length}`) }, { io: captureIO().io, config: connectionStore(), http: streamHttp(Buffer.from("12345"), { "content-type": "application/octet-stream", "content-length": length }) }), 5);
  for (const mode of ["broken", "timeout"]) {
    const server = await httpServer((_req, res) => { res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1000" }); res.write("partial"); if (mode === "broken") setImmediate(() => res.destroy()); }); t.after(server.close);
    await expectFailure(downloadFile({ workspaceId: "w", path: "x", output: join(root, mode) }, { io: captureIO().io, config: connectionStore(server.origin), http: new HttpClient(), timeoutMs: 40 }), 5);
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test("A-DOWNLOAD-TRUNCATE/PUBLISH: open/write/sync/close failures only clean owned temp and never publish", async (t) => {
  const root = await directory(t); await fs.writeFile(join(root, ".awb-download-other.tmp"), "other process");
  for (const fault of ["open", "write", "sync", "close"] as const) {
    let links = 0; let closes = 0;
    const disk: DownloadFileSystem = { ...fs, link: async (a, b) => { links++; await fs.link(a, b); }, open: async (file, flags, mode) => {
      if (fault === "open") throw failure("EACCES"); const handle = await fs.open(file, flags, mode);
      return { write: async (buffer, offset, length) => { if (fault === "write") throw failure("ENOSPC"); return handle.write(buffer, offset, Math.min(length, 2)); }, sync: async () => { if (fault === "sync") throw failure("EIO"); await handle.sync(); }, close: async () => { closes++; if (fault === "close" && closes === 1) throw failure("EIO"); await handle.close(); } };
    } };
    await expectFailure(downloadFile({ workspaceId: "w", path: "x", output: join(root, fault) }, { io: captureIO().io, config: connectionStore(), http: streamHttp(Buffer.from("stream")), files: disk }), 7);
    assert.equal(links, 0); if (fault !== "open") assert.ok(closes >= 1);
  }
  assert.deepEqual(await fs.readdir(root), [".awb-download-other.tmp"]); assert.equal(await fs.readFile(join(root, ".awb-download-other.tmp"), "utf8"), "other process");
});

test("A-DOWNLOAD-PUBLISH: flush/close precede link, cleanup failure retains complete published target and context", async (t) => {
  for (const interrupt of [false, true]) {
    const root = await directory(t); const order: string[] = []; let cleanups = 0; const controller = new AbortController();
    const disk: DownloadFileSystem = { ...fs, open: async (file, flags, mode) => { const handle = await fs.open(file, flags, mode); return { write: (...args) => handle.write(...args), sync: async () => { order.push("sync"); await handle.sync(); }, close: async () => { order.push("close"); await handle.close(); } }; }, link: async (a, b) => { order.push("link"); await fs.link(a, b); }, unlink: async (file) => { cleanups++; if (cleanups === 1) { if (interrupt) controller.abort(); throw failure("EIO"); } await fs.unlink(file); } };
    const target = join(root, "complete"); const io = captureIO();
    await assert.rejects(downloadFile({ workspaceId: "w", path: "x", output: target }, { io: io.io, config: connectionStore(), http: streamHttp(Buffer.from("complete")), files: disk, signal: controller.signal }), (error: unknown) => {
      assert.ok(error instanceof CliError); assert.equal(error.exitCode, interrupt ? 130 : 7);
      const diagnostic = errorObject(error).error;
      assert.equal(diagnostic.category, interrupt ? "INTERRUPTED" : "PERSISTENCE");
      assert.equal(diagnostic.code, interrupt ? "INTERRUPTED" : "LOCAL_IO_FAILED");
      assert.equal(diagnostic.phase, "publish"); assert.equal(diagnostic.effect, "not_applicable");
      assert.deepEqual(diagnostic.context, { workspaceId: "w", published: true }); return true;
    });
    assert.deepEqual(order, ["sync", "close", "link"]); assert.equal(await fs.readFile(target, "utf8"), "complete"); assert.equal(io.output(), ""); assert.deepEqual(await fs.readdir(root), ["complete"]);
  }
});

test("A-DOWNLOAD-SIZE: partial writes are drained before reading next chunk and never buffer the entire body", async (t) => {
  const root = await directory(t); let writes = 0; let reads = 0; let busy = false;
  const source = new ReadableStream<Uint8Array>({ pull(controller) { assert.equal(busy, false); reads++; if (reads <= 4) controller.enqueue(new Uint8Array(10)); else controller.close(); } }, { highWaterMark: 0 });
  const disk: DownloadFileSystem = { ...fs, open: async (file, flags, mode) => { const handle = await fs.open(file, flags, mode); return { write: async (buffer, offset, length) => { busy = true; writes++; await new Promise((resolve) => setImmediate(resolve)); const result = await handle.write(buffer, offset, Math.min(3, length)); busy = false; return result; }, sync: () => handle.sync(), close: () => handle.close() }; } };
  const target = join(root, "backpressure"); await downloadFile({ workspaceId: "w", path: "x", output: target }, { io: captureIO().io, config: connectionStore(), http: new HttpClient(async () => new Response(source, { headers: { "content-type": "application/zip" } })), files: disk });
  assert.equal((await fs.stat(target)).size, 40); assert.equal(writes, 16); assert.equal(reads, 5);
});

test("A-DOWNLOAD-INTERRUPT: external abort cleans temp; EPIPE after publication preserves complete target", async (t) => {
  const root = await directory(t); const controller = new AbortController();
  const server = await httpServer((_req, res) => { res.writeHead(200, { "content-type": "application/octet-stream" }); res.write("partial"); setImmediate(() => controller.abort()); }); t.after(server.close);
  await expectFailure(downloadFile({ workspaceId: "w", path: "x", output: join(root, "aborted") }, { io: captureIO().io, config: connectionStore(server.origin), http: new HttpClient(), signal: controller.signal }), 130);
  assert.deepEqual(await fs.readdir(root), []);
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(failure("EPIPE")); } });
  const target = join(root, "published");
  await expectFailure(downloadFile({ workspaceId: "w", path: "x", output: target }, { io: { stdin: new PassThrough(), stdout, stderr: new PassThrough() }, config: connectionStore(), http: streamHttp(Buffer.from("whole")) }), 141, true);
  assert.equal(await fs.readFile(target, "utf8"), "whole");
});

test("A-SECURITY-COOKIE/download: renewal failure never publishes; primary HTTP classification remains authoritative", async (t) => {
  const root = await directory(t);
  for (const status of [200, 401]) {
    const store = connectionStore(); store.save = async () => { throw failure("EACCES"); };
    await expectFailure(downloadFile({ workspaceId: "w", path: "x", output: join(root, String(status)) }, { io: captureIO().io, config: store, http: new HttpClient(async () => new Response("fixture", { status, headers: { "content-type": "application/octet-stream", "set-cookie": cookieHeader } })) }), status === 200 ? 7 : 4);
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test("A-DOWNLOAD-SOURCE-CHANGE: streaming EOF is transport completeness, not a source snapshot guarantee", async (t) => {
  const root = await directory(t); let source = "before";
  const server = await httpServer((_req, res) => { res.setHeader("content-type", "application/zip"); res.write(source); source = "after"; setImmediate(() => res.end(source)); }); t.after(server.close);
  const io = captureIO(); const target = join(root, "changed-source.zip");
  await downloadFile({ workspaceId: "w", path: "changing-directory", output: target }, { io: io.io, json: true, config: connectionStore(server.origin), http: new HttpClient() });
  assert.equal(await fs.readFile(target, "utf8"), "beforeafter");
  const summary = JSON.parse(io.output()).data; assert.equal(summary.bytes, 11); assert.equal(summary.published, true); assert.equal("snapshot" in summary, false);
});
