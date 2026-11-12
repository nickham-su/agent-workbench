import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { test, type TestContext } from "node:test";
import Database from "better-sqlite3";
import { Value } from "@sinclair/typebox/value";
import { AgentAttachmentRetentionResponseSchema, AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES } from "@agent-workbench/shared";
import { HttpError } from "../../../app/errors.js";
import { initSchema } from "../../../infra/db/schema.js";
import { deleteWorkspaceAgentData } from "../../../infra/db/workspace-agent-data-cleanup.js";
import { workspaceLifecycleCoordinator } from "../../../infra/locks/workspace-lifecycle-coordinator.js";
import { workspaceDeletingFence } from "../lifecycle/workspace-deleting-fence.js";
import { agentAttachmentTempFilePath } from "./agent-attachment-paths.js";
import { stageAgentImageUpload } from "./agent-attachment-storage.js";
import { AgentAttachmentPublicationService, type PublishQueueRequest, type PublishedQueueImage } from "./agent-attachment-publication.service.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HASH = createHash("sha256").update("original-request").digest("hex");
const requestScope = { workspaceId: "w1", sessionId: "s1", clientRequestId: "request" };
const errorIs = (statusCode: number, code?: string) => (error: unknown) => error instanceof HttpError
  && error.statusCode === statusCode && (!code || error.code === code);

