import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import { createGitLeaseFixture, addFixtureCredential } from "./git-env.testkit.js";
import { registerGitEnvRoutes } from "./git-env.routes.js";
import { listRepoGitEnvLeaseIds } from "./git-env.lease.js";
import { setSettingJson } from "../settings/settings.store.js";
import { sshKnownHostsPath, repoMirrorPath } from "../../infra/fs/paths.js";
import { syncRepo, getRepoById } from "../repos/repo.service.js";
import { cloneFromMirror } from "../../infra/git/clone.js";
import { withRepoLock } from "../../infra/locks/repoLock.js";

const workerGit = await import(new URL("../../../../agent-worker/src/runtime/git.ts", import.meta.url).href);
const workerClient = await import(new URL("../../../../agent-worker/src/runtime/apiClient.ts", import.meta.url).href);
async function fixture(t: TestContext) {
  const f = await createGitLeaseFixture(t, { repoName: "auth-repo" });
  execFileSync("git", ["init", "--quiet"], { cwd: f.repository.workspaceRepo.path, stdio: "pipe" });
  const app = Fastify({ logger: false });
  await registerGitEnvRoutes(app, f.ctx);
  const apiOrigin = await app.listen({ port: 0, host: "127.0.0.1" });
  t.after(() => app.close());
  const apiClient = new workerClient.AgentApiClient({ apiOrigin, internalToken: f.internalToken, internalRpcTimeoutMs: 2000, responseValidation: "strict", logger: { warn() {} } });
  const context = { profile: { agent: { tools: ["git"] } }, run: { ...f.owner, workspacePath: f.workspace.path, workspaceRepoDirNames: [] }, pendingTool: { toolName: "git", toolExecutionId: f.owner.toolExecutionId, args: {}, status: "running" }, apiClient, signal: new AbortController().signal, promptContext: { workspaceRepoNames: [f.request.repo] } };
  return { ...f, execute: (args: string[]) => workerGit.executeGitTool({ repo: f.request.repo, args, timeout: 15 }, context, { dataDir: f.dataDir }), bind(url: string, credentialId: string | null) { f.db.prepare("update repos set url=?, credential_id=? where id=?").run(url, credentialId, f.repository.repo.id); } };
}
function assertSafe(result: unknown, secrets: string[]) {
  const json = JSON.stringify(result);
  for (const secret of secrets) assert(!json.includes(secret), "result must not expose fixture credential/path");
  assert(!/BEGIN .*PRIVATE KEY/.test(json));
}

