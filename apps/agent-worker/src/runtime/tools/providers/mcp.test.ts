import test from "node:test";
import assert from "node:assert/strict";
import { McpToolProvider } from "./mcp.js";
import type { McpManager } from "../../mcpManager.js";
import type { ToolExecutionContext } from "../types.js";

function context(allowedServerIds: string[]): ToolExecutionContext {
  return {
    profile: { agent: { mcpServers: allowedServerIds } },
    signal: new AbortController().signal,
  } as unknown as ToolExecutionContext;
}

test("MCP provider forwards the current execution's explicit authorization and signal", async () => {
  const calls: unknown[][] = [];
  const expected = { serverId: "alpha", toolName: "lookup", text: "result", raw: { value: 1 } };
  const manager = { callTool: async (...args: unknown[]) => { calls.push(args); return expected; } } as unknown as McpManager;
  const provider = new McpToolProvider(manager);
  const ctx = context(["alpha"]);
  const args = { input: 1 };
  assert.deepEqual(await provider.execute("mcp_alpha_lookup", args, ctx), expected);
  assert.deepEqual(calls, [["mcp_alpha_lookup", args, { signal: ctx.signal, allowedServerIds: ["alpha"] }]]);
});

test("MCP provider does not retain another Agent's authorization or turn an empty list into all servers", async () => {
  const authorizations: unknown[] = [];
  const manager = {
    callTool: async (_name: string, _args: unknown, options: { allowedServerIds: string[] }) => {
      authorizations.push([...options.allowedServerIds]);
      return { serverId: "fixture", toolName: "lookup", text: "", raw: {} };
    },
  } as unknown as McpManager;
  const provider = new McpToolProvider(manager);
  await provider.execute("mcp_alpha_lookup", {}, context(["alpha"]));
  await provider.execute("mcp_beta_lookup", {}, context(["beta"]));
  await provider.execute("mcp_alpha_lookup", {}, context([]));
  assert.deepEqual(authorizations, [["alpha"], ["beta"], []]);
});

test("MCP provider propagates execution failure without retrying", async () => {
  let calls = 0;
  const error = new Error("execution failed");
  const manager = { callTool: async () => { calls++; throw error; } } as unknown as McpManager;
  const provider = new McpToolProvider(manager);
  await assert.rejects(provider.execute("mcp_alpha_lookup", {}, context(["alpha"])), (actual) => actual === error);
  assert.equal(calls, 1);
});
