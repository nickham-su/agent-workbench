import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createP4Fixture } from "./p4-fixture.helpers.js";
import { getSettingJson } from "../../settings/settings.store.js";
import { resolveWorkspaceContextCandidates, resolveAvailableExternalSkills, resolvePromptWorkspaceContext } from "../../workspaces/workspace-context.service.js";
import { createSession } from "./context-writeback.helpers.js";
import { createMessageRunRecord, appendMessage, getMessageSessionHead } from "../agent-message.store.js";
import { newSortableId } from "../../../utils/ids.js";

type RunSkillTool = (input: {
  workspacePath: string;
  repoRoot: string;
  skillId: string;
  externalSkills: Array<{ skillId: string; skillDirectoryPath: string }>;
}) => Promise<{ content: string }>;

// Integration-only test seam: load the actual Worker implementation through tsx without
// adding a production API -> Worker source dependency or requiring a prebuilt Worker dist.
async function loadWorkerSkillTool(): Promise<RunSkillTool> {
  const workerModule = new URL("../../../../../agent-worker/src/runtime/fileTools.ts", import.meta.url);
  const module = await import(workerModule.href) as { runSkillTool: RunSkillTool };
  return module.runSkillTool;
}

async function requestNewRunContext(fixture: Awaited<ReturnType<typeof createP4Fixture>>) {
  const session = await createSession(fixture.app, fixture.workspaceId);
  const runId = newSortableId("run");
  const now = Date.now();
  const head = getMessageSessionHead(fixture.db, { workspaceId: fixture.workspaceId, sessionId: session.id });
  assert.ok(head);
  const triggerMessageId = newSortableId("msg");
  appendMessage(fixture.db, {
    id: triggerMessageId, workspaceId: fixture.workspaceId, sessionId: session.id,
    expectedHeadMessageId: head.headMessageId, expectedRevision: head.revision,
    type: "user", status: "completed", originRunId: null,
    parts: [{ id: newSortableId("part"), position: 0, type: "text", text: "trigger" }], createdAt: now,
  });
  createMessageRunRecord(fixture.db, {
    runId, workspaceId: fixture.workspaceId, sessionId: session.id,
    triggerMessageId, agentId: "default", providerId: "ppchat", modelId: "gpt-5.2",
    status: "running", createdAt: now,
  });
  const changed = fixture.db.prepare(`
    update session_run_state set status = 'running', active_run_id = @runId, updated_at = @now
    where workspace_id = @workspaceId and session_id = @sessionId
  `).run({ workspaceId: fixture.workspaceId, sessionId: session.id, runId, now });
  assert.equal(changed.changes, 1);
  const response = await fixture.app.inject({
    method: "POST", url: "/api/internal/agent/prompt-context",
    headers: { "x-awb-agent-internal-token": fixture.internalToken },
    payload: { workspaceId: fixture.workspaceId, sessionId: session.id, runId },
  });
  return response;
}

async function newRunContext(fixture: Awaited<ReturnType<typeof createP4Fixture>>) {
  const response = await requestNewRunContext(fixture);
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as {
    system: string;
    tools: Array<{ name: string; description: string; inputSchema: { properties?: Record<string, { description?: string }> } }>;
    externalSkills: Array<{ skillId: string; skillDirectoryPath: string }>;
  };
}

async function createSkill(root: string, relative: string, content = "---\nname: Review\n---\nInstructions") {
  const directory = path.join(root, relative);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), content);
}

test("context-files detect and atomic PUT use one current workspace snapshot", async (t) => {
  const fixture = await createP4Fixture(t);
  await createSkill(fixture.workspacePath, "repo/.claude/skills/review");
  await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "global");
  const base = `/api/workspaces/${fixture.workspaceId}`;
  const detect = await fixture.app.inject({ method: "GET", url: `${base}/context-files/detect` });
  assert.equal(detect.statusCode, 200, detect.body);
  assert.deepEqual(detect.json().skills.map((item: { skillId: string }) => item.skillId), ["repo/.claude/skills/review"]);
  assert.deepEqual(detect.json().agentsInstructions, [{ path: "AGENTS.md", enabled: false }]);
  const request = { enabledSkillIds: ["repo/.claude/skills/review"], enabledAgentsInstructionPaths: ["AGENTS.md"] };
  const saved = await fixture.app.inject({ method: "PUT", url: `${base}/context-files/settings`, payload: request });
  assert.equal(saved.statusCode, 200, saved.body);
  const top = await fixture.app.inject({ method: "GET", url: `${base}/skills/top-level` });
  assert.equal(top.statusCode, 200, top.body);
  assert.equal(top.json().items.find((item: { id: string }) => item.id === request.enabledSkillIds[0])?.name, "Review");
  const invalid = await fixture.app.inject({ method: "PUT", url: `${base}/context-files/settings`, payload: { ...request, enabledSkillIds: ["not-found"] } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, "INVALID_CONTEXT_SELECTION");
  const duplicate = await fixture.app.inject({ method: "PUT", url: `${base}/context-files/settings`, payload: { ...request, enabledAgentsInstructionPaths: ["AGENTS.md", "AGENTS.md"] } });
  assert.equal(duplicate.statusCode, 400);
  assert.deepEqual((await fixture.app.inject({ method: "GET", url: `${base}/context-files/settings` })).json().enabledSkillIds, request.enabledSkillIds);
  assert.equal(getSettingJson(fixture.db, "workspace_external_skill_roots_v1"), null);
});

