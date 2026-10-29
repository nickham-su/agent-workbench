import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildGitProcessEnv, prepareGitRepositoryPath, prepareGitOutputGuard, requireGitLeaseTime, GIT_LEASE_SETTLEMENT_GRACE_MS } from "./gitLeaseGuard.js";
import { GitToolError } from "./gitErrors.js";
import { createGitFixture, TEST_GIT_SECRET } from "./git.testkit.js";

function guardParams(fixture: Awaited<ReturnType<typeof createGitFixture>>) {
  return { response: fixture.response, repo: fixture.repo, dataDir: fixture.dataDir, timeoutMs: 120_000, now: Date.now() };
}

for (const kind of ["none", "https", "ssh"] as const) {
  test(`Git guard ${kind}: only fixed lease files are read; known secret and paths are collected`, async (t) => {
    const fixture = await createGitFixture(kind);
    t.after(fixture.cleanup);
    const result = await prepareGitOutputGuard(guardParams(fixture));
    assert(result.knownValues.includes(fixture.leaseDir));
    await result.assertPathIdentity();
    if (kind === "none") assert.equal(result.knownValues.length, 1);
    else {
      assert(result.knownValues.includes(fixture.response.sensitiveFilePaths[0]));
      if (kind === "https") assert(result.knownValues.includes(TEST_GIT_SECRET));
    }
  });
}

test("Git environment filters all AWB and inherited auth overrides without mutating the Worker", () => {
  const inherited = {
    AWB_AGENT_INTERNAL_TOKEN: "fixture-internal", AWB_OTHER: "fixture-other",
    GIT_ASKPASS: "old", GIT_ASKPASS_TOKEN_FILE: "old-token", GIT_ASKPASS_TOKEN: "fixture-secret",
    GIT_ASKPASS_USERNAME: "old-user", GIT_SSH: "old-ssh", GIT_SSH_COMMAND: "old-command",
    PATH: "/fixture/bin", HOME: "/fixture/home", SSH_AUTH_SOCK: "/fixture/agent", HTTPS_PROXY: "old-proxy",
    GIT_AUTHOR_NAME: "Fixture Author", undefinedValue: undefined,
  };
  const before = { ...inherited };
  const env = buildGitProcessEnv({ GIT_TERMINAL_PROMPT: "0", HTTPS_PROXY: "fixture-new-proxy" }, inherited);
  assert.deepEqual(inherited, before);
  assert(!Object.keys(env).some((key) => key.startsWith("AWB_")));
  for (const key of ["GIT_ASKPASS", "GIT_ASKPASS_TOKEN_FILE", "GIT_ASKPASS_TOKEN", "GIT_ASKPASS_USERNAME", "GIT_SSH", "GIT_SSH_COMMAND"]) assert.equal(env[key], undefined);
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(env.HOME, inherited.HOME);
  assert.equal(env.SSH_AUTH_SOCK, inherited.SSH_AUTH_SOCK);
  assert.equal(env.GIT_AUTHOR_NAME, inherited.GIT_AUTHOR_NAME);
  assert.equal(env.HTTPS_PROXY, "fixture-new-proxy");
});

test("Git lease remaining TTL covers timeout plus settlement and rejects invalid dates", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const now = Date.now();
  for (const expiresAt of ["not-a-date", new Date(now + 120_000).toISOString(), new Date(now + 120_000 + GIT_LEASE_SETTLEMENT_GRACE_MS - 1).toISOString()]) {
    assert.throws(() => requireGitLeaseTime({ ...fixture.response, expiresAt }, 120_000, now), /GIT_LEASE_EXPIRED/);
  }
  requireGitLeaseTime({ ...fixture.response, expiresAt: new Date(now + 120_000 + GIT_LEASE_SETTLEMENT_GRACE_MS).toISOString() }, 120_000, now);
});

test("Git repository final path rejects disappearance, non-directory and outward symlink", async (t) => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const guard = await prepareGitRepositoryPath({ dataDir: fixture.dataDir, workspacePath: fixture.workspacePath, repo: fixture.repo });
  t.after(guard.close);
  assert.equal(await guard.checkFinalPath(), fixture.cwd);
  await fs.rmdir(fixture.cwd);
  await assert.rejects(guard.checkFinalPath(), /REPO_PATH_INVALID/);
  await fs.writeFile(fixture.cwd, "not a directory");
  await assert.rejects(guard.checkFinalPath(), /REPO_PATH_INVALID/);
  await fs.unlink(fixture.cwd);
  await fs.symlink(fixture.dataDir, fixture.cwd);
  await assert.rejects(guard.checkFinalPath(), /REPO_PATH_INVALID/);
});

