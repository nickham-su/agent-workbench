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

test("builtin provider skill 仅映射 own skillId 和 own filePath", async () => {
  const fixture = await createSkillFixture();
  try {
    const provider = new BuiltinToolProvider();
    const ctx = createSkillExecutionContext(fixture.skillsRoot);

    const root = await provider.execute("skill", { skillId: fixture.skillId }, ctx) as Record<string, unknown>;
    assert.deepEqual(Object.keys(root).sort(), ["content", "filePath", "skillId", "truncated"]);
    assert.equal(root.skillId, fixture.skillId);
    assert.equal(root.filePath, "SKILL.md");
    assert.equal(root.content, "root instructions\n\n---\n\n## Skill files\n\n```text\nreference.md\n```");

    const file = await provider.execute("skill", {
      skillId: fixture.skillId,
      filePath: "reference.md"
    }, ctx) as Record<string, unknown>;
    assert.equal(file.skillId, fixture.skillId);
    assert.equal(file.filePath, "reference.md");
    assert.equal(file.content, "reference content");

    const nullPrototypeArgs = Object.assign(Object.create(null), {
      skillId: fixture.skillId,
      filePath: "reference.md"
    }) as Record<string, unknown>;
    const nullPrototypeFile = await provider.execute("skill", nullPrototypeArgs, ctx) as Record<string, unknown>;
    assert.equal(nullPrototypeFile.filePath, "reference.md");
    assert.equal(nullPrototypeFile.content, "reference content");

    for (const [invalidArgs, message] of [
      [{ skillId: fixture.skillId, path: "reference.md" }, "invalid skill identifier"],
      [{ skillId: fixture.skillId, file_path: "reference.md" }, "invalid skill identifier"],
      [{ skillId: fixture.skillId, id: fixture.skillId }, "invalid skill identifier"],
      [{ skillId: fixture.skillId, skill: fixture.skillId }, "invalid skill identifier"],
      [{ skillId: fixture.skillId, skill_id: fixture.skillId }, "invalid skill identifier"],
      [{ skillId: fixture.skillId, unexpected: true }, "invalid skill identifier"],
      [{ id: fixture.skillId }, "skill is required"],
      [{ skill: fixture.skillId }, "skill is required"],
      [{ skill_id: fixture.skillId }, "skill is required"],
      [{ skill: fixture.skillId, path: "reference.md" }, "skill is required"],
      [{ skill_id: fixture.skillId, file_path: "reference.md" }, "skill is required"],
      [{ unexpected: true }, "skill is required"]
    ] as const) {
      await assert.rejects(
        () => provider.execute("skill", invalidArgs, ctx),
        { message }
      );
    }

    await assert.rejects(
      () => provider.execute("skill", { skillId: fixture.skillId, filePath: 1 }, ctx),
      { message: "invalid skill path" }
    );

    const symbolFieldArgs = { skillId: fixture.skillId, [Symbol("unexpected")]: true } as Record<string | symbol, unknown>;
    await assert.rejects(
      () => provider.execute("skill", symbolFieldArgs as Record<string, unknown>, ctx),
      { message: "invalid skill identifier" }
    );

    const inheritedSkillId = Object.create({ skillId: fixture.skillId }) as Record<string, unknown>;
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
