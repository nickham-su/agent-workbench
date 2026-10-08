import assert from "node:assert/strict";
import test from "node:test";
import {
  copyTextWithExecCommand,
  formatAgentHeaderTokens,
  resolveCycledAgentId,
  shouldRunAgentElapsedTimer,
} from "./agentClientHeader.js";

test("resolveCycledAgentId 循环切换 Agent 并处理空或单一选项", () => {
  const options = [{ value: "a" }, { value: "b" }, { value: "c" }];
  assert.equal(resolveCycledAgentId(options, "a", 1), "b");
  assert.equal(resolveCycledAgentId(options, "a", -1), "c");
  assert.equal(resolveCycledAgentId(options, "c", 1), "a");
  assert.equal(resolveCycledAgentId([], "a", 1), null);
  assert.equal(resolveCycledAgentId([{ value: "a" }], "a", 1), null);
});

test("formatAgentHeaderTokens 只使用后端权威 ratio，不依赖当前 UI 模型", () => {
  assert.equal(formatAgentHeaderTokens(32_000, 0.25, "en-US"), "32,000 tokens (25%)");
  assert.equal(formatAgentHeaderTokens(32_000, null, "en-US"), "32,000 tokens");
  assert.equal(formatAgentHeaderTokens(0, 0, "en-US"), "");
});

test("copyTextWithExecCommand 聚焦并选择临时 textarea，执行后始终清理", () => {
  const calls: string[] = [];
  let removed = false;
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    focus() { calls.push("focus"); },
    select() { calls.push("select"); },
    remove() { removed = true; },
  };
  const fakeDocument = {
    createElement(tagName: string) {
      assert.equal(tagName, "textarea");
      return textarea;
    },
    body: { appendChild(element: unknown) { assert.equal(element, textarea); } },
    execCommand(command: string) {
      calls.push(command);
      return true;
    },
  } as unknown as Document;

  assert.equal(copyTextWithExecCommand("session-a", fakeDocument), true);
  assert.equal(textarea.value, "session-a");
  assert.deepEqual(calls, ["focus", "select", "copy"]);
  assert.equal(removed, true);
});

test("copyTextWithExecCommand 即使 copy 抛错也移除临时 textarea", () => {
  let removed = false;
  const textarea = {
    value: "",
    style: {},
    setAttribute() {},
    focus() {},
    select() {},
    remove() { removed = true; },
  };
  const fakeDocument = {
    createElement: () => textarea,
    body: { appendChild() {} },
    execCommand() { throw new Error("copy failed"); },
  } as unknown as Document;

  assert.throws(() => copyTextWithExecCommand("session-a", fakeDocument), /copy failed/);
  assert.equal(removed, true);
});

test("shouldRunAgentElapsedTimer 仅允许 active running 且起点有效时计时", () => {
  assert.equal(shouldRunAgentElapsedTimer({ active: true, status: "running", activeRunStartedAt: 1 }), true);
  assert.equal(shouldRunAgentElapsedTimer({ active: false, status: "running", activeRunStartedAt: 1 }), false);
  assert.equal(shouldRunAgentElapsedTimer({ active: true, status: "idle", activeRunStartedAt: 1 }), false);
  assert.equal(shouldRunAgentElapsedTimer({ active: true, status: "running", activeRunStartedAt: null }), false);
  assert.equal(shouldRunAgentElapsedTimer({ active: true, status: "running", activeRunStartedAt: Number.NaN }), false);
});