test("AC-AUTH-HTTPS/NETWORK/SYSTEM: real TLS Git challenge invokes lease askpass; wrong token fails and none can use a fixture system helper", async (t) => {
  const f = await fixture(t), certFile = path.join(f.dataDir, "fixture-cert.pem"), keyFile = path.join(f.dataDir, "fixture-tls-key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "pipe" });
  const pem = await fs.readFile(certFile, "utf8");
  // Never consult the host CA store; the fixture's system bundle is valid too.
  await fs.writeFile(process.env.SSL_CERT_FILE!, pem);
  setSettingJson(f.db, "network", { caCertPem: pem, noProxy: "127.0.0.1", httpProxy: null, httpsProxy: null }, Date.now());
  const secret = "fixture-https-stage5-only", wrongSecret = "fixture-wrong-stage5-only";
  let challenged = 0, authenticated = 0;
  const server = createHttpsServer({ key: await fs.readFile(keyFile), cert: pem }, (request, response) => {
    if (request.headers.authorization !== `Basic ${Buffer.from(`fixture-user:${secret}`).toString("base64")}`) {
      challenged++; response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' }); response.end(); return;
    }
    authenticated++;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(request.url?.includes("info/refs") ? `${"1".repeat(40)}\trefs/heads/fixture\n` : "ref: refs/heads/fixture\n");
  });
  await new Promise<void>((resolve, reject) => { server.listen(0, "127.0.0.1", resolve); server.once("error", reject); });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert(address && typeof address !== "string");
  const url = `https://127.0.0.1:${address.port}/fixture.git`;
  f.bind(url, addFixtureCredential(f, { host: "127.0.0.1", isDefault: false, secret }));
  const success = await f.execute(["ls-remote", url]);
  assert.equal(success.ok, true); assert.match(success.stdout, /refs\/heads\/fixture/);
  assert(challenged > 0 && authenticated > 0, "real TLS challenge/Basic authentication completed");
  assert.equal(success.leaseDisposition, "released"); assertSafe(success, [secret, f.dataDir]);
  f.bind(url, addFixtureCredential(f, { host: "127.0.0.1", isDefault: false, secret: wrongSecret }));
  const failure = await f.execute(["ls-remote", url]);
  assert.equal(failure.ok, false); assert.equal(failure.leaseDisposition, "released"); assertSafe(failure, [secret, wrongSecret, f.dataDir]);
  // Host authentication remains allowed with kind=none. Use only a private
  // fixture helper, never the operator's real helper, HOME or identity.
  f.bind(url, null); f.db.prepare("delete from credentials").run();
  const helper = path.join(f.dataDir, "fixture-credential-helper.sh");
  await fs.writeFile(helper, `#!/bin/sh\nif [ "$1" = get ]; then printf '%s\\n' username=fixture-user password=${secret}; fi\n`, { mode: 0o700 });
  const authenticatedBefore = authenticated;
  const system = await f.execute(["-c", `credential.helper=${helper}`, "ls-remote", url]);
  assert.equal(system.ok, true); assert.equal(system.leaseDisposition, "released");
  assert(authenticated > authenticatedBefore, "none lease preserved the native fixture helper");
  assertSafe(system, [secret, f.dataDir]);
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});

test("AC-AUTH-SSH/REGRESSION-API: actual OpenSSH requires the lease key, API mirror/clone keep auth, and accept-new rejects changed hosts", async (t) => {
  const f = await fixture(t);
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], { cwd: f.repository.workspaceRepo.path, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "fixture"], { cwd: f.repository.workspaceRepo.path, stdio: "pipe" });
  const require = createRequire(import.meta.url);
  const ssh2 = require("ssh2"); // Managed test-only API devDependency, resolved normally.
  assert.equal(require("ssh2/package.json").version, "1.17.0");
  const key = (name: string) => path.join(f.dataDir, name);
  for (const name of ["host-a", "host-b", "client", "wrong-client"]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key(name)], { stdio: "pipe" });
  const privateKey = await fs.readFile(key("client"), "utf8"), wrongKey = await fs.readFile(key("wrong-client"), "utf8");
  const publicKey = ssh2.utils.parseKey(privateKey);
  let acceptedKeys = 0, execs = 0;
  const clients = new Set<any>();
  const create = async (host: string, port = 0) => {
    const server = new ssh2.Server({ hostKeys: [await fs.readFile(key(host))] }, (client: any) => {
      clients.add(client); client.on("close", () => clients.delete(client)); client.on("error", () => {});
      client.on("authentication", (auth: any) => {
        const matches = auth.method === "publickey" && auth.username === "fixture" && auth.key.data.equals(publicKey.getPublicSSH());
        if (matches && (!auth.signature || publicKey.verify(auth.blob, auth.signature, auth.hashAlgo) === true)) { if (auth.signature) acceptedKeys++; auth.accept(); } else auth.reject();
      });
      client.on("ready", () => client.on("session", (accept: any) => accept().on("exec", (acceptExec: any, reject: any, info: { command: string }) => {
        if (info.command !== "git-upload-pack '/fixture.git'") { reject(); return; }
        execs++;
        const channel = acceptExec();
        const child = spawn("git-upload-pack", [f.repository.workspaceRepo.path], { cwd: f.repository.workspaceRepo.path, env: process.env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
        channel.pipe(child.stdin); child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false });
        child.on("error", () => { channel.exit(1); channel.end(); });
        child.on("close", (code) => { channel.exit(code ?? 1); channel.end(); });
      })));
    });
    await new Promise<void>((resolve, reject) => { server.listen(port, "127.0.0.1", resolve); server.once("error", reject); });
    return server;
  };
  let server = await create("host-a");
  const close = () => new Promise<void>((resolve, reject) => { for (const client of clients) client.end(); server.close((error?: Error) => error ? reject(error) : resolve()); });
  t.after(() => close());
  const address = server.address(); assert(address && typeof address !== "string");
  const url = `ssh://fixture@127.0.0.1:${address.port}/fixture.git`;
  const bind = (secret: string) => f.bind(url, addFixtureCredential(f, { kind: "ssh", host: "127.0.0.1", isDefault: false, secret }));
  bind(privateKey);
  const success = await f.execute(["ls-remote", url]);
  assert.equal(success.ok, true); assert.equal(success.leaseDisposition, "released"); assert.equal(acceptedKeys, 1); assert.equal(execs, 1);
  const knownHosts = await fs.readFile(sshKnownHostsPath(f.dataDir), "utf8");
  assert(knownHosts.trim(), "accept-new persisted the host key"); assertSafe(success, [privateKey, f.dataDir]);
  // Exercise the existing UI/API service, not the native Worker lease path.
  assert.equal((await syncRepo(f.ctx, { error() {} } as any, f.repository.repo.id)).started, true);
  await withRepoLock(f.repository.repo.id, async () => {});
  const synced = await getRepoById(f.ctx, f.repository.repo.id);
  assert.equal(synced.syncStatus, "idle", synced.syncError?.replaceAll(f.dataDir, "<fixture-root>"));
  const mirrorPath = repoMirrorPath(f.dataDir, f.repository.repo.id), clonePath = path.join(f.dataDir, "ui-clone");
  await cloneFromMirror({ mirrorPath, repoUrl: url, worktreePath: clonePath, branch: "fixture", dataDir: f.dataDir });
  const head = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe" }).toString().trim();
  assert.equal(head(clonePath), head(f.repository.workspaceRepo.path));
  assert.equal(execFileSync("git", ["remote", "get-url", "origin"], { cwd: clonePath, stdio: "pipe" }).toString().trim(), url);
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
  const completedExecs = execs; assert(completedExecs > 1);
  bind(wrongKey);
  const denied = await f.execute(["ls-remote", url]);
  assert.equal(denied.ok, false); assert.equal(execs, completedExecs, "no alternate identity/fallback reaches exec"); assertSafe(denied, [privateKey, wrongKey, f.dataDir]);
  await close(); server = await create("host-b", address.port); bind(privateKey);
  const changedHost = await f.execute(["ls-remote", url]);
  assert.equal(changedHost.ok, false); assert.equal(execs, completedExecs, "changed known host cannot run upload-pack");
  assert.equal(await fs.readFile(sshKnownHostsPath(f.dataDir), "utf8"), knownHosts);
  // known_hosts is a non-secret diagnostic path outside the promised literal
  // token/key/askpass/lease-path set (AC-OUTPUT-PATH-LIMITATION).
  assertSafe(changedHost, [privateKey, wrongKey]);
  assert.deepEqual(await listRepoGitEnvLeaseIds(f.dataDir), []);
});
