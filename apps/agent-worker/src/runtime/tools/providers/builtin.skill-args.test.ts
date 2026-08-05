import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BuiltinToolProvider } from "./builtin.js";

async function createSkillFixture() {
  const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "awb-builtin-provider-skill-"));
  const skillDirectory = path.join(skillsRoot, "demo");
  await fs.mkdir(skillDirectory);
  await fs.writeFile(path.join(skillDirectory, "SKILL.md"), "root instructions", "utf8");
  await fs.writeFile(path.join(skillDirectory, "reference.md"), "reference content", "utf8");
  return { skillsRoot, skillId: "workspace/test-skills/demo" };
}

function createSkillExecutionContext(skillsRoot: string) {
  return {
    run: { workspacePath: skillsRoot },
    promptContext: {
      externalSkillRoots: [{ sourceType: "workspace", rootDir: "test-skills", rootPath: skillsRoot }]
    },
    signal: new AbortController().signal
  } as any;
}

test("builtin provider skill 仅映射 own skill_id 和 own file_path", async () => {
  const fixture = await createSkillFixture();
  try {
    const provider = new BuiltinToolProvider();
    const ctx = createSkillExecutionContext(fixture.skillsRoot);

    const root = await provider.execute("skill", { skill_id: fixture.skillId }, ctx) as Record<string, unknown>;
    assert.deepEqual(Object.keys(root).sort(), ["content", "file_path", "skill_id", "truncated"]);
    assert.equal(root.skill_id, fixture.skillId);
    assert.equal(root.file_path, "SKILL.md");
    assert.equal(root.content, "root instructions\n\n---\n\n## Skill files\n\n```text\nreference.md\n```");

    const file = await provider.execute("skill", {
      skill_id: fixture.skillId,
      file_path: "reference.md"
    }, ctx) as Record<string, unknown>;
    assert.equal(file.skill_id, fixture.skillId);
    assert.equal(file.file_path, "reference.md");
    assert.equal(file.content, "reference content");

    const nullPrototypeArgs = Object.assign(Object.create(null), {
      skill_id: fixture.skillId,
      file_path: "reference.md"
    }) as Record<string, unknown>;
    const nullPrototypeFile = await provider.execute("skill", nullPrototypeArgs, ctx) as Record<string, unknown>;
    assert.equal(nullPrototypeFile.file_path, "reference.md");
    assert.equal(nullPrototypeFile.content, "reference content");

    for (const [invalidArgs, message] of [
      [{ skill_id: fixture.skillId, path: "reference.md" }, "invalid skill path"],
      [{ skill_id: fixture.skillId, id: fixture.skillId }, "invalid skill identifier"],
      [{ skill_id: fixture.skillId, skill: fixture.skillId }, "invalid skill identifier"],
      [{ skill_id: fixture.skillId, unexpected: true }, "invalid skill identifier"],
      [{ id: fixture.skillId }, "skill is required"],
      [{ skill: fixture.skillId }, "skill is required"],
      [{ skill: fixture.skillId, path: "reference.md" }, "invalid skill path"]
    ] as const) {
      await assert.rejects(
        () => provider.execute("skill", invalidArgs, ctx),
        { message }
      );
    }

    const symbolFieldArgs = { skill_id: fixture.skillId, [Symbol("unexpected")]: true } as Record<string | symbol, unknown>;
    await assert.rejects(
      () => provider.execute("skill", symbolFieldArgs as Record<string, unknown>, ctx),
      { message: "invalid skill identifier" }
    );

    const inheritedSkillId = Object.create({ skill_id: fixture.skillId }) as Record<string, unknown>;
    await assert.rejects(
      () => provider.execute("skill", inheritedSkillId, ctx),
      { message: "skill is required" }
    );

    for (const invalidArgs of [null, undefined, 0, "builtin/demo", false, [], () => fixture.skillId]) {
      await assert.rejects(
        () => provider.execute("skill", invalidArgs as unknown as Record<string, unknown>, ctx),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          assert.equal(message, "skill is required");
          assert.equal(/Reflect|stack|[\\/]/i.test(message), false);
          return true;
        }
      );
    }
  } finally {
    await fs.rm(fixture.skillsRoot, { recursive: true, force: true });
  }
});