async function fixture(t: TestContext) {
  const tempRoot = path.resolve(import.meta.dirname, "../../../../../../.tmp-tests"); await fs.mkdir(tempRoot, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(tempRoot, "publication-service-"));
  const db = new Database(path.join(dataDir, "db.sqlite")); db.pragma("foreign_keys=ON"); initSchema(db); db.pragma("journal_mode=WAL");
  const workspacePath = path.join(dataDir, "workspaces", "w1"); await fs.mkdir(workspacePath, { recursive: true });
  db.prepare("insert into workspaces(id,dir_name,title,path,created_at,updated_at) values ('w1','w1','Test',?,1,1)").run(workspacePath);
  db.prepare("insert into agent_session(id,workspace_id,title,kind,created_at,updated_at) values ('s1','w1','Session','primary',1,1)").run();
  db.prepare("insert into agent_session_queue_control(workspace_id,session_id,mode,queue_version,next_sequence,updated_at) values ('w1','s1','active',0,1,1)").run();
  t.after(async () => { workspaceDeletingFence.end("w1"); db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const upload = (suffix: string = randomUUID(), bytes = PNG) => stageAgentImageUpload({
    dataDir, attachmentId: `att_${suffix}`, tempId: `tmp_${suffix}`, filename: "picture.png",
    stream: Readable.from([bytes]), onBytes: () => undefined,
  });
  const service = (extra: Partial<ConstructorParameters<typeof AgentAttachmentPublicationService>[0]> = {}) =>
    new AgentAttachmentPublicationService({ db, dataDir, publisherGeneration: "generation-1", nowMs: () => 10, ...extra });
  const request = async (suffix?: string): Promise<PublishQueueRequest> => ({ ...requestScope, payloadHash: HASH, images: [await upload(suffix)] });
  const commit = (input: PublishQueueRequest) => ({ images, existingReceiptId }: { images: readonly PublishedQueueImage[]; existingReceiptId: string | null }) => {
    if (existingReceiptId !== null) {
      const existing = db.prepare("select status from agent_user_message_receipt where id=?").get(existingReceiptId) as { status: string };
      return { receiptId: existingReceiptId, value: { receiptId: existingReceiptId, status: existing.status, attachmentIds: images.map(image => image.attachmentId) } };
    }
    const receiptId = `receipt-${input.clientRequestId}`;
    const sequence = (db.prepare("select next_sequence from agent_session_queue_control where session_id='s1'").get() as { next_sequence: number }).next_sequence;
    db.prepare(`insert into agent_user_message_receipt (id,workspace_id,session_id,client_request_id,sequence,payload_hash,status,
      input_text,text,payload_bytes,attachment_count,agent_id,provider_id,model_id,created_at,updated_at)
      values (?,'w1','s1',?,?,?,'queued','hello','hello',?,?,'a','p','m',1,1)`)
      .run(receiptId, input.clientRequestId, sequence, input.payloadHash, 5 + images.reduce((sum, image) => sum + image.byteSize, 0), images.length);
    for (const [position, image] of images.entries()) {
      db.prepare(`insert into agent_attachment (id,workspace_id,storage_key,filename,media_type,byte_size,created_at) values (?,'w1',?,?,?,?,1)`)
        .run(image.attachmentId, image.storageKey, image.filename, image.mediaType, image.byteSize);
      db.prepare(`insert into agent_user_message_receipt_attachment (workspace_id,session_id,receipt_id,position,attachment_id,byte_sha256)
        values ('w1','s1',?,?,?,?)`).run(receiptId, position, image.attachmentId, image.byteSha256);
    }
    db.prepare("update agent_session_queue_control set next_sequence=next_sequence+1,queue_version=queue_version+1 where session_id='s1'").run();
    return { receiptId, value: { receiptId, status: "queued", attachmentIds: images.map(image => image.attachmentId) } };
  };
  return { db, dataDir, workspacePath, upload, request, service, commit };
}

test("staging records byte SHA-256; publication binds bytes/inode and associates the real receipt transaction", async (t) => {
  const data = await fixture(t); const service = data.service(); const request = await data.request("first");
  assert.equal(request.images[0]!.byteSha256, createHash("sha256").update(PNG).digest("hex"));
  const result = await service.publishAndCommit(request, data.commit(request));
  assert.equal(result.receiptId, "receipt-request");
  const [intent] = service.store.getRequest(request); assert.equal(intent!.state, "published");
  assert.equal(intent!.receiptId, result.receiptId);
  const finalPath = path.join(data.workspacePath, ".awb/agent/attachments", request.images[0]!.storageKey);
  assert.deepEqual(await fs.readFile(finalPath), PNG);
  const stat = await fs.stat(finalPath, { bigint: true });
  assert.equal(intent!.ownedDev, String(stat.dev)); assert.equal(intent!.ownedIno, String(stat.ino));
  assert.ok(Value.Check(AgentAttachmentRetentionResponseSchema, service.getRetention()));
  const publicStatus = JSON.stringify(service.getRequestStatus(request));
  assert.ok(!publicStatus.includes(data.dataDir)); assert.ok(!publicStatus.includes(intent!.storageKey)); assert.ok(!publicStatus.includes(HASH));
  assert.deepEqual(data.db.pragma("foreign_key_check"), []);
});

test("receipt failure cannot roll back the published reservation; safe retry reuses its exact file and IDs", async (t) => {
  const data = await fixture(t); const service = data.service(); const request = await data.request("first");
  await assert.rejects(service.publishAndCommit(request, () => { throw new Error(`private failure at ${data.dataDir}`); }), (error: unknown) => {
    assert.ok(error instanceof HttpError); assert.equal(error.statusCode, 503); assert.ok(!error.message.includes(data.dataDir)); return true;
  });
  const [intent] = service.store.getRequest(request); assert.equal(intent!.state, "retained");
  assert.equal(intent!.retentionCode, "business_rollback"); assert.notEqual(intent!.ownedIno, null);
  assert.equal(service.getRetention().chargedBytes, PNG.length);
  assert.equal((data.db.prepare("select count(*) as count from agent_user_message_receipt").get() as { count: number }).count, 0);
  const retry = await data.request("new-upload");
  const result = await service.publishAndCommit(retry, data.commit(retry));
  assert.deepEqual(result.attachmentIds, ["att_first"]);
  assert.deepEqual(await fs.readdir(path.join(data.workspacePath, ".awb/agent/attachments")), ["att_first.png"]);
  assert.equal(service.store.getRequest(request)[0]!.id, intent!.id);
  assert.equal(service.getRetention().chargedBytes, PNG.length);
});

test("independent reservation is visible before receipt commit and survives rollback on another connection", async (t) => {
  const data = await fixture(t); const reader = new Database(path.join(data.dataDir, "db.sqlite")); t.after(() => reader.close());
  const service = data.service(); const request = await data.request("independent");
  await assert.rejects(service.publishAndCommit(request, value => {
    data.commit(request)(value);
    const rows = reader.prepare("select state,receipt_id from agent_attachment_publication_intent").all() as Array<{ state: string; receipt_id: string | null }>;
    assert.deepEqual(rows, [{ state: "published", receipt_id: null }]);
    assert.equal((reader.prepare("select count(*) as count from agent_user_message_receipt").get() as { count: number }).count, 0);
    throw new Error("rollback receipt");
  }), errorIs(503));
  assert.equal(service.getRetention().chargedBytes, PNG.length);
  assert.equal((reader.prepare("select count(*) as count from agent_user_message_receipt").get() as { count: number }).count, 0);
});

test("a later image's invalid source aborts the entire preflight before any file is linked", async (t) => {
  const data = await fixture(t); const service = data.service();
  const first = await data.upload("preflight-first"); const second = await data.upload("preflight-second");
  const request = { ...requestScope, payloadHash: HASH, images: [first, { ...second, byteSha256: "b".repeat(64) }] };
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(503));
  assert.equal(service.getRetention().chargedBytes, 0);
  assert.deepEqual(service.store.getRequest(request).map(intent => intent.state), ["released_unpublished", "released_unpublished"]);
  assert.deepEqual(await fs.readdir(path.join(data.workspacePath, ".awb/agent/attachments")), []);
});

test("partial publication retains known and unknown links but releases the unattempted request suffix", async (t) => {
  const data = await fixture(t); const service = data.service({ forTest: {
    afterPublishingBoundary: position => { if (position === 1) throw new Error("interrupted second publication"); },
  } });
  const request = { ...requestScope, payloadHash: HASH,
    images: [await data.upload("partial-first"), await data.upload("partial-second"), await data.upload("partial-third")] };
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(503));
  const intents = service.store.getRequest(request);
  assert.deepEqual(intents.map(intent => intent.state), ["retained", "retained", "released_unpublished"]);
  assert.notEqual(intents[0]!.ownedIno, null); assert.equal(intents[1]!.ownedIno, null);
  assert.equal(intents[1]!.retentionCode, "outcome_unknown");
  assert.equal(service.getRetention().chargedBytes, 2 * PNG.length);
  assert.deepEqual(await fs.readdir(path.join(data.workspacePath, ".awb/agent/attachments")), ["att_partial-first.png"]);
  const retry = { ...request, images: [await data.upload("retry-first"), await data.upload("retry-second"), await data.upload("retry-third")] };
  await assert.rejects(service.publishAndCommit(retry, data.commit(retry)), errorIs(409, "AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN"));
  assert.equal(service.getRetention().chargedBytes, 2 * PNG.length);
});

