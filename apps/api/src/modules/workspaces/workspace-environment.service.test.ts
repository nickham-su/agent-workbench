import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import Database from "better-sqlite3";
import type { Db } from "../../infra/db/db.js";
import { initSchema } from "../../infra/db/schema.js";
import { encryptUtf8, decryptToUtf8 } from "../../infra/crypto/secretBox.js";
import { HttpError } from "../../app/errors.js";
import { insertWorkspace } from "./workspace.store.js";
import { WorkspaceEnvironmentService, getWorkspaceEnvironmentService } from "./workspace-environment.service.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import type { AppContext } from "../../app/context.js";

const fixtures: Array<{ db: Db; ids: string[] }> = [];
const key = Buffer.alloc(32, 19);
const errorCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;
function fixture(options: { encrypt?: typeof encryptUtf8; decrypt?: typeof decryptToUtf8 } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  const ids: string[] = [];
  fixtures.push({ db, ids });
  const addWorkspace = (id = `w_${randomUUID()}`) => {
    ids.push(id);
    insertWorkspace(db, { id, dirName: id, title: "test", path: `/test/${id}`, terminalCredentialId: null, createdAt: 1, updatedAt: 1 });
    return id;
  };
  const workspaceId = addWorkspace();
  const otherId = addWorkspace();
  const service = new WorkspaceEnvironmentService(db, key, { encrypt: options.encrypt ?? encryptUtf8, decrypt: options.decrypt ?? decryptToUtf8 });
  return { db, service, workspaceId, otherId, addWorkspace };
}
afterEach(() => {
  for (const { db, ids } of fixtures.splice(0)) {
    for (const id of ids) workspaceDeletingFence.end(id);
    db.close();
  }
});

test("environment CRUD encrypts every value, preserves literal strings and partial updates", async () => {
  const { db, service, workspaceId, otherId } = fixture();
  const value = "  \r\n中文😀e\u0301'$PATH'$(never-run)  ";
  const a = await service.create(workspaceId, { name: "A", value });
  assert.equal(a.remark, ""); assert.equal(a.enabled, true);
  const raw = db.prepare("select * from workspace_environment_variables where id=?").get(a.id) as Record<string, unknown>;
  assert.equal(Object.hasOwn(raw, "value"), false);
  assert.notEqual(raw.value_enc, value);
  assert.equal(JSON.stringify(raw).includes(value), false);
  assert.equal(decryptToUtf8({ key, ciphertext: raw.value_enc as string }), value);
  const b = await service.create(otherId, { name: "A", value: "other" });
  const updated = await service.update(workspaceId, a.id, { remark: " unchanged value " });
  assert.equal(updated.value, value); assert.equal(updated.createdAt, a.createdAt);
  assert.equal((db.prepare("select value_enc from workspace_environment_variables where id=?").get(a.id) as any).value_enc, raw.value_enc);
  await service.update(workspaceId, a.id, { value: "", enabled: false });
  assert.equal(service.list(workspaceId)[0]!.value, "");
  assert.equal(service.list(workspaceId)[0]!.enabled, false);
  assert.deepEqual(Object.keys(service.readEnvironment(workspaceId)), []);
  await assert.rejects(() => service.update(workspaceId, b.id, { value: "leak" }), errorCode("WORKSPACE_ENV_VARIABLE_NOT_FOUND"));
  await assert.rejects(() => service.delete(workspaceId, b.id), errorCode("WORKSPACE_ENV_VARIABLE_NOT_FOUND"));
  assert.equal(service.list(otherId)[0]!.value, "other");
  await service.delete(workspaceId, a.id);
  await assert.rejects(() => service.delete(workspaceId, a.id), errorCode("WORKSPACE_ENV_VARIABLE_NOT_FOUND"));
});

test("environment writes serialize per item, preserve unsubmitted fields and conflict safely", async () => {
  const { service, workspaceId } = fixture();
  const outcomes = await Promise.allSettled([service.create(workspaceId, { name: "A", value: "first" }), service.create(workspaceId, { name: "A", value: "second" })]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code, "WORKSPACE_ENV_NAME_CONFLICT");
  const a = service.list(workspaceId)[0]!;
  const b = await service.create(workspaceId, { name: "a", value: "case" });
  await Promise.all([service.update(workspaceId, a.id, { remark: "new" }), service.update(workspaceId, a.id, { enabled: false }), service.update(workspaceId, b.id, { value: "other" })]);
  const result = service.list(workspaceId);
  assert.equal(result.find((r) => r.id === a.id)!.remark, "new");
  assert.equal(result.find((r) => r.id === a.id)!.enabled, false);
  assert.equal(result.find((r) => r.id === b.id)!.value, "other");
  await service.update(workspaceId, a.id, { value: "last" });
  await service.update(workspaceId, a.id, { value: "later" });
  assert.equal(service.list(workspaceId).find((r) => r.id === a.id)!.value, "later");
  assert.deepEqual(result.map((r) => r.id), service.list(workspaceId).map((r) => r.id));
});