for (const mutation of ["foreign-secret", "foreign-askpass", "secret-symlink", "askpass-symlink", "bad-permissions", "missing-secret", "oversize-secret", "unknown-env", "wrong-kind", "wrong-repo"] as const) {
  test(`Git guard rejects ${mutation} without reading arbitrary files`, async (t) => {
    const fixture = await createGitFixture("https");
    t.after(fixture.cleanup);
    const response: any = structuredClone(fixture.response);
    const foreignFile = path.join(fixture.root, "foreign-sentinel");
    await fs.writeFile(foreignFile, "unrelated fixture data", { mode: 0o600 });
    const secret = response.sensitiveFilePaths[0];
    const script = response.env.GIT_ASKPASS;
    if (mutation === "foreign-secret") response.sensitiveFilePaths = [foreignFile];
    if (mutation === "foreign-askpass") response.env.GIT_ASKPASS = foreignFile;
    if (mutation === "secret-symlink") { await fs.unlink(secret); await fs.symlink(foreignFile, secret); }
    if (mutation === "askpass-symlink") { await fs.unlink(script); await fs.symlink(foreignFile, script); }
    if (mutation === "bad-permissions") await fs.chmod(secret, 0o644);
    if (mutation === "missing-secret") await fs.unlink(secret);
    if (mutation === "oversize-secret") await fs.writeFile(secret, Buffer.alloc(1024 * 1024 + 1, 120));
    if (mutation === "unknown-env") response.env.AWB_AGENT_INTERNAL_TOKEN = "fixture-injected";
    if (mutation === "wrong-kind") response.kind = "none";
    if (mutation === "wrong-repo") response.repo = "another-repository";
    await assert.rejects(prepareGitOutputGuard({ ...guardParams(fixture), response }), /GIT_(?:OUTPUT_GUARD|ENV_RPC)_FAILED/);
    assert.equal(await fs.readFile(foreignFile, "utf8"), "unrelated fixture data");
  });
}

for (const ancestor of ["tmp", "git-env", "v2", "lease"] as const) {
  test(`Git guard refuses ${ancestor} symlink ancestors`, async (t) => {
    const fixture = await createGitFixture("ssh");
    t.after(fixture.cleanup);
    const target = ancestor === "lease" ? fixture.leaseDir : ancestor === "tmp" ? path.join(fixture.dataDir, "tmp") : ancestor === "git-env" ? path.join(fixture.dataDir, "tmp/git-env") : path.join(fixture.dataDir, "tmp/git-env/v2");
    const moved = path.join(fixture.root, `moved-${ancestor}`);
    await fs.rename(target, moved);
    await fs.symlink(moved, target);
    await assert.rejects(prepareGitOutputGuard(guardParams(fixture)), /GIT_OUTPUT_GUARD_FAILED/);
  });
}

test("Git guard checks captured path identities after closing pinned handles", async (t) => {
  const fixture = await createGitFixture("https");
  t.after(fixture.cleanup);
  const guard = await prepareGitOutputGuard(guardParams(fixture));
  const moved = path.join(fixture.root, "original-lease");
  await fs.rename(fixture.leaseDir, moved);
  await fs.mkdir(fixture.leaseDir, { mode: 0o700 });
  await assert.rejects(guard.assertPathIdentity(), /GIT_OUTPUT_GUARD_FAILED/);
});

test("Git guard rejects arbitrary SSH commands even with a valid key path", async (t) => {
  const fixture = await createGitFixture("ssh");
  t.after(fixture.cleanup);
  assert.equal(fixture.response.kind, "ssh");
  if (fixture.response.kind !== "ssh") throw new Error("invalid SSH fixture");
  const response = { ...fixture.response, env: { ...fixture.response.env, GIT_SSH_COMMAND: `${fixture.response.env.GIT_SSH_COMMAND}; fixture-foreign-command` } };
  await assert.rejects(prepareGitOutputGuard({ ...guardParams(fixture), response }), /GIT_OUTPUT_GUARD_FAILED/);
});

for (const target of ["token-replaced", "token-written", "script-replaced", "script-mode"] as const) {
  test(`Git guard checks captured file identity/content metadata after handles close: ${target}`, async (t) => {
    const fixture = await createGitFixture("https"); t.after(fixture.cleanup);
    const guard = await prepareGitOutputGuard(guardParams(fixture));
    const file = path.join(fixture.leaseDir, target.startsWith("token") ? "git-askpass-token" : "git-askpass.sh");
    if (target.endsWith("replaced")) {
      await fs.rename(file, `${file}.original`);
      await fs.writeFile(file, "fixture replaced", { mode: target.startsWith("token") ? 0o600 : 0o700 });
    } else if (target === "token-written") await fs.appendFile(file, "fixture mutation");
    else await fs.chmod(file, 0o600);
    await assert.rejects(guard.assertPathIdentity(), /GIT_OUTPUT_GUARD_FAILED/);
  });
}

