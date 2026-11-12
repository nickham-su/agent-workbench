import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "node:test";
import { AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES } from "@agent-workbench/shared";
import { initSchema } from "../../../infra/db/schema.js";
import { retainWorkspaceAttachmentPublications } from "../../../infra/db/workspace-agent-data-cleanup.js";
import { HttpError } from "../../../app/errors.js";
import { AGENT_IMAGE_MAX_BYTES } from "./agent-attachment-limits.js";
import { AgentAttachmentPublicationStore } from "./agent-attachment-publication.store.js";

const HASH = "a".repeat(64);
const scope = { workspaceId: "w1", sessionId: "s1", clientRequestId: "request" };
const image = (id = "one", byteSize = 12) => ({ attachmentId: `att_${id}`, storageKey: `att_${id}.png`,
  mediaType: "image/png" as const, byteSize, byteSha256: HASH });
const reservation = (id = "one", byteSize = 12) => ({ ...scope, payloadHash: HASH, workspaceDirName: "w1",
  publisherGeneration: "generation-1", images: [image(id, byteSize)] });
function fixture(t: import("node:test").TestContext) {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON"); initSchema(db);
  t.after(() => db.close());
  return { db, store: new AgentAttachmentPublicationStore(db, () => 10) };
}
function hasError(statusCode: number, code?: string) {
  return (error: unknown) => error instanceof HttpError && error.statusCode === statusCode && (!code || error.code === code);
}
function seedCharge(db: Database.Database, total: number) {
  const insert = db.prepare(`insert into agent_attachment_publication_intent
    (id,workspace_id,session_id,client_request_id,image_position,payload_hash,byte_sha256,attachment_id,
     storage_key,workspace_dir_name,byte_size,media_type,state,publisher_generation,created_at,updated_at)
    values (?,'seed','seed',?,0,?,?,?,?,'seed',?,'image/png','reserved','seed',1,1)`);
  db.transaction(() => {
    for (let index = 0, remaining = total; remaining > 0; index++) {
      const bytes = Math.min(remaining, AGENT_IMAGE_MAX_BYTES);
      insert.run(`seed-${index}`, `seed-${index}`, HASH, HASH, `att_seed-${index}`, `att_seed-${index}.png`, bytes);
      remaining -= bytes;
    }
  })();
}

test("reservation commits the entire request, and an identical replay adopts stable IDs rather than upload temp identity", (t) => {
  const { store } = fixture(t);
  const request = { ...reservation(), images: [image("one"), image("two", 15)] };
  const first = store.reserveRequest(request);
  const replay = store.reserveRequest({ ...request, publisherGeneration: "generation-2", images: [image("new-one"), image("new-two", 15)] });
  assert.deepEqual(replay.map(value => [value.id, value.attachmentId]), first.map(value => [value.id, value.attachmentId]));
  assert.ok(replay.every(value => value.publisherGeneration === "generation-2"));
  assert.deepEqual(store.getRetention(), { scope: "agent_web_queue_v1", limitBytes: AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES,
    chargedBytes: 27, reservedBytes: 27, retainedBytes: 0 });
});

test("same request with a different payload, bytes, count, media or Workspace directory conflicts without allocating", (t) => {
  const { store } = fixture(t); store.reserveRequest(reservation());
  const changes = [
    { ...reservation(), payloadHash: "b".repeat(64) },
    { ...reservation(), images: [{ ...image(), byteSha256: "b".repeat(64) }] },
    { ...reservation(), images: [image("one", 13)] },
    { ...reservation(), images: [] },
    { ...reservation(), workspaceDirName: "other" },
    { ...reservation(), images: [{ ...image(), mediaType: "image/jpeg" as const, storageKey: "att_one.jpg" }] },
  ];
  for (const request of changes) assert.throws(() => store.reserveRequest(request), hasError(409, "AGENT_REQUEST_PAYLOAD_CONFLICT"));
  assert.equal(store.getRequest(scope).length, 1);
  assert.equal(store.getRetention().chargedBytes, 12);
});

