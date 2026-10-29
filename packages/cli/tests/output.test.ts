import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { displayBody, writeEvent, writeSuccess, writeText } from "../src/output.js";
import { CliError } from "../src/errors.js";
import { captureIO } from "./helpers.js";

test("A-OUTPUT-TERMINAL-SAFE: normal body newlines survive, controls escape, JSON/JSONL stay original", async () => {
  const text = "第一行\r\nsecond\nstandalone\r\u001b[31m\t\\\u0000\u0085";
  const human = displayBody(text);
  assert.equal(human, "第一行\nsecond\nstandalone\\r\\u001b[31m\\t\\\\\\u0000\\u0085");
  assert.equal(human.includes("\u001b"), false);
  const capture = captureIO();
  await writeSuccess(capture.io, true, "sample", { text }, human);
  assert.equal(JSON.parse(capture.output()).data.text, text);
  const events = captureIO();
  await writeEvent(events.io, { type: "message", message: { parts: [{ type: "text", text }] } });
  assert.equal(JSON.parse(events.output()).message.parts[0].text, text);
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