test("environment cache hit has zero DB/decrypt work, empty snapshots cache, and callers cannot mutate it", async () => {
  let decryptions = 0;
  const { db, service, workspaceId, otherId } = fixture({ decrypt: (args) => { decryptions++; return decryptToUtf8(args); } });
  await service.create(workspaceId, { name: "__proto__", value: "own" });
  await service.create(workspaceId, { name: "constructor", value: "ctor" });
  await service.create(workspaceId, { name: "toString", value: "string" });
  const original = db.prepare.bind(db);
  let queries = 0;
  db.prepare = ((...args: Parameters<Db["prepare"]>) => { queries++; return original(...args); }) as Db["prepare"];
  const first = service.readEnvironment(workspaceId);
  assert.equal(first.__proto__, "own"); assert.equal(first.constructor, "ctor"); assert.equal(first.toString, "string");
  assert.equal(Object.getPrototypeOf(first), null);
  assert.equal(Object.isFrozen(first), true);
  assert.throws(() => { (first as Record<string, string>).X = "bad"; }, TypeError);
  assert.ok(queries > 0); const previousDecryptions = decryptions;
  queries = 0;
  assert.equal(service.readEnvironment(workspaceId), first);
  assert.equal(queries, 0); assert.equal(decryptions, previousDecryptions);
  service.readEnvironment(otherId); queries = 0;
  service.readEnvironment(otherId);
  assert.equal(queries, 0);
  workspaceDeletingFence.begin(workspaceId);
  assert.throws(() => service.readEnvironment(workspaceId), errorCode("WORKSPACE_DELETING"));
  assert.equal(queries, 0);
});

test("environment successful writes invalidate before return; failed writes preserve the correct snapshot", async () => {
  let failEncryption = false;
  const { service, workspaceId } = fixture({ encrypt: (args) => { if (failEncryption) throw new Error("fake-plaintext-must-not-leak"); return encryptUtf8(args); } });
  const a = await service.create(workspaceId, { name: "A", value: "old" });
  const before = service.readEnvironment(workspaceId);
  failEncryption = true;
  await assert.rejects(() => service.update(workspaceId, a.id, { value: "new" }), (error: unknown) => {
    assert.equal(String(error).includes("fake-plaintext"), false);
    return errorCode("WORKSPACE_ENV_PERSIST_FAILED")(error);
  });
  assert.equal(service.readEnvironment(workspaceId), before);
  assert.equal(service.list(workspaceId)[0]!.value, "old");
  failEncryption = false;
  await service.update(workspaceId, a.id, { value: "new" });
  assert.equal(before.A, "old"); assert.equal(service.readEnvironment(workspaceId).A, "new");
  await service.update(workspaceId, a.id, { enabled: false });
  assert.equal(Object.hasOwn(service.readEnvironment(workspaceId), "A"), false);
  await service.delete(workspaceId, a.id);
  assert.deepEqual(Object.keys(service.readEnvironment(workspaceId)), []);
});

test("environment uncertain transaction completion invalidates cached plaintext before returning a safe failure", async () => {
  const { db, service, workspaceId } = fixture();
  const variable = await service.create(workspaceId, { name: "A", value: "old" });
  const before = service.readEnvironment(workspaceId);
  const originalTransaction = db.transaction.bind(db);
  // Fault injection models an uncertain transaction boundary, not a claim that
  // better-sqlite3 normally commits successfully and then throws an I/O error.
  db.transaction = ((callback: () => unknown) => {
    const transaction = originalTransaction(callback);
    return Object.assign(() => {
      transaction();
      throw Object.assign(new Error("private-transaction-error-marker"), { code: "SQLITE_IOERR" });
    }, transaction);
  }) as typeof db.transaction;
  try {
    await assert.rejects(() => service.update(workspaceId, variable.id, { value: "new" }), (error: unknown) => {
      assert.equal(String(error).includes("private-transaction-error-marker"), false);
      return errorCode("WORKSPACE_ENV_PERSIST_FAILED")(error);
    });
  } finally { db.transaction = originalTransaction; }
  let queries = 0;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((...args: Parameters<Db["prepare"]>) => { queries++; return originalPrepare(...args); }) as Db["prepare"];
  const after = service.readEnvironment(workspaceId);
  assert.ok(queries > 0);
  assert.notEqual(after, before);
  assert.equal(before.A, "old");
  assert.equal(after.A, "new");
});