test("capacity failure is atomic for the whole request, even when its first image alone would fit", (t) => {
  const { db, store } = fixture(t); seedCharge(db, AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES - 20);
  assert.throws(() => store.reserveRequest({ ...reservation(), images: [image("one", 12), image("two", 12)] }),
    hasError(507, "AGENT_ATTACHMENT_RETENTION_CAPACITY_EXCEEDED"));
  assert.equal(store.getRequest(scope).length, 0);
  assert.equal(store.getRetention().chargedBytes, AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES - 20);
});

test("two SQLite connections cannot reserve more than the shared DataDir limit", async (t) => {
  const tempRoot = path.resolve(import.meta.dirname, "../../../../../../.tmp-tests"); await fs.mkdir(tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tempRoot, "publication-quota-"));
  const db1 = new Database(path.join(dir, "db.sqlite")); initSchema(db1); db1.pragma("journal_mode=WAL");
  const db2 = new Database(path.join(dir, "db.sqlite"));
  t.after(async () => { db2.close(); db1.close(); await fs.rm(dir, { recursive: true, force: true }); });
  seedCharge(db1, AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES - 20);
  const stores = [new AgentAttachmentPublicationStore(db1), new AgentAttachmentPublicationStore(db2)];
  const outcomes = await Promise.allSettled(stores.map((store, index) => Promise.resolve().then(() =>
    store.reserveRequest({ ...reservation(`parallel-${index}`, 12), clientRequestId: `parallel-${index}` }))));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(hasError(507, "AGENT_ATTACHMENT_RETENTION_CAPACITY_EXCEEDED")(rejected.reason));
  assert.equal(stores[0]!.getRetention().chargedBytes, AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES - 8);
});

test("reservation and the publishing CAS reject enclosing receipt transactions", (t) => {
  const { db, store } = fixture(t);
  assert.throws(() => db.transaction(() => store.reserveRequest(reservation()))(), /independent transaction/);
  assert.equal(store.getRequest(scope).length, 0);
  const [intent] = store.reserveRequest(reservation());
  assert.throws(() => db.transaction(() => store.beginPublishing(intent!.id, "generation-1"))(), /independent transaction/);
  assert.equal(store.getRequest(scope)[0]!.state, "reserved");
});

test("publishing is a one-winner durable CAS and never returns to uncharged unpublished state", (t) => {
  const { store } = fixture(t); const [intent] = store.reserveRequest(reservation());
  assert.throws(() => store.beginPublishing(intent!.id, "wrong-generation"), hasError(409));
  store.beginPublishing(intent!.id, "generation-1");
  assert.throws(() => store.beginPublishing(intent!.id, "generation-1"), hasError(409));
  store.releaseReservedUnpublished(scope, "generation-1");
  assert.equal(store.getRequest(scope)[0]!.state, "publishing");
  assert.equal(store.getRetention().chargedBytes, 12);
  assert.throws(() => store.reserveRequest(reservation()), hasError(409, "AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN"));
});

test("recovery frees only provably reserved old generations; unknown publications remain charged and never republish", (t) => {
  const { store } = fixture(t);
  const reserved = store.reserveRequest(reservation());
  const publishingScope = { ...scope, clientRequestId: "publishing" };
  const publishing = store.reserveRequest({ ...reservation("publishing"), ...publishingScope });
  store.beginPublishing(publishing[0]!.id, "generation-1");
  const currentScope = { ...scope, clientRequestId: "current" };
  store.reserveRequest({ ...reservation("current"), ...currentScope, publisherGeneration: "generation-2" });
  store.recoverPreviousPublishers("generation-2");
  assert.equal(store.getRequest(scope)[0]!.state, "released_unpublished");
  assert.equal(store.getRequest(publishingScope)[0]!.state, "retained");
  assert.equal(store.getRequest(publishingScope)[0]!.retentionCode, "outcome_unknown");
  assert.equal(store.getRequest(currentScope)[0]!.state, "reserved");
  assert.equal(store.getRetention().chargedBytes, 24);
  const retried = store.reserveRequest({ ...reservation("new-upload"), publisherGeneration: "generation-2" });
  assert.equal(retried[0]!.id, reserved[0]!.id);
  assert.equal(retried[0]!.attachmentId, "att_one");
  assert.equal(store.getRetention().chargedBytes, 36);
  assert.throws(() => store.reserveRequest({ ...reservation("new-publishing"), ...publishingScope }), hasError(409));
});

