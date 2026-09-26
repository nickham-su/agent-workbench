import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptStaticAssembler } from "./prompt-static-assembler.js";

test("PromptStaticAssembler preserves static prompt inputs, external skill ordering, and tool visibility", async () => {
  const systemInputs: Array<Record<string, unknown>> = [];
  const assembler = new PromptStaticAssembler({
    getGlobalPrompts: () => ({ items: [{ id: "global", title: "Global", prompt: "Global prompt" }] }),
    resolveWorkspaceContext: async () => ({
      enabledAgentsInstructions: [{ filePath: "/workspace/AGENTS.md", displayPath: "AGENTS.md", content: "Workspace instruction" }],
      availableExternalSkills: [
        { skillId: "a/review", skillDirectoryPath: "/workspace/a/review", name: "Review", description: "" },
        { skillId: "z/review", skillDirectoryPath: "/workspace/z/review", name: "Review Z", description: "" },
      ]
    }),
    scanBuiltinSkills: async () => [{ skill: "builtin/skill", name: "Builtin" }],
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
    skillsInstruction: "builtin/skill|a/review,z/review"
  }]);
  assert.equal(result.systemStatic, "static system");
  assert.deepEqual(result.tools.map((tool) => tool.name), ["read", "skill", "bash", "subtask"]);
  assert.equal(result.tools.at(-1)?.description, "subtask:subtasks:subtask-agent");
  assert.deepEqual(result.externalSkills, [
    { skillId: "a/review", skillDirectoryPath: "/workspace/a/review" },
    { skillId: "z/review", skillDirectoryPath: "/workspace/z/review" }
  ]);
});

test("PromptStaticAssembler removes subtask from static tools at the established depth limit", async () => {
  const assembler = new PromptStaticAssembler({
    getGlobalPrompts: () => ({ items: [] }),
    resolveWorkspaceContext: async () => ({ enabledAgentsInstructions: [], availableExternalSkills: [] }),
    scanBuiltinSkills: async () => [],
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
    resolveWorkspaceContext: async () => ({ enabledAgentsInstructions: [], availableExternalSkills: [] }),
    scanBuiltinSkills: async () => [],
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