test("new ancestor Skill shadows previously enabled child in detect, top-level and prompt context", async (t) => {
  const fixture = await createP4Fixture(t);
  await createSkill(fixture.workspacePath, "parent/child");
  await createSkill(fixture.workspacePath, "neighbor/available");
  await createSkill(fixture.workspacePath, "neighbor/disabled");
  const base = `/api/workspaces/${fixture.workspaceId}`;
  const put = await fixture.app.inject({ method: "PUT", url: `${base}/context-files/settings`, payload: { enabledSkillIds: ["parent/child", "neighbor/available"], enabledAgentsInstructionPaths: [] } });
  assert.equal(put.statusCode, 200, put.body);
  const before = await newRunContext(fixture);
  assert.deepEqual(before.externalSkills.map((item) => item.skillId), ["neighbor/available", "parent/child"]);
  assert.equal(before.system.includes("skillId: neighbor/disabled"), false);
  assert.match(before.system, /skillId: parent\/child/);
  const runSkillTool = await loadWorkerSkillTool();
  const workerInput = { workspacePath: fixture.workspacePath, repoRoot: fixture.repoRoot };
  assert.match((await runSkillTool({ ...workerInput, skillId: "parent/child", externalSkills: before.externalSkills })).content, /Instructions/);
  await createSkill(fixture.workspacePath, "parent", "---\nname: Parent\n---\nbody");
  const detected = (await fixture.app.inject({ method: "GET", url: `${base}/context-files/detect` })).json();
  assert.deepEqual(detected.skills.map((item: { skillId: string }) => item.skillId), ["neighbor/available", "neighbor/disabled", "parent"]);
  const top = (await fixture.app.inject({ method: "GET", url: `${base}/skills/top-level` })).json();
  assert.equal(top.items.some((item: { id: string }) => item.id === "parent/child"), false);
  assert.equal(top.items.some((item: { id: string }) => item.id === "neighbor/available"), true);
  const current = await newRunContext(fixture);
  assert.deepEqual(current.externalSkills.map((item) => item.skillId), ["neighbor/available"]);
  const skillTool = current.tools.find((tool) => tool.name === "skill");
  assert.ok(skillTool, "the prompt must expose the same Skill tool used by the Worker");
  assert.match(skillTool.description, /builtin\/<skillDir>/);
  assert.match(skillTool.description, /workspace-relative Skill directory path/);
  assert.doesNotMatch(skillTool.description, /using builtin\/\.\.\. or workspace\/\.\.\. or repo\/\.\.\./);
  assert.match(skillTool.inputSchema.properties?.skillId?.description ?? "", /workspace-relative Skill directory/);
  assert.equal(current.system.includes("skillId: parent/child"), false);
  assert.equal(current.system.includes("skillId: parent;"), false, "new parent remains disabled");
  assert.equal(current.system.includes("skillId: neighbor/disabled"), false);
  assert.match(current.system, /skillId: neighbor\/available/);
  // Supply the unchanged mapping from the actual new-run prompt-context response.
  // Neither a parent Skill nor a disabled sibling may be inferred from the filesystem.
  assert.match((await runSkillTool({ ...workerInput, skillId: "neighbor/available", externalSkills: current.externalSkills })).content, /Instructions/);
  await assert.rejects(
    runSkillTool({ ...workerInput, skillId: "parent/child", externalSkills: current.externalSkills }),
    { message: "skill not found" },
  );
  await assert.rejects(
    runSkillTool({ ...workerInput, skillId: "neighbor/disabled", externalSkills: current.externalSkills }),
    { message: "skill not found" },
  );
  const context = await resolveWorkspaceContextCandidates(fixture.ctx, fixture.workspaceId);
  const available = await resolveAvailableExternalSkills({ ...context, enabledSkillIds: context.settings.enabledSkillIds, logger: fixture.app.log });
  assert.deepEqual(available.map((item) => item.skillId), ["neighbor/available"]);
  assert.deepEqual((await fixture.app.inject({ method: "GET", url: `${base}/context-files/settings` })).json().enabledSkillIds, ["neighbor/available", "parent/child"]);
});

