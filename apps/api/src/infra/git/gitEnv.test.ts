import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { buildGitEnv, GitEnvBuildError, type GitEnvArtifactDirectory } from "./gitEnv.js";
import { setSettingJson } from "../../modules/settings/settings.store.js";
import { createGitLeaseFixture, addFixtureCredential, leaseMeta, assertCode } from "../../modules/git-env/git-env.testkit.js";
import { withCreatedRepoGitEnvLease, inspectRepoGitEnvLease } from "../../modules/git-env/git-env.lease.js";

for (const kind of ["https", "ssh"] as const) test(`AC-AUTH-BOUND/PERMISSIONS: ${kind} artifacts are private, API-owned, and do not put secret contents in env`, async (t) => {
  const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f, { kind });
  const meta = leaseMeta(f);
  await withCreatedRepoGitEnvLease({ dataDir: f.dataDir, meta }, async ({ artifactDir }) => {
    const result = await buildGitEnv({ ctx: f.ctx, repoUrl: f.repository.repo.url, credentialId, artifactDir, strictBoundCredential: true });
    assert.equal(result.kind, kind); assert.equal(result.sensitiveFilePaths.length, 1);
    assert(!JSON.stringify(result.env).includes("fixture-secret-marker"));
    assert.equal(await fs.readFile(result.sensitiveFilePaths[0], "utf-8"), "fixture-secret-marker");
    assert.equal((await fs.stat(result.sensitiveFilePaths[0])).mode & 0o777, 0o600);
    if (kind === "https") {
      assert.equal((await fs.stat(result.env.GIT_ASKPASS!)).mode & 0o777, 0o700);
      assert.equal(result.env.GIT_ASKPASS_USERNAME, "fixture-user");
    } else {
      assert(result.env.GIT_SSH_COMMAND?.includes("IdentitiesOnly=yes"));
      assert(result.env.GIT_SSH_COMMAND?.includes("StrictHostKeyChecking=accept-new"));
      assert(result.env.GIT_SSH_COMMAND?.includes(path.join(f.dataDir, "ssh", "known_hosts")));
    }
    await result.cleanup();
    await assert.rejects(fs.access(result.sensitiveFilePaths[0]));
  });
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }))?.state, "unconfirmed");
});

test("AC-AUTH-MISSING: strict binding fails instead of switching identity; default UI behavior remains none", async (t) => {
  const f = await createGitLeaseFixture(t); addFixtureCredential(f);
  await assert.rejects(buildGitEnv({ ctx: f.ctx, repoUrl: f.repository.repo.url, credentialId: "missing", strictBoundCredential: true }), assertCode("CREDENTIAL_NOT_FOUND"));
  const legacy = await buildGitEnv({ ctx: f.ctx, repoUrl: f.repository.repo.url, credentialId: "missing" });
  assert.equal(legacy.kind, "none"); assert.deepEqual(legacy.sensitiveFilePaths, []);
});

test("AC-AUTH-DECRYPT: invalid encrypted fixture returns a safe error and no secret files", async (t) => {
  const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f, { invalidCipher: true });
  await assert.rejects(buildGitEnv({ ctx: f.ctx, repoUrl: f.repository.repo.url, credentialId, strictBoundCredential: true }), (error) => {
    assert(error instanceof GitEnvBuildError); assert.equal(error.code, "CREDENTIAL_DECRYPT_FAILED");
    assert.equal(error.message, "CREDENTIAL_DECRYPT_FAILED"); return true;
  });
  await assert.rejects(fs.access(path.join(f.dataDir, "tmp")));
});