test("publication rejects an enclosing transaction before asynchronous admission can escape it", async (t) => {
  const data = await fixture(t); const service = data.service(); const request = await data.request("nested");
  let attempted!: Promise<unknown>;
  data.db.transaction(() => { attempted = service.publishAndCommit(request, data.commit(request)); })();
  await assert.rejects(attempted, /independent transaction/);
  assert.equal(service.getRetention().chargedBytes, 0);
  assert.equal(service.store.getRequest(request).length, 0);
});

for (const point of ["afterPublishingBoundary", "afterPublishBeforeRecord"] as const) {
  test(`interruption at ${point} retains unknown outcome and never republishes`, async (t) => {
    const data = await fixture(t); const service = data.service({ forTest: { [point]: () => { throw new Error("interrupted"); } } });
    const request = await data.request("unknown");
    await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(503));
    const [intent] = service.store.getRequest(request);
    assert.equal(intent!.state, "retained"); assert.equal(intent!.retentionCode, "outcome_unknown"); assert.equal(intent!.ownedIno, null);
    assert.equal(service.getRetention().chargedBytes, PNG.length);
    const directory = path.join(data.workspacePath, ".awb/agent/attachments");
    const before = await fs.readdir(directory);
    assert.deepEqual(before, point === "afterPublishBeforeRecord" ? ["att_unknown.png"] : []);
    const retry = await data.request("new-unknown");
    await assert.rejects(data.service({ publisherGeneration: "generation-2" }).publishAndCommit(retry, data.commit(retry)), errorIs(409, "AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN"));
    assert.deepEqual(await fs.readdir(directory), before);
    assert.equal(service.store.getRequest(request).length, 1);
    assert.equal(service.getRetention().chargedBytes, PNG.length);
  });
}