test("top-level does not read AGENTS and binary Skill remains a candidate but is unavailable", async (t) => {
  const fixture = await createP4Fixture(t);
  await createSkill(fixture.workspacePath, "skills/binary", "\0not text");
  await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "instructions");
  const base = `/api/workspaces/${fixture.workspaceId}`;
  assert.equal((await fixture.app.inject({ method: "PUT", url: `${base}/context-files/settings`, payload: { enabledSkillIds: ["skills/binary"], enabledAgentsInstructionPaths: ["AGENTS.md"] } })).statusCode, 200);
  const before = (await fixture.app.inject({ method: "GET", url: `${base}/context-files/detect` })).json();
  assert.equal(before.skills[0].enabled, true);
  const top = (await fixture.app.inject({ method: "GET", url: `${base}/skills/top-level` })).json();
  assert.equal(top.items.some((item: { id: string }) => item.id === "skills/binary"), false);
  const run = await newRunContext(fixture);
  assert.deepEqual(run.externalSkills, []);
  assert.equal(run.system.includes("skillId: skills/binary"), false);
  let reads = 0;
  const context = await resolvePromptWorkspaceContext(fixture.ctx, fixture.app.log, fixture.workspaceId, async (source) => {
    reads++;
    return { ...source, content: "instructions" };
  });
  assert.equal(reads, 1);
  assert.deepEqual(context.availableExternalSkills, []);
  assert.deepEqual(context.enabledAgentsInstructions.map(({ displayPath }) => displayPath), ["AGENTS.md"]);
});

test("unreadable and binary summaries are absent from top-level, new-run Prompt and Worker allowlist", async (t) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const base = `/api/workspaces/${fixture.workspaceId}`;
  await createSkill(fixture.workspacePath, "skills/readable", "---\nname: Readable\n---\nInstructions");
  await createSkill(fixture.workspacePath, "skills/binary", "\0not text");
  await createSkill(fixture.workspacePath, "skills/unreadable", "---\nname: Unreadable\n---\nInstructions");
  const filePath = path.join(fixture.workspacePath, "skills/unreadable/SKILL.md");
  const put = await fixture.app.inject({
    method: "PUT", url: `${base}/context-files/settings`,
    payload: { enabledSkillIds: ["skills/readable", "skills/binary", "skills/unreadable"], enabledAgentsInstructionPaths: [] },
  });
  assert.equal(put.statusCode, 200, put.body);
  await fs.chmod(filePath, 0o000);
  try {
    // Root can read mode-000 files; in that environment only the binary failure is testable here.
    const readableDespiteMode = await fs.open(filePath, "r").then(async (fd) => { await fd.close(); return true; }, () => false);
    if (readableDespiteMode) t.diagnostic("mode-000 file remains readable on this platform; unreadable-file assertions omitted");
    const expected = readableDespiteMode ? ["skills/readable", "skills/unreadable"] : ["skills/readable"];
    const detected = (await fixture.app.inject({ method: "GET", url: `${base}/context-files/detect` })).json();
    assert.deepEqual(detected.skills.map((item: { skillId: string }) => item.skillId), ["skills/binary", "skills/readable", "skills/unreadable"]);
    const top = await fixture.app.inject({ method: "GET", url: `${base}/skills/top-level` });
    assert.equal(top.statusCode, 200, top.body);
    assert.deepEqual(top.json().items.filter((item: { sourceType: string }) => item.sourceType === "workspace").map((item: { id: string }) => item.id), expected);
    const prompt = await newRunContext(fixture);
    assert.deepEqual(prompt.externalSkills.map((item) => item.skillId), expected);
    assert.match(prompt.system, /skillId: skills\/readable/);
    assert.equal(prompt.system.includes("skillId: skills/binary"), false);
    assert.equal(prompt.system.includes("skillId: skills/unreadable"), readableDespiteMode);
  } finally {
    await fs.chmod(filePath, 0o600);
  }
});