test("AC-AUTH-UNBOUND: same-kind default beats latest, no default selects latest, unknown protocol only host default", async (t) => {
  const f = await createGitLeaseFixture(t);
  addFixtureCredential(f, { secret: "fixture-default", updatedAt: 1 });
  addFixtureCredential(f, { secret: "fixture-latest", isDefault: false, updatedAt: 10 });
  const use = async (url: string) => {
    const result = await buildGitEnv({ ctx: f.ctx, repoUrl: url, credentialId: null });
    const secret = await fs.readFile(result.sensitiveFilePaths[0], "utf-8");
    await result.cleanup(); return secret;
  };
  assert.equal(await use("https://example.test/repo.git"), "fixture-default");
  f.db.prepare("update credentials set is_default=0").run();
  assert.equal(await use("https://example.test/repo.git"), "fixture-latest");
  const unknown = await buildGitEnv({ ctx: f.ctx, repoUrl: "git://example.test/repo.git", credentialId: null });
  assert.equal(unknown.kind, "none");
});

test("AC-AUTH-PROTOCOL/NONE: unbound HTTPS never picks SSH, none has no artifacts and still disables terminal input", async (t) => {
  const f = await createGitLeaseFixture(t); addFixtureCredential(f, { kind: "ssh" });
  const result = await buildGitEnv({ ctx: f.ctx, repoUrl: "https://example.test/repo.git", credentialId: null });
  assert.equal(result.kind, "none"); assert.deepEqual(result.sensitiveFilePaths, []); assert.equal(result.env.GIT_TERMINAL_PROMPT, "0");
  await result.cleanup(); await assert.rejects(fs.access(path.join(f.dataDir, "tmp")));
});

test("AC-AUTH-NETWORK: common builder provides project proxy/CA unchanged for none and bound auth", async (t) => {
  const f = await createGitLeaseFixture(t);
  setSettingJson(f.db, "network", { httpProxy: "http://proxy.test:1", httpsProxy: "http://proxy.test:2", noProxy: "example.test", caCertPem: "fixture custom CA\n" }, Date.now());
  for (const credentialId of [null, addFixtureCredential(f)]) {
    const result = await buildGitEnv({ ctx: f.ctx, repoUrl: "https://other.test/repo.git", credentialId });
    assert.equal(result.env.HTTP_PROXY, "http://proxy.test:1"); assert.equal(result.env.http_proxy, result.env.HTTP_PROXY);
    assert.equal(result.env.HTTPS_PROXY, "http://proxy.test:2"); assert.equal(result.env.https_proxy, result.env.HTTPS_PROXY);
    assert.equal(result.env.NO_PROXY, "example.test"); assert.equal(result.env.no_proxy, result.env.NO_PROXY);
    assert.equal(result.env.GIT_SSL_CAINFO, path.join(f.dataDir, "certs", "ca-bundle.pem"));
    assert.equal(result.env.SSL_CERT_FILE, result.env.GIT_SSL_CAINFO);
    assert((await fs.readFile(result.env.GIT_SSL_CAINFO!, "utf-8")).includes("fixture custom CA"));
    await result.cleanup();
    await fs.access(path.join(f.dataDir, "certs", "ca-bundle.pem"));
  }
});

for (const artifact of ["implicit", "lease"] as const) test(`AC-LEASE-PARTIAL/PERMISSIONS: ${artifact} builder recovers token after askpass write failure`, async (t) => {
  const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f);
  const meta = leaseMeta(f);
  const original = fs.open;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith("/git-askpass.sh")) throw new Error("fixture partial write with private path");
    return original(...args);
  });
  const failBuild = async (artifactDir?: GitEnvArtifactDirectory) => {
    await assert.rejects(buildGitEnv({ ctx: f.ctx, repoUrl: f.repository.repo.url, credentialId, artifactDir, strictBoundCredential: true }), assertCode("GIT_ENV_PREPARE_FAILED"));
  };
  try {
    if (artifact === "lease") await withCreatedRepoGitEnvLease({ dataDir: f.dataDir, meta }, async ({ artifactDir }) => {
      await failBuild(artifactDir);
      assert.deepEqual(await fs.readdir(artifactDir.directory.fdPath), ["meta.json"]);
    });
    else await failBuild();
  } finally { mock.mock.restore(); }
  if (artifact === "lease") {
    assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }))?.state, "unconfirmed");
  } else assert.deepEqual(await fs.readdir(path.join(f.dataDir, "tmp")), []);
});

