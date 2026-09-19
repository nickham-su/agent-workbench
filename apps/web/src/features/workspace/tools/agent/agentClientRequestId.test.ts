import assert from "node:assert/strict";
import test from "node:test";
import { createAgentClientRequestId } from "./agentClientRequestId";

test("优先使用 crypto.randomUUID", () => {
  assert.equal(
    createAgentClientRequestId({ randomUUID: () => "native-uuid" }),
    "native-uuid",
  );
});

test("randomUUID 不可用时使用 getRandomValues 生成 UUID v4", () => {
  const id = createAgentClientRequestId({
    getRandomValues: ((bytes: Uint8Array) => {
      bytes.set([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
      ]);
      return bytes;
    }) as Crypto["getRandomValues"],
  });
  assert.equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
});

test("Web Crypto 不可用时仍能生成不同的非空请求 ID", () => {
  const first = createAgentClientRequestId({});
  const second = createAgentClientRequestId({});
  assert.ok(first.length > 0);
  assert.ok(second.length > 0);
  assert.notEqual(first, second);
});