test("concurrent PUT keeps one complete Skill/AGENTS selection (last-write-wins)", async (t) => {
  const fixture = await createP4Fixture(t);
  const base = `/api/workspaces/${fixture.workspaceId}`;
  await createSkill(fixture.workspacePath, "skills/one");
  await createSkill(fixture.workspacePath, "skills/two");
  await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "root");
  await fs.mkdir(path.join(fixture.workspacePath, "docs"));
  await fs.writeFile(path.join(fixture.workspacePath, "docs/AGENTS.md"), "docs");
  const a = { enabledSkillIds: ["skills/one"], enabledAgentsInstructionPaths: ["AGENTS.md"] };
  const b = { enabledSkillIds: ["skills/two"], enabledAgentsInstructionPaths: ["docs/AGENTS.md"] };
  const responses = await Promise.all([a, b].map((payload) => fixture.app.inject({ method: "PUT", url: `${base}/context-files/settings`, payload })));
  for (const response of responses) assert.equal(response.statusCode, 200, response.body);
  const settings = (await fixture.app.inject({ method: "GET", url: `${base}/context-files/settings` })).json();
  const selection = { enabledSkillIds: settings.enabledSkillIds, enabledAgentsInstructionPaths: settings.enabledAgentsInstructionPaths };
  assert.ok([a, b].some((expected) => JSON.stringify(selection) === JSON.stringify(expected)), "settings must match a single complete PUT, never mixed halves");
});

test("nested AGENTS are injected globally with relative labels and original content only", async (t) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  const base = `/api/workspaces/${fixture.workspaceId}`;
  await fs.mkdir(path.join(fixture.workspacePath, "repo", "src"), { recursive: true });
  await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "ROOT_RULES");
  await fs.writeFile(path.join(fixture.workspacePath, "repo", "src", "AGENTS.md"), "SRC_RULES");
  const put = await fixture.app.inject({
    method: "PUT", url: `${base}/context-files/settings`,
    payload: { enabledSkillIds: [], enabledAgentsInstructionPaths: ["repo/src/AGENTS.md", "AGENTS.md"] },
  });
  assert.equal(put.statusCode, 200, put.body);
  const result = await newRunContext(fixture);
  assert.ok(result.system.includes("[agents_instructions] AGENTS.md\n\nROOT_RULES"));
  assert.ok(result.system.includes("[agents_instructions] repo/src/AGENTS.md\n\nSRC_RULES"));
  assert.ok(result.system.indexOf("[agents_instructions] AGENTS.md") < result.system.indexOf("[agents_instructions] repo/src/AGENTS.md"));
  assert.equal(result.system.includes(fixture.workspacePath), false, "never expose absolute paths in prompt");
  assert.equal(result.system.includes("ROOT_RULES") && result.system.includes("SRC_RULES"), true);
});

test("new run rejects a failed scan rather than using stale enabled settings", async (t) => {
  const fixture = await createP4Fixture(t, { agentWorkerConcurrency: 0 });
  await createSkill(fixture.workspacePath, "skills/active");
  const base = `/api/workspaces/${fixture.workspaceId}`;
  assert.equal((await fixture.app.inject({ method: "PUT", url: `${base}/context-files/settings`, payload: { enabledSkillIds: ["skills/active"], enabledAgentsInstructionPaths: [] } })).statusCode, 200);
  const relocated = `${fixture.workspacePath}-offline`;
  await fs.rename(fixture.workspacePath, relocated);
  try {
    const response = await requestNewRunContext(fixture);
    assert.equal(response.statusCode, 409, "a new run must not silently reuse stale enabled IDs");
    assert.equal(response.json().code, "WORKSPACE_CONTEXT_SCAN_FAILED");
    assert.equal(response.body.includes(fixture.workspacePath), false, "no absolute path in error response");
  } finally {
    await fs.rename(relocated, fixture.workspacePath);
  }
});

test("a failed rescan leaves the previous combined selection intact", async (t) => {
  const fixture = await createP4Fixture(t);
  const base = `/api/workspaces/${fixture.workspaceId}`;
  await fs.writeFile(path.join(fixture.workspacePath, "AGENTS.md"), "instructions");
  const previous = { enabledSkillIds: [], enabledAgentsInstructionPaths: ["AGENTS.md"] };
  assert.equal((await fixture.app.inject({ method: "PUT", url: `${base}/context-files/settings`, payload: previous })).statusCode, 200);
  await fs.rename(fixture.workspacePath, `${fixture.workspacePath}-missing`);
  const failed = await fixture.app.inject({ method: "PUT", url: `${base}/context-files/settings`, payload: { enabledSkillIds: [], enabledAgentsInstructionPaths: [] } });
  assert.equal(failed.statusCode, 409);
  assert.equal(failed.json().code, "WORKSPACE_CONTEXT_SCAN_FAILED");
  const detected = await fixture.app.inject({ method: "GET", url: `${base}/context-files/detect` });
  assert.equal(detected.statusCode, 409);
  assert.deepEqual((await fixture.app.inject({ method: "GET", url: `${base}/context-files/settings` })).json().enabledAgentsInstructionPaths, previous.enabledAgentsInstructionPaths);
  await fs.rename(`${fixture.workspacePath}-missing`, fixture.workspacePath);
});