test("AC-LEASE-PERMISSIONS: chmod failure is explicit and partial token is removed", async (t) => {
  const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f), meta = leaseMeta(f);
  const original = fs.open;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await original(...args);
    if (String(args[0]).endsWith("/git-askpass-token")) t.mock.method(file, "chmod", async () => { throw new Error("fixture chmod failure"); });
    return file;
  });
  try { await withCreatedRepoGitEnvLease({ dataDir: f.dataDir, meta }, async ({ artifactDir }) => {
    await assert.rejects(buildGitEnv({ ctx: f.ctx, repoUrl: f.repository.repo.url, credentialId, artifactDir }), assertCode("GIT_ENV_PREPARE_FAILED"));
    assert.deepEqual(await fs.readdir(artifactDir.directory.fdPath), ["meta.json"]);
  }); }
  finally { mock.mock.restore(); }
});

test("AC-LEASE-ROOT: caller-owned directory refuses symlink and existing-file collision without removing an unrelated file", async (t) => {
  const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f), meta = leaseMeta(f);
  await withCreatedRepoGitEnvLease({ dataDir: f.dataDir, meta }, async ({ artifactDir }) => {
    const directory = artifactDir.directory;
    await fs.writeFile(path.join(directory.fdPath, "git-askpass-token"), "unrelated fixture", { mode: 0o600 });
    await assert.rejects(buildGitEnv({ ctx: f.ctx, repoUrl: f.repository.repo.url, credentialId, artifactDir }), assertCode("GIT_ENV_PREPARE_FAILED"));
    assert.equal(await fs.readFile(path.join(directory.fdPath, "git-askpass-token"), "utf-8"), "unrelated fixture");
    const moved = path.join(f.dataDir, "original-lease");
    await fs.rename(directory.logicalPath, moved); await fs.symlink(moved, directory.logicalPath);
    await assert.rejects(buildGitEnv({ ctx: f.ctx, repoUrl: f.repository.repo.url, credentialId, artifactDir }), assertCode("GIT_ENV_PREPARE_FAILED"));
    assert.equal(await fs.readFile(path.join(moved, "git-askpass-token"), "utf-8"), "unrelated fixture");
  });
});

test("H1/RESOURCE-LIFETIME: builder borrows the live capability; cleanup after closure cannot use a recycled fd path", async (t) => {
  const f = await createGitLeaseFixture(t), credentialId = addFixtureCredential(f), meta = leaseMeta(f);
  let capability: GitEnvArtifactDirectory | undefined;
  const built = await withCreatedRepoGitEnvLease({ dataDir: f.dataDir, meta }, async ({ artifactDir }) => {
    capability = artifactDir;
    const result = await buildGitEnv({ ctx: f.ctx, repoUrl: f.repository.repo.url, credentialId, artifactDir });
    assert(artifactDir.directory.handle.fd >= 0, "builder must not close the borrowed handle");
    return result;
  });
  assert(capability); assert.equal(capability.directory.handle.fd, -1);
  await assert.rejects(built.cleanup());
  assert.equal(await fs.readFile(built.sensitiveFilePaths[0], "utf-8"), "fixture-secret-marker");
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }))?.state, "unconfirmed");
});

test("H1/RESOURCE-LIFETIME: preparation callback failure closes its capability without dropping unconfirmed metadata", async (t) => {
  const f = await createGitLeaseFixture(t), meta = leaseMeta(f);
  let capability: GitEnvArtifactDirectory | undefined;
  await assert.rejects(withCreatedRepoGitEnvLease({ dataDir: f.dataDir, meta }, async ({ artifactDir }) => {
    capability = artifactDir; throw new Error("fixture callback failure");
  }), { message: "fixture callback failure" });
  assert(capability); assert.equal(capability.directory.handle.fd, -1);
  assert.equal((await inspectRepoGitEnvLease({ dataDir: f.dataDir, leaseId: meta.leaseId }))?.state, "unconfirmed");
});
