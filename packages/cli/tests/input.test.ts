import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CliError } from "../src/errors.js";
import { MAX_IMAGE_BYTES, MAX_PAYLOAD_BYTES, MAX_TEXT_BYTES, detectImage, imageFormData, prepareInput, preparePayload } from "../src/input.js";
import { runCli } from "../src/program.js";
import { captureIO, temporaryDirectory } from "./helpers.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const requestId = "12345678-1234-1234-1234-123456789012";
function isInput(error: unknown): boolean { return error instanceof CliError && error.exitCode === 2 && error.details.phase === "input" && error.details.effect === "not_sent"; }

test("A-SEND-INPUT-MODES/UTF8: explicit sources, one BOM, fatal decoding, regular files and stdin TTY", async () => {
  const root = await temporaryDirectory("agent-input");
  try {
    const file = join(root, "request.txt");
    await fs.writeFile(file, Buffer.from("\uFEFF你好\n正文"));
    assert.equal((await prepareInput({ promptFile: file }, captureIO().io.stdin)).text, "你好\n正文");
    assert.equal((await prepareInput({ stdin: true }, captureIO("\uFEFF\uFEFF保留第二个").io.stdin)).text, "\uFEFF保留第二个");
    assert.equal((await prepareInput({ prompt: "--workspace" }, captureIO().io.stdin)).text, "--workspace");
    const noRead = captureIO();
    noRead.io.stdin.read = () => { throw Error("must not read"); };
    assert.equal((await prepareInput({ prompt: "visible" }, noRead.io.stdin)).text, "visible");
    await fs.symlink(file, join(root, "link.txt"));
    assert.equal((await prepareInput({ promptFile: join(root, "link.txt") }, captureIO().io.stdin)).text, "你好\n正文");
    await fs.writeFile(file, Buffer.from([0xc3, 0x28]));
    await assert.rejects(prepareInput({ promptFile: file }, captureIO().io.stdin), isInput);
    await assert.rejects(prepareInput({ promptFile: root }, captureIO().io.stdin), isInput);
    await assert.rejects(prepareInput({ promptFile: join(root, "missing-private-path") }, captureIO().io.stdin), isInput);
    const tty = captureIO("text"); tty.io.stdin.isTTY = true;
    await assert.rejects(prepareInput({ stdin: true }, tty.io.stdin), isInput);
    for (const options of [{}, { prompt: " \n" }, { prompt: "a", stdin: true }, { prompt: "a", promptFile: file }, { prompt: "\ud800" }]) await assert.rejects(prepareInput(options, captureIO().io.stdin), isInput);
    if (process.platform !== "win32") {
      const fifo = join(root, "fifo");
      await promisify(execFile)("mkfifo", [fifo]);
      await assert.rejects(prepareInput({ promptFile: fifo }, captureIO().io.stdin), isInput);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("A-SEND-UTF8/TEXT-LIMIT: stream/source byte bounds and final serialized UTF-8 exact boundaries", async () => {
  const exact = "x".repeat(MAX_TEXT_BYTES);
  assert.equal((await prepareInput({ prompt: exact }, captureIO().io.stdin)).text.length, MAX_TEXT_BYTES);
  await assert.rejects(prepareInput({ prompt: exact + "x" }, captureIO().io.stdin), isInput);
  await assert.rejects(prepareInput({ stdin: true }, captureIO(exact + "x").io.stdin), isInput);
  // An actual invalid-byte stream must fail rather than emit replacement characters.
  const { PassThrough } = await import("node:stream");
  const stream = new PassThrough(); stream.end(Buffer.from([0xff]));
  await assert.rejects(prepareInput({ stdin: true }, stream), isInput);
  for (const images of [[], [{ bytes: png, mediaType: "image/png" as const, filename: "x.png" }]]) {
    const maximum = images.length ? MAX_PAYLOAD_BYTES : MAX_TEXT_BYTES;
    const overhead = Buffer.byteLength(JSON.stringify({ workspaceId: "w", clientRequestId: requestId, agentId: "a", text: "" }));
    const input = { text: "x".repeat(maximum - overhead), images };
    const payload = preparePayload(input, "w", "a", requestId);
    assert.equal(Buffer.byteLength(JSON.stringify(payload)), maximum);
    assert.throws(() => preparePayload({ ...input, text: input.text + "x" }, "w", "a", requestId), isInput);
    assert.throws(() => preparePayload({ ...input, text: "\u0001".repeat(Math.ceil(maximum / 6)) }, "w", "a", requestId), isInput);
    assert.throws(() => preparePayload({ ...input, text: "中".repeat(Math.ceil(maximum / 3)) }, "w", "a", requestId), isInput);
  }
});

test("A-SEND-IMAGE-LIMIT/SIGNATURE: count, per-image, total bytes, repeated files and detected MIME", async () => {
  const root = await temporaryDirectory("agent-images");
  try {
    const image = join(root, "misleading.svg");
    await fs.writeFile(image, png);
    assert.equal((await prepareInput({ image: [image] }, captureIO().io.stdin)).images[0].mediaType, "image/png");
    assert.equal((await prepareInput({ image: [image, image, image, image] }, captureIO().io.stdin)).images.length, 4);
    await assert.rejects(prepareInput({ image: Array(5).fill(image) }, captureIO().io.stdin), isInput);
    const full = Buffer.alloc(MAX_IMAGE_BYTES); png.copy(full);
    await fs.writeFile(image, full);
    assert.equal((await prepareInput({ image: [image, image] }, captureIO().io.stdin)).images.length, 2);
    const tiny = join(root, "tiny.png"); await fs.writeFile(tiny, png);
    await assert.rejects(prepareInput({ image: [image, image, tiny] }, captureIO().io.stdin), isInput);
    await fs.appendFile(image, Buffer.from([0]));
    await assert.rejects(prepareInput({ image: [image] }, captureIO().io.stdin), isInput);
    for (const bytes of [Buffer.alloc(0), Buffer.from("<svg/>"), Buffer.from("PNG")]) {
      await fs.writeFile(image, bytes);
      await assert.rejects(prepareInput({ image: [image] }, captureIO().io.stdin), isInput);
    }
    assert.equal(detectImage(Buffer.from([255, 216, 255])), "image/jpeg");
    assert.equal(detectImage(Buffer.from("RIFF0000WEBP")), "image/webp");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("A-SEND-IMAGE-SIGNATURE/MULTIPART: retained bytes, payload/images ordering and basename-only metadata", async () => {
  const root = await temporaryDirectory("agent-retained-image");
  try {
    const path = join(root, "first.png"); await fs.writeFile(path, png);
    const input = await prepareInput({ image: [path, path] }, captureIO().io.stdin);
    await fs.writeFile(path, "changed after validation");
    const payload = preparePayload(input, "w", "a", requestId);
    const form = imageFormData(input, payload);
    assert.deepEqual([...form.keys()], ["payload", "images", "images"]);
    assert.equal(JSON.parse(form.get("payload") as string).text, "");
    for (const item of form.getAll("images") as File[]) {
      assert.equal(item.name, "first.png"); assert.equal(item.type, "image/png");
      assert.deepEqual(Buffer.from(await item.arrayBuffer()), png);
    }
    assert.equal(JSON.stringify([...form.entries()]).includes(root), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("A-HELP-PRIORITY / local input failures precede configuration and HTTP", async () => {
  for (const args of [
    ["--prompt", ""], ["--prompt", "a", "--stdin"], ["--prompt-file", "private-nonexistent-path"],
    ["--image", "private-nonexistent-path"], ["--prompt", "\u0001".repeat(200_000)]
  ]) {
    const capture = captureIO(); let factories = 0; let requests = 0;
    const code = await runCli(["session", "send", "-w", "w", ...args, "--json"], { io: capture.io,
      createConfigStore: () => { factories++; throw Error("should not load"); }, http: { request: async () => { requests++; throw Error("should not dispatch"); } } });
    assert.equal(code, 2); assert.equal(factories, 0); assert.equal(requests, 0); assert.equal(capture.output(), "");
    assert.equal(capture.diagnostic().includes("private-nonexistent-path"), false);
    assert.equal(JSON.parse(capture.diagnostic()).error.phase, "input");
  }
  const capture = captureIO(); capture.io.stdin.read = () => { throw Error("must not read"); };
  assert.equal(await runCli(["session", "send", "-h", "--stdin", "--image", "missing", "--json"], { io: capture.io, createConfigStore: () => { throw Error("must not construct"); } }), 0);
  assert.match(capture.output(), /纯图/);
});
