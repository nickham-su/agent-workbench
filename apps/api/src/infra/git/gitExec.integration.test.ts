import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { runGit, runGitBuffer } from "./gitExec.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

async function helperFixture(t: TestContext) {
  const root = fileURLToPath(new URL("../../../../../.tmp-tests/git-exec/", import.meta.url));
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, "retained-pipe-"));
  const pidFile = path.join(dir, "owned-helper.pid");
  const heartbeat = path.join(dir, "owned-helper.heartbeat");
  let ownedGroup: number | undefined;
  const actualSpawn = childProcess.spawn;
  const spawnMock = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof actualSpawn>) => {
    const retainedHelper = args[0] === "git" && args[1]?.includes("fixture-retained") && args[2]?.cwd === dir;
    // Assert ownership before starting anything: cleanup must never signal the test runner's group.
    if (retainedHelper) assert.equal(args[2]?.detached, true);
    const child = actualSpawn(...args);
    if (retainedHelper) ownedGroup = child.pid;
    return child;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    try {
      // Always clean the exact group created above, including failure before a heartbeat/PID file exists.
      // No process scan or PID loaded from disk; the group includes Git, its shell and all fixture helpers.
      if (ownedGroup !== undefined) {
        assert.ok(ownedGroup > 1 && ownedGroup !== process.pid);
        try { process.kill(-ownedGroup, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        await pause(80);
      }
      await fs.rm(dir, { recursive: true, force: true });
    } finally {
      spawnMock.mock.restore();
      syncBuiltinESMExports();
    }
  });
  const env = { GIT_CONFIG_GLOBAL: path.join(dir, "empty-global"), GIT_CONFIG_NOSYSTEM: "1" };
  const initialized = await runGit(["-C", dir, "-c", "init.defaultBranch=main", "init"], { cwd: dir, env, timeoutMs: 5000 });
  assert.equal(initialized.ok, true);
  const script = path.join(dir, "retained-helper.mjs");
  await fs.writeFile(script, `
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [mode, pidFile, heartbeat, burst] = process.argv.slice(2);
if (mode === 'child') {
  fs.writeFileSync(pidFile, String(process.pid));
  fs.writeFileSync(heartbeat, String(Date.now()));
  setInterval(() => fs.writeFileSync(heartbeat, String(Date.now())), 15);
  if (burst === 'yes') process.stdout.write('x'.repeat(4096));
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', pidFile, heartbeat, burst], { stdio: 'inherit' });
  child.unref();
  const ready = setInterval(() => {
    if (fs.existsSync(pidFile)) { clearInterval(ready); process.exit(0); }
  }, 5);
}
`);
  return { dir, pidFile, heartbeat, script, env };
}

for (const reason of ["timeout", "output-limit"] as const) {
  test(`Git ${reason} kills an isolated inherited-stdio helper instead of waiting forever for close`, { skip: process.platform === "win32", timeout: 8000 }, async (t) => {
    const f = await helperFixture(t);
    const command = `!${quote(process.execPath)} ${quote(f.script)} parent ${quote(f.pidFile)} ${quote(f.heartbeat)} ${reason === "output-limit" ? "yes" : "no"}`;
    const started = Date.now();
    const result = await runGitBuffer(["-C", f.dir, "-c", `alias.fixture-retained=${command}`, "fixture-retained"], {
      cwd: f.dir, env: f.env, timeoutMs: 1000, maxOutputBytes: 256
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, reason);
    assert.ok(Date.now() - started < 3000, "request completion must be bounded even when Git exit does not close its pipes");
    assert.match(await fs.readFile(f.pidFile, "utf8"), /^[1-9]\d*$/);
    const stopped = await fs.readFile(f.heartbeat, "utf8");
    await pause(160);
    assert.equal(await fs.readFile(f.heartbeat, "utf8"), stopped, "the owned helper must have stopped executing, not merely lost its pipe");
  });
}