test("environment unknown transaction entry failure evicts the snapshot without claiming a write succeeded", async () => {
  const { db, service, workspaceId } = fixture();
  const variable = await service.create(workspaceId, { name: "A", value: "old" });
  const before = service.readEnvironment(workspaceId);
  const originalTransaction = db.transaction;
  db.transaction = (() => { throw Object.assign(new Error("private-entry-error-marker"), { code: "SQLITE_IOERR" }); }) as typeof db.transaction;
  try {
    await assert.rejects(() => service.update(workspaceId, variable.id, { value: "new" }), errorCode("WORKSPACE_ENV_PERSIST_FAILED"));
  } finally { db.transaction = originalTransaction; }
  let queries = 0;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = ((...args: Parameters<Db["prepare"]>) => { queries++; return originalPrepare(...args); }) as Db["prepare"];
  const after = service.readEnvironment(workspaceId);
  assert.ok(queries > 0);
  assert.notEqual(after, before);
  assert.equal(after.A, "old");
});

test("environment LRU evicts the oldest of 129 Workspace snapshots and refreshes access order", () => {
  const { db, service, workspaceId, addWorkspace } = fixture();
  const ids = [workspaceId, ...Array.from({ length: 128 }, () => addWorkspace())];
  for (const id of ids.slice(0, 128)) service.readEnvironment(id);
  service.readEnvironment(ids[0]!); // Refresh the oldest; index 1 is now the eviction candidate.
  service.readEnvironment(ids[128]!);
  const original = db.prepare.bind(db); let queries = 0;
  db.prepare = ((...args: Parameters<Db["prepare"]>) => { queries++; return original(...args); }) as Db["prepare"];
  service.readEnvironment(ids[0]!); assert.equal(queries, 0);
  service.readEnvironment(ids[1]!); assert.ok(queries > 0);
});

test("environment app instances never share cached plaintext even for identical Workspace IDs", async () => {
  const first = fixture(); const second = fixture();
  const sameId = first.workspaceId; second.addWorkspace(sameId);
  await first.service.create(sameId, { name: "A", value: "one" });
  await second.service.create(sameId, { name: "A", value: "two" });
  const ctx1 = { db: first.db, credentialMasterKey: key } as AppContext;
  const ctx2 = { db: second.db, credentialMasterKey: key } as AppContext;
  assert.equal(getWorkspaceEnvironmentService(ctx1), getWorkspaceEnvironmentService(ctx1));
  assert.notEqual(getWorkspaceEnvironmentService(ctx1), getWorkspaceEnvironmentService(ctx2));
  assert.equal(getWorkspaceEnvironmentService(ctx1).readEnvironment(sameId).A, "one");
  assert.equal(getWorkspaceEnvironmentService(ctx2).readEnvironment(sameId).A, "two");
});

test("environment invalid and damaged disabled rows fail closed, with explicit value replacement/deletion repair", async () => {
  const { db, service, workspaceId } = fixture();
  const a = await service.create(workspaceId, { name: "A", value: "secret", enabled: false });
  db.prepare("update workspace_environment_variables set value_enc=? where id=?").run("damaged-private-ciphertext", a.id);
  assert.throws(() => service.readEnvironment(workspaceId), errorCode("WORKSPACE_ENV_DECRYPT_FAILED"));
  assert.throws(() => service.list(workspaceId), errorCode("WORKSPACE_ENV_DECRYPT_FAILED"));
  await assert.rejects(() => service.update(workspaceId, a.id, { remark: "not a repair" }), errorCode("WORKSPACE_ENV_DECRYPT_FAILED"));
  await service.update(workspaceId, a.id, { value: "repaired" });
  assert.equal(service.list(workspaceId)[0]!.value, "repaired");
  db.prepare("update workspace_environment_variables set name=? where id=?").run("AWB_BAD", a.id);
  service.invalidate(workspaceId);
  assert.throws(() => service.readEnvironment(workspaceId), errorCode("WORKSPACE_ENV_INVALID_CONFIG"));
  await assert.rejects(() => service.create(workspaceId, { name: "B", value: "" }), errorCode("WORKSPACE_ENV_INVALID_CONFIG"));
  await service.delete(workspaceId, a.id);
  assert.equal(service.list(workspaceId).length, 0);
});