for (const ancestor of ["data", "workspaces", "workspace"] as const) {
  test(`Git repository guard rejects an initial ${ancestor} symlink instead of adopting its physical root`, async (t) => {
    const fixture = await createGitFixture(); t.after(fixture.cleanup);
    const target = ancestor === "data" ? fixture.dataDir : ancestor === "workspaces" ? path.dirname(fixture.workspacePath) : fixture.workspacePath;
    const foreign = path.join(fixture.root, "foreign-root");
    await fs.rename(target, foreign); await fs.symlink(foreign, target);
    await assert.rejects(prepareGitRepositoryPath({ dataDir: fixture.dataDir, workspacePath: fixture.workspacePath, repo: fixture.repo }), /REPO_PATH_INVALID/);
  });
}

for (const ancestor of ["data", "workspaces", "workspace"] as const) {
  test(`Git repository guard retains the original ${ancestor} directory identity across regular replacement`, async (t) => {
    const fixture = await createGitFixture(); t.after(fixture.cleanup);
    const guard = await prepareGitRepositoryPath({ dataDir: fixture.dataDir, workspacePath: fixture.workspacePath, repo: fixture.repo });
    t.after(guard.close);
    const target = ancestor === "data" ? fixture.dataDir : ancestor === "workspaces" ? path.dirname(fixture.workspacePath) : fixture.workspacePath;
    await fs.rename(target, path.join(fixture.root, "original-root"));
    await fs.mkdir(fixture.cwd, { recursive: true });
    await assert.rejects(guard.checkFinalPath(), /REPO_PATH_INVALID/);
  });
}

test("Git repository guard accepts the API physical layout and an inward repo symlink, but rejects another layout", async (t) => {
  const fixture = await createGitFixture(); t.after(fixture.cleanup);
  const guard = await prepareGitRepositoryPath({ dataDir: fixture.dataDir, workspacePath: fixture.workspacePath, repo: fixture.repo });
  t.after(guard.close);
  const physicalRepo = path.join(fixture.workspacePath, "physical-repo");
  await fs.rename(fixture.cwd, physicalRepo); await fs.symlink(physicalRepo, fixture.cwd);
  assert.equal(await guard.checkFinalPath(), fixture.cwd);
  await assert.rejects(prepareGitRepositoryPath({ dataDir: fixture.dataDir, workspacePath: path.join(fixture.root, "foreign-workspace"), repo: fixture.repo }), /REPO_PATH_INVALID/);
});


for (const scenario of [
  { guard: "repository", kind: "none", levels: ["data", "workspaces", "workspace"] },
  { guard: "output", kind: "https", levels: ["data", "tmp", "git-env", "v2", "lease", "askpass", "token"] },
  { guard: "output", kind: "ssh", levels: ["data", "tmp", "git-env", "v2", "lease", "key"] },
] as const) {
  for (const [index, level] of scenario.levels.entries()) {
    // Directory failures are already covered by HTTPS; SSH adds its own key path.
    if (scenario.kind === "ssh" && level !== "key") continue;
    for (const statCall of level === "askpass" ? [1] : [1, 2]) {
      test(`Git ${scenario.guard} guard closes all opened handles on ${scenario.kind}/${level} stat ${statCall} EIO`, async (t) => {
        const fixture = await createGitFixture(scenario.kind);
        t.after(fixture.cleanup);
        const opened: Array<{ handle: fs.FileHandle; closes: number }> = [];
        t.after(async () => {
          // Prevent a regressed test from leaking its own fixture handles.
          for (const entry of opened) if (entry.closes === 0) await entry.handle.close();
        });
        const originalOpen = fs.open.bind(fs);
        let injected = false;
        t.mock.method(fs, "open", async (...input: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...input);
          const entry = { handle, closes: 0 };
          opened.push(entry);
          const originalClose = handle.close.bind(handle);
          t.mock.method(handle, "close", async () => { await originalClose(); entry.closes++; });
          if (opened.length === index + 1) {
            const originalStat = handle.stat.bind(handle);
            let calls = 0;
            t.mock.method(handle, "stat", async (...options: Parameters<typeof handle.stat>) => {
              if (++calls === statCall) {
                injected = true;
                throw Object.assign(new Error("fixture stat failure"), { code: "EIO" });
              }
              return originalStat(...options);
            });
          }
          return handle;
        });
        const operation = scenario.guard === "repository"
          ? prepareGitRepositoryPath({ dataDir: fixture.dataDir, workspacePath: fixture.workspacePath, repo: fixture.repo })
          : prepareGitOutputGuard(guardParams(fixture));
        const code = scenario.guard === "repository" ? "REPO_PATH_INVALID" : "GIT_OUTPUT_GUARD_FAILED";
        await assert.rejects(operation, (error: unknown) => error instanceof GitToolError && error.code === code);
        assert(injected);
        assert.equal(opened.length, index + 1);
        assert(opened.every((entry) => entry.closes === 1), "each successfully opened handle must be closed once");
      });
    }
  }
}
