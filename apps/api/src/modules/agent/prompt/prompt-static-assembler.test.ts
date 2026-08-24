import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptStaticAssembler } from "./prompt-static-assembler.js";

test("PromptStaticAssembler preserves static prompt inputs, external skill ordering, and tool visibility", async () => {
  const systemInputs: Array<Record<string, unknown>> = [];
  const assembler = new PromptStaticAssembler({
    getGlobalPrompts: () => ({ items: [{ id: "global", title: "Global", prompt: "Global prompt" }] }),
    listAgentsInstructionSources: async () => [{ filePath: "/workspace/AGENTS.md", displayPath: "AGENTS.md" }],
    readAgentsInstruction: async (source) => ({ ...source, content: "Workspace instruction" }),
    scanBuiltinSkills: async () => [{ skill: "builtin/skill", name: "Builtin" }],
    listExternalSkillRoots: async () => [
      { sourceType: "repo", repoId: "repo", rootDir: "z", rootPath: "/repo/z" },
      { sourceType: "workspace", rootDir: "a", rootPath: "/workspace/a" }
    ],
    scanExternalSkills: async (root) => [{ skill: root.sourceType === "repo" ? "repo/repo/z" : "workspace/a", name: root.rootDir }],
    warnExternalSkillScanFailure: () => assert.fail("scan should not fail"),
    getMaxSubtaskDepth: () => 2,
    listSubtaskAgents: () => [{ id: "subtask-agent", name: "Subtask", summary: "summary" }],
    buildSystem(input) {
      systemInputs.push(input);
      return "static system";
    },
    buildOutputFormatInstruction: ({ uiLocale }) => `format:${uiLocale}`,
    buildSkillsInstruction: ({ builtin, external }) => `${builtin.map((item) => item.skill).join(",")}|${external.map((item) => item.skill).join(",")}`,
    buildSubtaskDescription: (agents) => `subtasks:${agents.map((agent) => agent.id).join(",")}`,
    describeTool: (name, options) => `${name}:${options.subtaskDescription ?? ""}`,
    getToolInputSchema: (name) => ({ name })
  });

  const result = await assembler.assemble({
    workspaceId: "workspace",
    run: { subtaskDepth: 1 },
    profile: { agent: { name: "Agent", prompt: "Agent prompt", globalPromptIds: ["global"], tools: ["bash", "subtask", "bash"] } },
    uiLocale: "en-US"
  });
  assert.deepEqual(systemInputs, [{
    agentName: "Agent",
    agentPrompt: "Agent prompt",
    agentGlobalPromptIds: ["global"],
    globalPrompts: [{ id: "global", title: "Global", prompt: "Global prompt" }],
    outputFormatInstruction: "format:en-US",
    agentsInstructions: [{ filePath: "/workspace/AGENTS.md", displayPath: "AGENTS.md", content: "Workspace instruction" }],
    skillsInstruction: "builtin/skill|repo/repo/z,workspace/a"
  }]);
  assert.equal(result.systemStatic, "static system");
  assert.deepEqual(result.tools.map((tool) => tool.name), ["read", "archive_search", "archive_read", "skill", "bash", "subtask"]);
  assert.equal(result.tools.at(-1)?.description, "subtask:subtasks:subtask-agent");
  assert.deepEqual(result.externalSkillRoots, [
    { sourceType: "repo", repoId: "repo", rootDir: "z", rootPath: "/repo/z" },
    { sourceType: "workspace", rootDir: "a", rootPath: "/workspace/a" }
  ]);
});

test("PromptStaticAssembler removes subtask from static tools at the established depth limit", async () => {
  const assembler = new PromptStaticAssembler({
    getGlobalPrompts: () => ({ items: [] }),
    listAgentsInstructionSources: async () => [],
    readAgentsInstruction: async () => null,
    scanBuiltinSkills: async () => [],
    listExternalSkillRoots: async () => [],
    scanExternalSkills: async () => [],
    warnExternalSkillScanFailure: () => undefined,
    getMaxSubtaskDepth: () => 1,
    listSubtaskAgents: () => [],
    buildSystem: () => "",
    buildOutputFormatInstruction: () => "",
    buildSkillsInstruction: () => "",
    buildSubtaskDescription: () => "",
    describeTool: (name) => name,
    getToolInputSchema: () => ({})
  });

  const result = await assembler.assemble({
    workspaceId: "workspace",
    run: { subtaskDepth: 1 },
    profile: { agent: { name: "Agent", tools: ["subtask"] } },
    uiLocale: null
  });

  assert.equal(result.tools.some((tool) => tool.name === "subtask"), false);
});

test("PromptStaticAssembler removes subtask when the run depth is unknown", async () => {
  const assembler = new PromptStaticAssembler({
    getGlobalPrompts: () => ({ items: [] }),
    listAgentsInstructionSources: async () => [],
    readAgentsInstruction: async () => null,
    scanBuiltinSkills: async () => [],
    listExternalSkillRoots: async () => [],
    scanExternalSkills: async () => [],
    warnExternalSkillScanFailure: () => undefined,
    getMaxSubtaskDepth: () => 2,
    listSubtaskAgents: () => [],
    buildSystem: () => "",
    buildOutputFormatInstruction: () => "",
    buildSkillsInstruction: () => "",
    buildSubtaskDescription: () => "",
    describeTool: (name) => name,
    getToolInputSchema: () => ({})
  });

  const result = await assembler.assemble({
    workspaceId: "workspace",
    run: { subtaskDepth: null },
    profile: { agent: { name: "Agent", tools: ["subtask"] } },
    uiLocale: null
  });

  assert.equal(result.tools.some((tool) => tool.name === "subtask"), false);
});
