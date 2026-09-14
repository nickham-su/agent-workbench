import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { AgentUpdateSessionTitleRequestSchema } from "../src/contracts/agent.js";

test("AgentUpdateSessionTitleRequestSchema accepts valid bodies", () => {
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: "修复登录问题" }), true);
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: " ".repeat(1000) }), true);
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: "x" }), true);
});

test("AgentUpdateSessionTitleRequestSchema length boundary uses JavaScript string.length (UTF-16 code units)", () => {
  // 1000 个 ASCII：JS length 1000，通过
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: "x".repeat(1000) }), true);
  // 500 个 emoji（每个为 2 个 UTF-16 code unit / 1 个 code point）：
  // JS length = 1000 → 按文档合同应通过 Schema；Ajv code point 计数为 500 也会通过，两者一致。
  const fiveHundredEmoji = "😀".repeat(500);
  assert.equal(fiveHundredEmoji.length, 1000);
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: fiveHundredEmoji }), true);
  // 501 个 emoji：JS length 1002 > 1000。TypeBox Value.Check 按 JS string.length
  // 计数，与文档合同一致，直接拒绝。路由 preValidation 的 JS-length 检查作为
  // Fastify/Ajv 序列化路径上的第二道防线（Ajv 按 code point 计数，存在差异）。
  const fiveHundredOneEmoji = "😀".repeat(501);
  assert.equal(fiveHundredOneEmoji.length, 1002);
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: fiveHundredOneEmoji }), false);
});

test("AgentUpdateSessionTitleRequestSchema rejects structurally invalid bodies", () => {
  // 原始空字符串
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: "" }), false);
  // 原始长度 1001
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: "x".repeat(1001) }), false);
  // 缺字段
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a" }), false);
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { title: "x" }), false);
  // 类型错误
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: null }), false);
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: 1 }), false);
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: 1, title: "x" }), false);
  // 未知字段
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: "x", mode: "manual" }), false);
  assert.equal(Value.Check(AgentUpdateSessionTitleRequestSchema, { workspaceId: "ws-a", title: "x", manual: true }), false);
});