test("environment invalid persistent Unicode, NUL and metadata never enter the cache", async () => {
  let override: string | null = null;
  const { db, service, workspaceId } = fixture({ decrypt: (args) => override ?? decryptToUtf8(args) });
  const a = await service.create(workspaceId, { name: "A", value: "valid", enabled: false });
  for (const invalid of ["\ud800", "\udfff", "\0"]) {
    override = invalid;
    assert.throws(() => service.readEnvironment(workspaceId), errorCode("WORKSPACE_ENV_INVALID_CONFIG"));
  }
  override = null;
  db.prepare("update workspace_environment_variables set created_at=-1 where id=?").run(a.id);
  assert.throws(() => service.readEnvironment(workspaceId), errorCode("WORKSPACE_ENV_INVALID_CONFIG"));
  db.prepare("update workspace_environment_variables set created_at=1 where id=?").run(a.id);
  assert.deepEqual(Object.keys(service.readEnvironment(workspaceId)), []);
});

test("environment quota includes disabled rows and failed transactions do not partially commit", async () => {
  const { service, workspaceId, otherId } = fixture();
  for (const name of ["A", "B", "C", "D"]) await service.create(workspaceId, { name, value: "x".repeat(16381), enabled: false });
  const first = service.list(workspaceId)[0]!;
  await assert.rejects(() => service.update(workspaceId, first.id, { value: "x".repeat(16382) }), errorCode("WORKSPACE_ENV_LIMIT_EXCEEDED"));
  assert.equal(service.list(workspaceId)[0]!.value.length, 16381);
  for (let i = 0; i < 128; i++) await service.create(otherId, { name: `N${i}`, value: "", enabled: false });
  await assert.rejects(() => service.create(otherId, { name: "EXTRA", value: "" }), errorCode("WORKSPACE_ENV_LIMIT_EXCEEDED"));
  assert.equal(service.list(otherId).length, 128);
});

test("environment durable deletion, missing Workspace and transient DB failure are not cached as empty", async () => {
  const { db, service, workspaceId, otherId } = fixture();
  db.prepare("insert into workspace_deletion(workspace_id,dir_name,requested_at,updated_at) values (?,?,1,1)").run(workspaceId, workspaceId);
  assert.throws(() => service.readEnvironment(workspaceId), errorCode("WORKSPACE_DELETING"));
  await assert.rejects(() => service.create(workspaceId, { name: "A", value: "" }), errorCode("WORKSPACE_DELETING"));
  assert.throws(() => service.readEnvironment("missing"), errorCode("WORKSPACE_NOT_FOUND"));
  const original = db.prepare;
  db.prepare = (() => { throw Object.assign(new Error("private SQL data"), { code: "SQLITE_BUSY" }); }) as Db["prepare"];
  assert.throws(() => service.readEnvironment(otherId), errorCode("WORKSPACE_ENV_UNAVAILABLE"));
  db.prepare = original;
  assert.deepEqual(Object.keys(service.readEnvironment(otherId)), []);
});

test("environment schema upgrade is idempotent, ciphertext-only, case-sensitive and cascades narrowly", async () => {
  const { db, service, workspaceId, otherId } = fixture();
  await service.create(workspaceId, { name: "HTTP_PROXY", value: "one" });
  await service.create(workspaceId, { name: "http_proxy", value: "two" });
  await service.create(otherId, { name: "HTTP_PROXY", value: "other" });
  const before = db.prepare("select * from workspaces order by id").all();
  initSchema(db); initSchema(db);
  assert.deepEqual(db.prepare("select * from workspaces order by id").all(), before);
  assert.equal(service.list(workspaceId).length, 2);
  const row = db.prepare("select * from workspace_environment_variables where workspace_id=? limit 1").get(workspaceId) as any;
  assert.throws(() => db.prepare("insert into workspace_environment_variables values (?,?,?,?,?,?,?,?)").run("invalid", "missing", "A", row.value_enc, "", 1, 1, 1), /FOREIGN KEY/);
  assert.throws(() => db.prepare("update workspace_environment_variables set enabled=2 where id=?").run(row.id), /CHECK/);
  assert.throws(() => db.prepare("insert into workspace_environment_variables values (?,?,?,?,?,?,?,?)").run("duplicate", workspaceId, row.name, row.value_enc, "", 1, 1, 1), /UNIQUE/);
  db.prepare("delete from workspaces where id=?").run(workspaceId);
  service.invalidate(workspaceId);
  assert.throws(() => service.readEnvironment(workspaceId), errorCode("WORKSPACE_NOT_FOUND"));
  assert.equal((db.prepare("select count(*) as n from workspace_environment_variables where workspace_id=?").get(workspaceId) as any).n, 0);
  assert.equal(service.list(otherId).length, 1);
});
