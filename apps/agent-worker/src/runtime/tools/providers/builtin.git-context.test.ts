import assert from "node:assert/strict";
import { test } from "node:test";
import { GitToolInputSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { BuiltinToolProvider } from "./builtin.js";
import type { ToolListContext } from "../types.js";

function context(names: string[]): ToolListContext {
  return {
    promptContext: {
      headMessageId: null, sessionRevision: 0, system: "", messages: [], pendingTools: [],
      lastResponseTotalTokens: null, uiLocale: null, externalSkills: [], workspaceRepoNames: names,
      tools: [{ name: "git", description: "Native Git", inputSchema: GitToolInputSchema }],
    },
    profile: { agent: { tools: ["git"] } },
  } as unknown as ToolListContext;
}

test("Git descriptions refresh each list call without mutating cached static tool definitions", async () => {
  const provider = new BuiltinToolProvider();
  const ctx = context(["repo-a", 'repo"quoted', "仓库"]);
  const base = ctx.promptContext.tools[0]!;
  const first = await provider.listTools(ctx);
  assert.equal(first.length, 1);
  assert.match(first[0]!.description, /- "repo-a"/);
  assert(first[0]!.description.includes(JSON.stringify('repo"quoted')));
  assert(first[0]!.description.includes(JSON.stringify("仓库")));
  assert.equal(first[0]!.inputSchema.properties, base.inputSchema.properties);
  assert.equal((first[0]!.inputSchema as typeof GitToolInputSchema).properties.repo.type, "string");
  assert.equal((first[0]!.inputSchema as typeof GitToolInputSchema).properties.repo.enum, undefined);
  ctx.promptContext.workspaceRepoNames = ["repo-b"];
  const second = await provider.listTools(ctx);
  assert.match(second[0]!.description, /- "repo-b"/);
  assert(!second[0]!.description.includes('"repo-a"'));
  assert.equal(base.description, "Native Git");
  assert.equal(first[0]!.description.match(/Current available repo names:/g)?.length, 1);
  assert.equal(second[0]!.description.match(/Current available repo names:/g)?.length, 1);
});

test("Git list uses only dynamic registered names, filters unsafe/duplicate names and keeps >100 entries", async () => {
  const provider = new BuiltinToolProvider();
  const names = Array.from({ length: 101 }, (_, i) => `repo-${i}`);
  const ctx = context([...names, "repo-0", " ../outside", "bad\tname", "bad\u007fname", "../outside", "/private/repo"]);
  // The queued-run snapshot is intentionally irrelevant to listTools.
  Object.assign(ctx, { run: { workspaceRepoDirNames: ["stale-snapshot"] } });
  const tools = await provider.listTools(ctx);
  const description = tools[0]!.description;
  assert.equal(description.split("\n").filter((line) => line.startsWith('- "repo-')).length, 101);
  assert(description.includes('"repo-100"'));
  for (const forbidden of ["stale-snapshot", "outside", "bad", "private"]) assert(!description.includes(forbidden));
});

test("enabled Git remains visible with an explicit empty repository state and Workspace isolation", async () => {
  const provider = new BuiltinToolProvider();
  const empty = context([]);
  const tools = await provider.listTools(empty);
  assert.equal(tools[0]!.name, "git");
  assert.match(tools[0]!.description, /available repo names: none/);
  assert.equal(provider.isToolEnabled("git", empty as any), true);
  const disabled = context(["shared-name"]);
  disabled.profile.agent.tools = [];
  assert.equal(provider.isToolEnabled("git", disabled as any), false);
  const a = (await provider.listTools(context(["shared-name", "only-a"])))[0]!;
  const b = (await provider.listTools(context(["shared-name", "only-b"])))[0]!;
  assert(a.description.includes("only-a") && !a.description.includes("only-b"));
  assert(b.description.includes("only-b") && !b.description.includes("only-a"));
});