test("a prepared old publisher loses authority when its still-reserved row is adopted", (t) => {
  const { store } = fixture(t); const [intent] = store.reserveRequest(reservation());
  store.reserveRequest({ ...reservation(), publisherGeneration: "generation-2" });
  assert.throws(() => store.beginPublishing(intent!.id, "generation-1"), hasError(409));
  store.beginPublishing(intent!.id, "generation-2");
  store.recordPublished(intent!.id, "generation-2", { dev: 1, ino: 42 });
  assert.equal(store.getRetention().reservedBytes, 0);
  assert.equal(store.getRetention().retainedBytes, 12);
});

test("same-generation release cannot release another owner's reservation or any published file", (t) => {
  const { store } = fixture(t); const [intent] = store.reserveRequest(reservation());
  store.releaseReservedUnpublished(scope, "other"); assert.equal(store.getRetention().chargedBytes, 12);
  store.beginPublishing(intent!.id, "generation-1"); store.recordPublished(intent!.id, "generation-1", { dev: 1, ino: 2 });
  store.releaseReservedUnpublished(scope, "generation-1");
  assert.equal(store.getRequest(scope)[0]!.state, "published");
  store.retainRequest(scope, "business_rollback");
  assert.equal(store.getRequest(scope)[0]!.state, "retained");
  assert.equal(store.getRetention().chargedBytes, 12);
});

test("logical Workspace deletion marks retained without a foreign-key cascade or quota refund", (t) => {
  const { db, store } = fixture(t); store.reserveRequest(reservation());
  retainWorkspaceAttachmentPublications(db, "different"); assert.equal(store.getRequest(scope)[0]!.state, "reserved");
  retainWorkspaceAttachmentPublications(db, "w1", 20);
  const [intent] = store.getRequest(scope);
  assert.equal(intent!.state, "retained"); assert.equal(intent!.retentionCode, "workspace_logically_deleted");
  assert.equal(store.getRetention().chargedBytes, 12);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("offline maintenance is not an online release API; schema requires a retained audit tombstone", (t) => {
  const { db, store } = fixture(t); const [intent] = store.reserveRequest(reservation());
  store.beginPublishing(intent!.id, "generation-1"); store.recordPublished(intent!.id, "generation-1", { dev: 1, ino: 2 });
  assert.throws(() => db.prepare("update agent_attachment_publication_intent set state='released_offline_maintenance' where id=?").run(intent!.id), /CHECK/);
  assert.throws(() => db.prepare("update agent_attachment_publication_intent set state='released_offline_maintenance',maintenance_id='m' where id=?").run(intent!.id), /CHECK/);
  assert.equal(store.getRetention().chargedBytes, 12);
  // Simulates an operator's offline audited adjustment, not an exported method.
  db.prepare("update agent_attachment_publication_intent set state='released_offline_maintenance',maintenance_id='offline-proof',released_at=30 where id=?").run(intent!.id);
  assert.equal(store.getRetention().chargedBytes, 0);
  const tombstone = store.getRequest(scope)[0]!;
  assert.equal(tombstone.maintenanceId, "offline-proof"); assert.equal(tombstone.releasedAt, 30);
  assert.throws(() => store.reserveRequest(reservation()), hasError(409, "AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN"));
  assert.equal(store.getRequest(scope).length, 1);
});

test("image limits and path identifiers fail before reservation", (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.reserveRequest({ ...reservation(), images: Array.from({ length: 5 }, (_, index) => image(`n-${index}`)) }), hasError(400));
  assert.throws(() => store.reserveRequest({ ...reservation(), images: [image("oversize", AGENT_IMAGE_MAX_BYTES + 1)] }), hasError(400));
  assert.throws(() => store.reserveRequest({ ...reservation(), images: [image("a", AGENT_IMAGE_MAX_BYTES), image("b", AGENT_IMAGE_MAX_BYTES), image("c")] }), hasError(413));
  assert.throws(() => store.reserveRequest({ ...reservation(), workspaceDirName: "../escape" }), hasError(400));
  assert.throws(() => store.reserveRequest({ ...reservation(), images: [{ ...image(), storageKey: "../../escape" }] }), hasError(400));
  assert.throws(() => store.reserveRequest({ ...reservation(), images: [{ ...image(), byteSha256: "not-a-hash" }] }), hasError(400));
  assert.equal(store.getRetention().chargedBytes, 0);
});