test("commit succeeded but response was lost: query/retry returns the same receipt without publication or double charging", async (t) => {
  const data = await fixture(t); const service = data.service({ forTest: { afterBusinessCommit: () => { throw new Error("response lost"); } } });
  const request = await data.request("committed");
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(503));
  assert.equal(service.store.getRequest(request)[0]!.state, "published");
  assert.equal(service.store.getCommittedReceiptId(request, HASH), "receipt-request");
  const retry = await data.request("different-temp");
  const next = data.service({ publisherGeneration: "generation-2" });
  const result = await next.publishAndCommit(retry, data.commit(retry));
  assert.equal(result.receiptId, "receipt-request"); assert.deepEqual(result.attachmentIds, ["att_committed"]);
  assert.equal(next.getRetention().chargedBytes, PNG.length);
  assert.deepEqual(await fs.readdir(path.join(data.workspacePath, ".awb/agent/attachments")), ["att_committed.png"]);
});

test("cancelled receipt replay does not recreate removed references or refund retained storage", async (t) => {
  const data = await fixture(t); const service = data.service(); const request = await data.request("cancelled");
  await service.publishAndCommit(request, data.commit(request));
  data.db.transaction(() => {
    data.db.prepare("update agent_user_message_receipt set status='cancelled' where id='receipt-request'").run();
    data.db.prepare("delete from agent_user_message_receipt_attachment where receipt_id='receipt-request'").run();
    service.store.retainReceipt({ workspaceId: "w1", sessionId: "s1", receiptId: "receipt-request" }, "cancelled");
  })();
  const retry = await data.request("cancel-retry"); const result = await service.publishAndCommit(retry, data.commit(retry));
  assert.equal(result.status, "cancelled"); assert.equal(service.getRetention().chargedBytes, PNG.length);
  assert.equal(service.store.getRequest(request)[0]!.retentionCode, "cancelled");
  assert.equal((data.db.prepare("select count(*) as count from agent_user_message_receipt_attachment").get() as { count: number }).count, 0);
  assert.deepEqual(await fs.readFile(path.join(data.workspacePath, ".awb/agent/attachments/att_cancelled.png")), PNG);
});

test("upload-cancel cycles accumulate retained bytes instead of repeatedly reclaiming the same storage quota", async (t) => {
  const data = await fixture(t); const service = data.service();
  for (let index = 0; index < 3; index++) {
    const request = { ...await data.request(`cycle-${index}`), clientRequestId: `cycle-${index}` };
    const result = await service.publishAndCommit(request, data.commit(request));
    data.db.prepare("update agent_user_message_receipt set status='cancelled' where id=?").run(result.receiptId);
    service.store.retainReceipt({ workspaceId: "w1", sessionId: "s1", receiptId: result.receiptId }, "cancelled");
    assert.equal(service.getRetention().chargedBytes, PNG.length * (index + 1));
  }
  assert.equal((await fs.readdir(path.join(data.workspacePath, ".awb/agent/attachments"))).length, 3);
});

test("different payload is rejected before a second file/intent is published", async (t) => {
  const data = await fixture(t); const service = data.service(); const request = await data.request("original");
  await service.publishAndCommit(request, data.commit(request));
  const changed = { ...await data.request("changed"), payloadHash: "b".repeat(64) };
  await assert.rejects(service.publishAndCommit(changed, data.commit(changed)), errorIs(409, "AGENT_REQUEST_PAYLOAD_CONFLICT"));
  assert.equal(service.store.getRequest(request).length, 1); assert.equal(service.getRetention().chargedBytes, PNG.length);
  assert.deepEqual(await fs.readdir(path.join(data.workspacePath, ".awb/agent/attachments")), ["att_original.png"]);
});

test("same-inode source mutation before preparation fails without publishing and releases only reserved bytes", async (t) => {
  const data = await fixture(t); const request = await data.request("source");
  const changed = Buffer.from(PNG); changed[11] = 1;
  const service = data.service({ forTest: { afterReservation: () => fs.writeFile(agentAttachmentTempFilePath(data.dataDir, "tmp_source"), changed) } });
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(503));
  assert.equal(service.getRetention().chargedBytes, 0); assert.equal(service.store.getRequest(request)[0]!.state, "released_unpublished");
  assert.deepEqual(await fs.readdir(path.join(data.workspacePath, ".awb/agent/attachments")), []);
});

