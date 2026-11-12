import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQueueInputSnapshotView, canonicalQueueInputJson, queueInputSnapshotHash, queueOutputReservation } from "./queue-input-budget.js";

const input = { system: "系统", messages: [
  { role: "user", content: "hello" },
  { role: "assistant", content: [{ type: "tool-call", toolName: "read", toolCallId: "call", input: { b: 2, a: 1 } }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "result" } }] },
  { role: "user", content: [{ type: "file", data: new Uint8Array([1, 2, 3]), mediaType: "image/png", filename: "x.png" }] },
], tools: [{ name: "read", description: "读取", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
  providerReplay: [{ encryptedContent: "opaque-原文" }], images: [{ stableRef: "att_1", mediaType: "image/png", byteSize: 3 }] };
const snapshotHash = (value: Parameters<typeof buildQueueInputSnapshotView>[0]) => queueInputSnapshotHash({
  view: buildQueueInputSnapshotView(value), reserve: 4096, providerId: "provider", modelId: "model",
});

test("queue input snapshot preserves the existing normalized view and binding hash", () => {
  const expected = { systemMessages: [{ role: "system", content: [{ type: "text", text: "系统" }] }], messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] }, input.messages[1], input.messages[2],
    { role: "user", content: [{ type: "budget_image", stableRef: "att_1", mediaType: "image/png", byteSize: 3 }] },
  ], tools: input.tools, providerReplay: input.providerReplay };
  assert.deepEqual(buildQueueInputSnapshotView(input), expected);
  // Captured from the former estimator using the same view, reserve and model identity.
  assert.equal(snapshotHash(input), "efc415b5fb15f61b6ea0f998c04ac4311245451b90e22f27a2320ea9ea86302b");
  assert.deepEqual(buildQueueInputSnapshotView({ ...input, system: "", providerReplay: undefined }).systemMessages, []);
  assert.deepEqual(buildQueueInputSnapshotView({ ...input, providerReplay: undefined }).providerReplay, []);
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
  for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), new Uint8Array([1]), { x: undefined }, [undefined], Array(1), { [Symbol("key")]: 1 }]) assert.throws(() => canonicalQueueInputJson(value));
  const cycle: unknown[] = []; cycle.push(cycle); assert.throws(() => canonicalQueueInputJson(cycle));
  const masked = Object.assign(Array(1), { extra: "not an index" });
  assert.throws(() => canonicalQueueInputJson(masked));
});

test("opaque replay, dynamic tools, system and tool results participate in snapshot identity", () => {
  const base = snapshotHash(input);
  for (const change of [
    { system: input.system.repeat(100) },
    { tools: [{ ...input.tools[0]!, description: "d".repeat(1000) }] },
    { tools: [{ ...input.tools[0]!, inputSchema: { ...input.tools[0]!.inputSchema, description: "schema".repeat(1000) } }] },
    { providerReplay: [{ encryptedContent: "opaque".repeat(1000) }] },
    { messages: input.messages.map((message, index) => index === 2 ? { role: "tool", content: [{ type: "tool-result", toolCallId: "call", toolName: "read", output: { type: "text", value: "changed" } }] } : message) },
  ]) assert.notEqual(snapshotHash({ ...input, ...change }), base);
  const binaryChanged = { ...input, messages: [...input.messages.slice(0, -1), { role: "user", content: [{ type: "file", data: new Uint8Array(1000), mediaType: "image/png" }] }] };
  assert.equal(snapshotHash(binaryChanged), base, "binary/base64 is replaced only by trusted fixed image metadata");
});

test("each image occurrence uses its corresponding trusted metadata and mismatches are rejected", () => {
  const images = [...input.images, { stableRef: "att_2", mediaType: "image/jpeg", byteSize: 10 }];
  const view = buildQueueInputSnapshotView({ ...input, messages: [...input.messages, { role: "user", content: [{ type: "image", image: "ignored binary" }] }], images });
  assert.deepEqual(view.messages.slice(-2), images.map(image => ({ role: "user", content: [{ type: "budget_image", ...image }] })));
  const toolMedia = buildQueueInputSnapshotView({ ...input, messages: [{ role: "tool", content: [{ type: "tool-result", output: { type: "content", value: [{ type: "media", data: "ignored binary", mediaType: "image/png" }] } }] }] });
  assert.ok(canonicalQueueInputJson(toolMedia).includes('"stableRef":"att_1"'));
  assert.throws(() => buildQueueInputSnapshotView({ ...input, images: [] }), /metadata/);
  assert.throws(() => buildQueueInputSnapshotView({ ...input, images }), /occurrences/);
  for (const image of [{ ...input.images[0]!, stableRef: "" }, ...[0, -1, 1.5, NaN].map(byteSize => ({ ...input.images[0]!, byteSize }))]) {
    assert.throws(() => buildQueueInputSnapshotView({ ...input, images: [image] }), /metadata/);
  }
  for (const image of [{ ...input.images[0]!, stableRef: "different" }, { ...input.images[0]!, byteSize: 4 }]) {
    assert.notEqual(snapshotHash({ ...input, images: [image] }), snapshotHash(input));
  }
});

test("snapshot tools contain only request fields and sort Unicode names independently of discovery order", () => {
  const tool = input.tools[0]!;
  const tools = [{ ...tool, name: "😀", source: "builtin" }, { ...tool, name: "\uE000", source: "mcp" }];
  const view = buildQueueInputSnapshotView({ ...input, tools });
  assert.deepEqual(view.tools, [{ ...tool, name: "\uE000" }, { ...tool, name: "😀" }]);
  assert.equal(snapshotHash({ ...input, tools }), snapshotHash({ ...input, tools: [...tools].reverse() }));
  assert.equal(snapshotHash({ ...input, tools: input.tools.map(tool => ({ ...tool, source: "builtin" })) }), snapshotHash(input));
});

test("snapshot hashing rejects invalid dynamic schemas instead of silently changing the request", () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const inputSchema of [undefined, NaN, Infinity, { value: undefined }, { value: Array(1) }, cycle, new Date()]) {
    assert.throws(() => snapshotHash({ ...input, tools: [{ ...input.tools[0]!, inputSchema }] }));
  }
  assert.throws(() => snapshotHash({ ...input, providerReplay: [{ encryptedContent: undefined }] }));
  assert.throws(() => buildQueueInputSnapshotView({ ...input, messages: [{ role: "user", content: new Date() }] }), /content/);
});
