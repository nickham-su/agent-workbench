import assert from "node:assert/strict";
import test from "node:test";
import { readSubtaskSourceSessionId } from "./subtaskSource.js";

test("optional source reader accepts only a nonempty own string data property", () => {
  for (const carrier of [null, undefined, "source", 3, [], {}, { sourceSessionId: null }, { sourceSessionId: 3 }, { sourceSessionId: {} }, { sourceSessionId: "" }, { sourceSessionId: " \t " }]) {
    assert.equal(readSubtaskSourceSessionId(carrier), undefined);
  }
  assert.equal(readSubtaskSourceSessionId({ sourceSessionId: " source " }), "source");
  assert.equal(readSubtaskSourceSessionId(Object.freeze({ sourceSessionId: " source " })), "source");
  assert.equal(readSubtaskSourceSessionId(Object.create({ sourceSessionId: "inherited" })), undefined);
});

test("optional source reader never invokes own or inherited accessors, including frozen carriers", () => {
  let getterCalls = 0;
  const own = Object.defineProperty({}, "sourceSessionId", { get() { getterCalls++; throw new Error("source getter must not execute"); } });
  const inherited = Object.create(own);
  assert.equal(readSubtaskSourceSessionId(own), undefined);
  assert.equal(readSubtaskSourceSessionId(inherited), undefined);
  assert.equal(readSubtaskSourceSessionId(Object.freeze(own)), undefined);
  assert.equal(getterCalls, 0);
});

test("optional source reader treats descriptor failures and revoked proxies as absent metadata", () => {
  let getterCalls = 0;
  const proxy = new Proxy({ sourceSessionId: "source" }, {
    get() { getterCalls++; throw new Error("get trap must not execute"); },
    getOwnPropertyDescriptor() { throw new Error("descriptor unavailable"); },
  });
  assert.equal(readSubtaskSourceSessionId(proxy), undefined);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.equal(readSubtaskSourceSessionId(revoked.proxy), undefined);
  assert.equal(getterCalls, 0);
});