test("same-inode source mutation after publishing CAS fails closed and remains charged as outcome unknown", async (t) => {
  const data = await fixture(t); const request = await data.request("source-late");
  const changed = Buffer.from(PNG); changed[11] = 1;
  const service = data.service({ forTest: { afterPublishingBoundary: () => writeFileSync(agentAttachmentTempFilePath(data.dataDir, "tmp_source-late"), changed) } });
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(503));
  assert.equal(service.getRetention().chargedBytes, PNG.length);
  assert.equal(service.store.getRequest(request)[0]!.retentionCode, "outcome_unknown");
  assert.deepEqual(await fs.readdir(path.join(data.workspacePath, ".awb/agent/attachments")), []);
});

for (const replacement of ["inode", "bytes"] as const) {
  test(`same-UID published ${replacement} replacement is not reused or unlinked`, async (t) => {
    const data = await fixture(t); const service = data.service(); const request = await data.request("replace");
    await assert.rejects(service.publishAndCommit(request, () => { throw new Error("receipt failed"); }), errorIs(503));
    const finalPath = path.join(data.workspacePath, ".awb/agent/attachments/att_replace.png");
    if (replacement === "inode") { await fs.rename(finalPath, `${finalPath}.original`); await fs.writeFile(finalPath, PNG); }
    else { const changed = Buffer.from(PNG); changed[11] = 1; await fs.writeFile(finalPath, changed); }
    const retry = await data.request("replacement-retry");
    await assert.rejects(service.publishAndCommit(retry, data.commit(retry)), errorIs(409, "AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN"));
    assert.equal(service.getRetention().chargedBytes, PNG.length);
    assert.equal(service.store.getRequest(request)[0]!.retentionCode, "attachment_integrity_failed");
    assert.ok(await fs.stat(finalPath));
    assert.equal((data.db.prepare("select count(*) as count from agent_user_message_receipt").get() as { count: number }).count, 0);
  });
}

test("same-UID directory symlink replacement cannot publish outside the pinned Workspace target", async (t) => {
  const data = await fixture(t); const request = await data.request("escape");
  const sibling = path.join(data.dataDir, "not-workspace"); await fs.mkdir(sibling);
  const attachmentDirectory = path.join(data.workspacePath, ".awb/agent/attachments");
  const service = data.service({ forTest: { afterPublishingBoundary: () => {
    renameSync(attachmentDirectory, `${attachmentDirectory}.saved`); symlinkSync(sibling, attachmentDirectory, "dir");
  } } });
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(503));
  assert.deepEqual(await fs.readdir(sibling), []);
  assert.deepEqual(await fs.readdir(`${attachmentDirectory}.saved`), []);
  assert.equal(service.getRetention().chargedBytes, PNG.length);
});

test("deletion fence is rechecked after reservation and before any publication", async (t) => {
  const data = await fixture(t); const request = await data.request("deleting");
  const service = data.service({ forTest: { afterReservation: () => workspaceDeletingFence.begin("w1") } });
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(409, "WORKSPACE_DELETING"));
  assert.equal(service.getRetention().chargedBytes, 0);
  assert.equal(service.store.getRequest(request)[0]!.state, "released_unpublished");
  await assert.rejects(fs.stat(path.join(data.workspacePath, ".awb")), { code: "ENOENT" });
});

