import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { readHiddenToken, readStdinToken, type TokenInput } from "../src/token-input.js";
import { CliError } from "../src/errors.js";
import { captureIO } from "./helpers.js";

const inputError = (error: unknown) => error instanceof CliError && error.exitCode === 2;

function stream(buffer: Buffer | string): TokenInput {
  const input: PassThrough & TokenInput = new PassThrough();
  input.end(buffer);
  return input;
}

test("stdin accepts UTF-8 single line, removes exactly one LF/CRLF and preserves spaces and BOM", async () => {
  for (const [input, expected] of [[" test-token ", " test-token "], ["token\n", "token"], ["token\r\n", "token"], ["令牌", "令牌"], ["\uFEFFtoken", "\uFEFFtoken"], ["x".repeat(65536) + "\r\n", "x".repeat(65536)]]) {
    assert.equal(await readStdinToken(stream(input)), expected);
  }
  const input: PassThrough & TokenInput = new PassThrough();
  const pending = readStdinToken(input);
  const bytes = Buffer.from("令牌\n");
  input.write(bytes.subarray(0, 2));
  input.end(bytes.subarray(2));
  assert.equal(await pending, "令牌");
});

test("stdin rejects empty, multiline, invalid UTF-8, oversized and interactive input", async () => {
  for (const input of ["", "\n", "\r\n", "a\nb", "a\n\n", "a\rb", "x".repeat(65537), Buffer.from([0xc3, 0x28])]) {
    await assert.rejects(readStdinToken(stream(input)), inputError);
  }
  const tty = stream("token");
  tty.isTTY = true;
  await assert.rejects(readStdinToken(tty), inputError);
});

test("hidden TTY input restores raw mode and never echoes token; supports backspace", async () => {
  const capture = captureIO();
  const input: PassThrough & TokenInput = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  const modes: boolean[] = [];
  input.setRawMode = (mode) => { modes.push(mode); input.isRaw = mode; };
  capture.io.stdin = input;
  capture.io.stdout.isTTY = true;
  const pending = readHiddenToken(capture.io);
  input.write("test-secretX\u007f\r");
  assert.equal(await pending, "test-secret");
  assert.deepEqual(modes, [true, false]);
  assert.equal(capture.output(), "");
  assert.ok(!capture.diagnostic().includes("test-secret"));
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(input.isPaused(), true);
  input.destroy();
});

test("hidden input rejects non-TTY after caller chooses authentication and cancels safely", async () => {
  const capture = captureIO();
  await assert.rejects(readHiddenToken(capture.io), inputError);
  for (const cancellation of ["\u0003", "\u0004", "\u001b"]) {
    const input: PassThrough & TokenInput = new PassThrough();
    input.isTTY = true;
    input.isRaw = true;
    const modes: boolean[] = [];
    input.setRawMode = (mode) => { modes.push(mode); };
    capture.io.stdin = input;
    capture.io.stdout.isTTY = true;
    const pending = readHiddenToken(capture.io);
    input.write(`test-secret${cancellation}`);
    await assert.rejects(pending, inputError);
    assert.deepEqual(modes, [true, true]);
    assert.ok(!capture.diagnostic().includes("test-secret"));
    input.destroy();
  }
});
