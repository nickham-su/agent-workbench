import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { displayBody, writeSuccess, writeText } from "../src/output.js";
import { CliError } from "../src/errors.js";
import { captureIO } from "./helpers.js";

test("A-OUTPUT-TERMINAL-SAFE: one natural text mode escapes controls and preserves body newlines", async () => {
  const text = "第一行\r\nsecond\nstandalone\r\u001b[31m\t\\\u0000\u0085";
  const human = displayBody(text);
  assert.equal(human, "第一行\nsecond\nstandalone\\r\\u001b[31m\\t\\\\\\u0000\\u0085");
  assert.equal(human.includes("\u001b"), false);
  const capture = captureIO();
  await writeSuccess(capture.io, human);
  assert.equal(capture.output(), human);
});

test("output awaits slow Writable backpressure instead of reporting success before completion", async () => {
  let completed = false;
  const stream = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { setImmediate(() => { completed = true; done(); }); } });
  const writing = writeText(stream, "x".repeat(10_000));
  assert.equal(completed, false);
  await writing;
  assert.equal(completed, true);
  assert.equal(stream.listenerCount("error"), 0);
});

test("async EPIPE is consumed and converted to safe OUTPUT_CLOSED/141", async () => {
  const stream = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error("private-write-error"), { code: "EPIPE" })); } });
  await assert.rejects(writeText(stream, "test"), (error: unknown) => error instanceof CliError && error.exitCode === 141 && error.details.code === "OUTPUT_CLOSED" && !error.message.includes("private-"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stream.listenerCount("error"), 0);
});
