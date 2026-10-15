import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  CreateWorkspaceEnvironmentVariableRequestSchema, UpdateWorkspaceEnvironmentVariableRequestSchema,
  SetWorkspaceEnvironmentVariableEnabledRequestSchema, validateWorkspaceEnvironmentInput,
  validateWorkspaceEnvironmentCollection, isWorkspaceEnvironmentReservedName, workspaceEnvironmentUtf8Bytes
} from "../src/index.js";
import { WorkspaceEnvironmentResponseSchema } from "../src/internal-contracts/workspace-environment.js";

const input = (name = "TOKEN", value = "") => ({ name, value, remark: "", enabled: true });

test("environment request schemas reject unknown fields, coercion, null and empty PATCH", () => {
  assert.equal(Value.Check(CreateWorkspaceEnvironmentVariableRequestSchema, { name: "A", value: "" }), true);
  for (const request of [{ name: "A", value: "", enabled: "false" }, { name: "A", value: null }, { name: "A", value: "", extra: 1 }, null, []]) {
    assert.equal(Value.Check(CreateWorkspaceEnvironmentVariableRequestSchema, request), false);
  }
  for (const request of [{}, { value: null }, { id: "x" }, { enabled: 0 }]) assert.equal(Value.Check(UpdateWorkspaceEnvironmentVariableRequestSchema, request), false);
  assert.equal(Value.Check(UpdateWorkspaceEnvironmentVariableRequestSchema, { value: "", enabled: false, remark: "" }), true);
  assert.equal(Value.Check(SetWorkspaceEnvironmentVariableEnabledRequestSchema, { enabled: false }), true);
  assert.equal(Value.Check(SetWorkspaceEnvironmentVariableEnabledRequestSchema, { enabled: false, value: "" }), false);
});

test("environment name policy is ASCII, case-sensitive and rejects only protected control names", () => {
  for (const name of ["A", "_", "HTTP_PROXY", "http_proxy", "awb_X", "GIT_AUTHOR_NAME", "GIT_SSL_CAINFO", "__proto__", "constructor", "toString", "X".repeat(128)]) assert.equal(validateWorkspaceEnvironmentInput(input(name)), null);
  for (const name of ["", "1A", " A", "A ", "é", "A-B"]) assert.equal(validateWorkspaceEnvironmentInput(input(name))?.code, "WORKSPACE_ENV_INVALID_INPUT");
  assert.equal(validateWorkspaceEnvironmentInput(input("X".repeat(129)))?.code, "WORKSPACE_ENV_LIMIT_EXCEEDED");
  for (const name of ["AWB_", "AWB_TOKEN", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "GIT_ASKPASS_USERNAME", "GIT_ASKPASS_TOKEN_FILE", "GIT_ASKPASS_TOKEN", "SSH_ASKPASS", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
    assert.equal(isWorkspaceEnvironmentReservedName(name), true);
    assert.equal(validateWorkspaceEnvironmentInput(input(name))?.code, "WORKSPACE_ENV_RESERVED_NAME");
  }
});

test("environment values preserve literal whitespace, CR/LF, emoji and combining Unicode", () => {
  const value = "  \r\n中文😀e\u0301'$PATH'$(not-run)\\\"  ";
  const entry = { ...input("A", value), remark: " 😀e\u0301 " };
  assert.equal(validateWorkspaceEnvironmentInput(entry), null);
  assert.equal(entry.value, value);
  for (const value of ["\0", "\ud800", "\udfff", "x\ud800y", "\ud800\ud800"]) {
    assert.equal(validateWorkspaceEnvironmentInput(input("A", value))?.code, "WORKSPACE_ENV_INVALID_INPUT");
    assert.equal(validateWorkspaceEnvironmentInput({ ...input(), remark: value })?.code, "WORKSPACE_ENV_INVALID_INPUT");
  }
});

test("environment byte and UTF-16 limits allow exact boundaries", () => {
  assert.equal(workspaceEnvironmentUtf8Bytes("😀中"), 7);
  for (const value of ["x".repeat(16384), "😀".repeat(4096)]) assert.equal(validateWorkspaceEnvironmentInput(input("A", value)), null);
  assert.equal(validateWorkspaceEnvironmentInput(input("A", "😀".repeat(4096) + "x"))?.code, "WORKSPACE_ENV_LIMIT_EXCEEDED");
  assert.equal(validateWorkspaceEnvironmentInput({ ...input(), remark: "😀".repeat(80) }), null);
  assert.equal(validateWorkspaceEnvironmentInput({ ...input(), remark: "😀".repeat(80) + "x" })?.code, "WORKSPACE_ENV_LIMIT_EXCEEDED");
});

test("collection includes disabled entries in count and 64KiB encoding quota", () => {
  const entries = Array.from({ length: 128 }, (_, i) => ({ ...input(`V${i}`), enabled: false }));
  assert.equal(validateWorkspaceEnvironmentCollection(entries), null);
  assert.equal(validateWorkspaceEnvironmentCollection([...entries, input("EXTRA")])?.code, "WORKSPACE_ENV_LIMIT_EXCEEDED");
  // Four entries with one-byte names consume 4*(16381+1+1+1) = 65536 bytes.
  const bytes = ["A", "B", "C", "D"].map((name) => ({ ...input(name, "x".repeat(16381)), enabled: false }));
  assert.equal(validateWorkspaceEnvironmentCollection(bytes), null);
  bytes[0]!.value += "x";
  assert.equal(validateWorkspaceEnvironmentCollection(bytes)?.code, "WORKSPACE_ENV_LIMIT_EXCEEDED");
  entries[0]!.name = "AWB_BAD";
  assert.equal(validateWorkspaceEnvironmentCollection(entries)?.code, "WORKSPACE_ENV_RESERVED_NAME");
});

test("internal contract supports own-property special names without prototype mutation", () => {
  const env = Object.fromEntries([["__proto__", "literal"], ["constructor", "literal"], ["toString", "literal"]]);
  assert.equal(Value.Check(WorkspaceEnvironmentResponseSchema, { workspaceId: "w", env }), true);
  const roundTrip = JSON.parse(JSON.stringify(env));
  assert.equal(Object.hasOwn(roundTrip, "__proto__"), true);
  assert.equal(roundTrip.__proto__, "literal");
  assert.equal(Object.getPrototypeOf(roundTrip), Object.prototype);
});
