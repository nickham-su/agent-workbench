import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  safeErrorSummaryForTest,
  sanitizeForDebugDumpForTest,
  writeAssistantDebugRecordForTest,
} from "./runner.js";

const SENTINEL = "opaque-encrypted-replay-SENTINEL-9e71";

test("replay 敏感字段在结构化对象和 JSON 字符串中均脱敏", () => {
  const sanitized = sanitizeForDebugDumpForTest({
    encrypted_content: SENTINEL,
    nested: {
      reasoningEncryptedContent: SENTINEL,
      bareEnvelope: { item: { encryptedContent: SENTINEL } },
      providerReplay: { item: { encryptedContent: SENTINEL } },
      provider_replay_json: JSON.stringify({ encrypted_content: SENTINEL }),
    },
    serialized: JSON.stringify({ encrypted_content: SENTINEL, keep: "diagnostic" }),
    serializedEnvelope: JSON.stringify({ item: { encryptedContent: SENTINEL }, keep: "envelope-diagnostic" }),
    keep: { status: 400, code: "context_length_exceeded" },
  });
  const text = JSON.stringify(sanitized);
  assert.doesNotMatch(text, new RegExp(SENTINEL));
  assert.match(text, /diagnostic/);
  assert.match(text, /context_length_exceeded/);
  assert.match(text, /\*\*\*/);
});

test("Error 安全摘要不包含 response body、raw 或密文", () => {
  const error = Object.assign(new Error(`provider failed ${SENTINEL}`), {
    statusCode: 400,
    code: "context_length_exceeded",
    responseBody: JSON.stringify({ encrypted_content: SENTINEL }),
    rawValue: { response: { output: [{ encrypted_content: SENTINEL }] } },
    providerMetadata: { openai: { reasoningEncryptedContent: SENTINEL } },
  });
  const summary = safeErrorSummaryForTest(error);
  assert.doesNotMatch(summary, new RegExp(SENTINEL));
  assert.match(summary, /Error/);
  assert.match(summary, /status=400/);
  assert.match(summary, /context_length_exceeded/);
});

test("assistant item debug log 保留诊断结构但不泄漏 replay 或 raw payload", async () => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "awb-replay-log-"));
  try {
    await writeAssistantDebugRecordForTest({
      logger: { warn() {} },
      workspacePath,
      recordId: "assistant-security",
      input: {
        status: "failed",
        request: {
          providerOptions: { openai: { reasoningEncryptedContent: SENTINEL } },
          messages: [{ role: "assistant", providerReplay: { item: { encryptedContent: SENTINEL } } }],
          bareEnvelope: { item: { encryptedContent: SENTINEL } },
        },
        response: {
          error: JSON.stringify({ encrypted_content: SENTINEL, code: "context_length_exceeded" }),
          rawValue: { response: { output: [{ encrypted_content: SENTINEL }] } },
          providerMetadata: { openai: { reasoningEncryptedContent: SENTINEL } },
        },
      },
    });
    const file = path.join(workspacePath, ".debug", "agent_message_logs", "assistant", "assistant-security.log");
    const text = await fs.readFile(file, "utf8");
    assert.doesNotMatch(text, new RegExp(SENTINEL));
    assert.match(text, /failed/);
    assert.match(text, /error-content-not-logged/);
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
});
