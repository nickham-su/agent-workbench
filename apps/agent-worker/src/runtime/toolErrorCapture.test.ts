import assert from "node:assert/strict";
import test from "node:test";
import {
  createToolFailureCaptureIfEnabled,
  extractPartialToolResults,
  isToolErrorStoreEnabled,
} from "./toolErrorCapture.js";

test("错误落盘开关只接受精确环境变量值 1", () => {
  const cases: Array<[string | undefined, boolean]> = [
    [undefined, false],
    ["", false],
    ["0", false],
    ["1", true],
    ["true", false],
    ["yes", false],
    [" 1 ", false],
    ["01", false],
  ];

  for (const [value, expected] of cases) {
    assert.equal(
      isToolErrorStoreEnabled({ AWB_TOOL_ERROR_STORE_ENABLED: value }),
      expected,
      `value=${String(value)}`,
    );
  }
});

test("partial result 只读取自有 data property，不执行 accessor", () => {
  let getterCalls = 0;
  const error: any = new Error("fixture");
  error.partialResult = { value: "kept" };
  Object.defineProperty(error, "result", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { ignored: true };
    },
  });
  const results = extractPartialToolResults(error, "bash");
  assert.deepEqual(results, [
    { source: "partialResult", value: { value: "kept" } },
  ]);
  assert.equal(getterCalls, 0);
});

test("subtask partial result 保留已有 data property", () => {
  const error: any = new Error("fixture");
  error.subtaskSessionId = "subtask-session";
  error.subtaskResultText = "partial output";
  assert.deepEqual(extractPartialToolResults(error, "subtask"), [
    {
      source: "subtask",
      value: {
        subtaskSessionId: "subtask-session",
        resultText: "partial output",
      },
    },
  ]);
});

test("未启用时不创建 capture", () => {
  assert.equal(
    createToolFailureCaptureIfEnabled(
      {
        workspacePath: "/tmp/unused",
        workspaceId: "ws",
        sessionId: "session",
        runId: "run",
        toolExecutionId: "execution-1",
        toolCallId: "call",
        toolName: "bash",
        toolSource: "builtin",
      },
      { command: "fixture" },
    ),
    null,
  );
});

test("subtask partial result carries valid optional source while ignoring invalid source and accessors", () => {
  for (const sourceSessionId of [undefined, null, 7, {}, "", " \t ", " source "]) {
    const error = Object.assign(new Error("subtask failed"), { subtaskSessionId: "child", sourceSessionId });
    assert.deepEqual(extractPartialToolResults(error, "subtask"), [{ source: "subtask", value: { subtaskSessionId: "child", ...(sourceSessionId === " source " ? { sourceSessionId: "source" } : {}) } }]);
  }
  let accessed = false;
  const error = Object.assign(new Error("subtask failed"), { subtaskSessionId: "child" });
  Object.defineProperty(error, "sourceSessionId", { get() { accessed = true; throw new Error("not display data"); } });
  assert.deepEqual(extractPartialToolResults(error, "subtask"), [{ source: "subtask", value: { subtaskSessionId: "child" } }]);
  assert.equal(accessed, false);
});

test("subtask partial capture retains child data when optional source descriptor lookup fails", () => {
  const original = Object.freeze(Object.assign(new Error("original failure"), { subtaskSessionId: "child", subtaskResultText: "original partial output" }));
  const proxy = new Proxy(original, { getOwnPropertyDescriptor(target, key) { if (key === "sourceSessionId") throw new Error("source descriptor unavailable"); return Reflect.getOwnPropertyDescriptor(target, key); } });
  assert.deepEqual(extractPartialToolResults(proxy, "subtask"), [{ source: "subtask", value: { subtaskSessionId: "child", resultText: "original partial output" } }]);
});