test("Workspace admission holds across reservation/publication/commit, so logical deletion cannot interleave", async (t) => {
  const data = await fixture(t); const request = await data.request("admission");
  let arrived!: () => void; let release!: () => void;
  const atReservation = new Promise<void>(resolve => { arrived = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const service = data.service({ forTest: { afterReservation: async () => { arrived(); await hold; } } });
  const publication = service.publishAndCommit(request, data.commit(request)); await atReservation;
  let deletionStarted = false;
  const deletion = workspaceLifecycleCoordinator.withAdmission("w1", async () => { deletionStarted = true; });
  await Promise.resolve(); assert.equal(deletionStarted, false);
  release(); await publication; await deletion; assert.equal(deletionStarted, true);
  assert.equal(service.store.getRequest(request)[0]!.state, "published");
});

test("logical Workspace cleanup retains the independent ledger and leaves published files untouched", async (t) => {
  const data = await fixture(t); const service = data.service(); const request = await data.request("delete");
  await service.publishAndCommit(request, data.commit(request));
  data.db.transaction(() => { deleteWorkspaceAgentData(data.db, "w1"); data.db.prepare("delete from workspaces where id='w1'").run(); })();
  const [intent] = service.store.getRequest(request);
  assert.equal(intent!.state, "retained"); assert.equal(intent!.retentionCode, "workspace_logically_deleted");
  assert.equal(service.getRetention().chargedBytes, PNG.length); assert.equal(intent!.receiptId, "receipt-request");
  assert.deepEqual(await fs.readFile(path.join(data.workspacePath, ".awb/agent/attachments/att_delete.png")), PNG);
  assert.deepEqual(data.db.pragma("foreign_key_check"), []);
});

test("wrong scope, subtask, untrusted Workspace root and invalid temp ID fail without reservations", async (t) => {
  const data = await fixture(t); const service = data.service(); const request = await data.request("scope");
  await assert.rejects(service.publishAndCommit({ ...request, sessionId: "missing" }, data.commit(request)), errorIs(404));
  data.db.prepare("update agent_session set kind='subtask' where id='s1'").run();
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(400, "AGENT_SUBTASK_READONLY"));
  data.db.prepare("update agent_session set kind='primary' where id='s1'").run();
  data.db.prepare("update workspaces set path=? where id='w1'").run(path.join(data.dataDir, "untrusted"));
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), errorIs(409));
  await assert.rejects(service.publishAndCommit({ ...request, images: [{ ...request.images[0]!, tempId: "../../escape" }] }, data.commit(request)), errorIs(400));
  assert.equal(service.getRetention().chargedBytes, 0);
});

test("callback cannot associate mismatched attachment metadata with an otherwise committed receipt", async (t) => {
  const data = await fixture(t); const service = data.service(); const request = await data.request("metadata");
  await assert.rejects(service.publishAndCommit(request, value => {
    const result = data.commit(request)(value);
    data.db.prepare("update agent_attachment set byte_size=byte_size+1 where id=?").run(value.images[0]!.attachmentId);
    return result;
  }), errorIs(409, "AGENT_ATTACHMENT_PUBLICATION_UNCERTAIN"));
  assert.equal((data.db.prepare("select count(*) as count from agent_user_message_receipt").get() as { count: number }).count, 0);
  assert.equal(service.getRetention().chargedBytes, PNG.length);
});

test("507 is safely diagnosable and does not prevent a text-only receipt", async (t) => {
  const data = await fixture(t); const service = data.service();
  const insert = data.db.prepare(`insert into agent_attachment_publication_intent
    (id,workspace_id,session_id,client_request_id,image_position,payload_hash,byte_sha256,attachment_id,
     storage_key,workspace_dir_name,byte_size,media_type,state,publisher_generation,created_at,updated_at)
    values (?,'seed','seed',?,0,?,?,?,?,'seed',?,'image/png','retained','seed',1,1)`);
  for (let index = 0, bytes = AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES; bytes > 0; index++) {
    const chunk = Math.min(bytes, 10 * 1024 * 1024); bytes -= chunk;
    insert.run(`seed-${index}`, `seed-${index}`, HASH, HASH, `att_seed-${index}`, `att_seed-${index}.png`, chunk);
  }
  const request = await data.request("full");
  await assert.rejects(service.publishAndCommit(request, data.commit(request)), (error: unknown) => {
    assert.ok(errorIs(507, "AGENT_ATTACHMENT_RETENTION_CAPACITY_EXCEEDED")(error));
    assert.ok(!(error as Error).message.includes(data.dataDir)); return true;
  });
  assert.equal(service.store.getRequest(request).length, 0);
  const text = { ...requestScope, clientRequestId: "text", payloadHash: HASH, images: [] };
  const result = await service.publishAndCommit(text, data.commit(text));
  assert.equal(result.status, "queued"); assert.deepEqual(result.attachmentIds, []);
  assert.equal(service.getRetention().chargedBytes, AGENT_ATTACHMENT_RETENTION_LIMIT_BYTES);
});
