import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalQueueInputJson, estimateQueueInput, queueOutputReservation } from "./queue-input-budget.js";

const input = { contextWindowTokens: 100_000, maxOutputTokens: 4096, system: "系统", messages: [
  { role: "user", content: "hello" },
  { role: "assistant", content: [{ type: "tool-call", toolName: "read", toolCallId: "call", input: { b: 2, a: 1 } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "result" } }] },
  { role: "user", content: [{ type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png", filename: "x.png" }] },
], tools: [{ name: "read", description: "读取", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
  providerReplay: [{ encryptedContent: "opaque-原文" }], images: [{ stableRef: "att_1", mediaType: "image/png", byteSize: 3 }] };

test("queue-input-estimator-v1 golden view counts exact bytes/messages/parts/calls/results/image occurrences", () => {
  const expected = { systemMessages: [{ role: "system", content: [{ type: "text", text: "系统" }] }], messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] }, input.messages[1], input.messages[2],
    { role: "user", content: [{ type: "budget_image", stableRef: "att_1", mediaType: "image/png", byteSize: 3 }] },
  ], tools: input.tools, providerReplay: input.providerReplay };
  const result = estimateQueueInput(input);
  const B = Buffer.byteLength(canonicalQueueInputJson(expected));
  const E = Math.ceil(1.25 * (Math.ceil(B / 3) + 8 * 5 + 4 * 5 + 8 + 8 + 8192 + 256));
  assert.deepEqual(result.view, expected);
  assert.deepEqual([result.W, result.R, result.B, result.M, result.P, result.Tcall, result.Tresult, result.I, result.E, result.C], [100_000, 4096, B, 5, 5, 1, 1, 1, E, 90_000]);
  assert.equal(result.fits, true);
});

test("output reservation has explicit aiSdk priority and invalid W/R never gets a guessed fallback", () => {
  assert.equal(queueOutputReservation(100_000, undefined), 4096); assert.equal(queueOutputReservation(100, undefined), 25);
  assert.equal(queueOutputReservation(100, 20, 10), 20); assert.equal(queueOutputReservation(100, undefined, 10), 10);
  for (const W of [undefined, NaN, Infinity, 0, -1, 1.5, "100"]) assert.throws(() => queueOutputReservation(W, 1), /budget_configuration_invalid/);
  for (const R of [null, NaN, Infinity, 0, -1, 1.5, 100, 101, "10"]) assert.throws(() => queueOutputReservation(100, R, 10), /budget_configuration_invalid/);
});

test("canonical JSON sorts Unicode/numeric keys, preserves array order and rejects non-JSON values", () => {
  assert.equal(canonicalQueueInputJson({ z: 1, a: [2, 1], "10": 10, "2": 2 }), '{"10":10,"2":2,"a":[2,1],"z":1}');
  assert.equal(canonicalQueueInputJson({ "😀": 1, "\uE000": 2 }), '{"":2,"😀":1}');
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), new Uint8Array([1]), { x: undefined }, [undefined], Array(1)]) assert.throws(() => canonicalQueueInputJson(value));
  const cycle: unknown[] = []; cycle.push(cycle); assert.throws(() => canonicalQueueInputJson(cycle));
});

test("opaque replay and dynamic schema/description/system/result costs are not replaced by debug placeholders", () => {
  const base = estimateQueueInput(input);
  for (const change of [
    { system: input.system.repeat(100) },
    { tools: [{ ...input.tools[0]!, description: "d".repeat(1000) }] },
    { tools: [{ ...input.tools[0]!, inputSchema: { ...input.tools[0]!.inputSchema, description: "schema".repeat(1000) } }] },
    { providerReplay: [{ encryptedContent: "opaque".repeat(1000) }] },
  ]) assert.ok(estimateQueueInput({ ...input, ...change }).B > base.B);
  const binaryChanged = estimateQueueInput({ ...input, messages: [...input.messages.slice(0, -1), { role: "user", content: [{ type: "file", data: new Uint8Array(1000), mediaType: "image/png" }] }] });
  assert.equal(binaryChanged.B, base.B, "binary/base64 is replaced only by trusted fixed image metadata");
});

test("each real image occurrence costs 8192 and admission is inclusive exactly at the budget boundary", () => {
  const base = estimateQueueInput(input);
  const double = estimateQueueInput({ ...input, messages: [...input.messages, input.messages[3]!], images: [...input.images, input.images[0]!] });
  assert.equal(double.I, 2); assert.ok(double.E - base.E >= 8192);
  const C = base.E + base.R;
  const W = Math.ceil(C / 0.9);
  assert.equal(estimateQueueInput({ ...input, contextWindowTokens: W }).fits, true);
  assert.equal(estimateQueueInput({ ...input, contextWindowTokens: Math.ceil((C - 1) / 0.9) }).fits, false);
  assert.throws(() => estimateQueueInput({ ...input, images: [] }), /metadata/);
});


test("canonical rejects sparse arrays masked by extra keys and budget tools contain only real schema fields", () => {
  const masked = Object.assign(Array(1), { extra: "not an index" });
  assert.throws(() => canonicalQueueInputJson(masked));
  assert.deepEqual(estimateQueueInput({ ...input, tools: input.tools.map(tool => ({ ...tool, source: "builtin" })) }).view.tools, input.tools);
});
