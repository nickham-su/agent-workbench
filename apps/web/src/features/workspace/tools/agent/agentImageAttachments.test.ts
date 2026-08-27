import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_IMAGE_COMPRESSION_THRESHOLD_BYTES,
  AGENT_IMAGE_MAX_BYTES,
  AttachmentPreviewCache,
  collectClipboardAgentImageFiles,
  collectPastedAgentImages,
  createAgentMessageFormData,
  createAgentSendAttemptFingerprint,
  formatAgentImageSize,
  formatPendingAgentImageLabel,
  maybeCompressAgentImage,
  preparePastedAgentImages,
  resolveAgentSendAttempt,
  shouldBlockImageSlashCommand
} from "./agentImageAttachments.js";

function image(name = "", type = "image/png", size = 8) {
  return new File([new Uint8Array(size)], name, { type });
}

test("paste prefers image files from clipboard items and falls back to files", () => {
  const itemImage = image("item.png");
  const fallbackImage = image("fallback.png");
  const item = { kind: "file", type: "image/png", getAsFile: () => itemImage };
  const textItem = { kind: "string", type: "text/plain", getAsFile: () => null };
  assert.deepEqual(
    collectClipboardAgentImageFiles({ items: [textItem, item], files: [fallbackImage] }),
    [itemImage]
  );
  assert.deepEqual(collectClipboardAgentImageFiles({ items: [textItem], files: [fallbackImage] }), [fallbackImage]);

  const withText = collectPastedAgentImages({
    files: collectClipboardAgentImageFiles({ items: [textItem, item] }),
    existing: [],
    hasText: true,
    makeId: () => "item"
  });
  assert.equal(withText.preventDefault, false);
  assert.equal(withText.accepted[0]?.filename, "item.png");
});

test("pending image size formatting is stable", () => {
  assert.equal(formatAgentImageSize(8), "8B");
  assert.equal(formatAgentImageSize(1536), "1.5KB");
  assert.equal(formatAgentImageSize(2 * 1024 * 1024), "2.0MB");
  assert.equal(
    formatPendingAgentImageLabel({ id: "image-a", file: image("screen.png", "image/png", 1536), filename: "screen.png" }),
    "1.5KB"
  );
});

test("images at or below 1 MiB skip compression", async () => {
  const source = image("small.png", "image/png", AGENT_IMAGE_COMPRESSION_THRESHOLD_BYTES);
  let calls = 0;
  const result = await maybeCompressAgentImage(source, async () => {
    calls += 1;
    return new Blob(["compressed"], { type: "image/webp" });
  });
  assert.equal(result, source);
  assert.equal(calls, 0);
});

test("large pasted images use a materially smaller WebP result and rename the file", async () => {
  const source = image("screenshot.PNG", "image/png", AGENT_IMAGE_COMPRESSION_THRESHOLD_BYTES + 1);
  let encoded: File | null = null;
  const result = await maybeCompressAgentImage(source, async (file) => {
    encoded = file;
    return new Blob([new Uint8Array(256)], { type: "image/webp" });
  });
  assert.equal(encoded, source);
  assert.notEqual(result, source);
  assert.equal(result.type, "image/webp");
  assert.equal(result.name, "screenshot.webp");
  assert.equal(result.size, 256);
});

test("large pasted images retain the original when WebP savings are insufficient or encoding fails", async () => {
  const source = image("screenshot.png", "image/png", AGENT_IMAGE_COMPRESSION_THRESHOLD_BYTES + 100);
  const insufficient = await maybeCompressAgentImage(source, async (file) => (
    new Blob([new Uint8Array(Math.ceil(file.size * 0.95))], { type: "image/webp" })
  ));
  assert.equal(insufficient, source);
  const failed = await maybeCompressAgentImage(source, async () => { throw new Error("encode failed"); });
  assert.equal(failed, source);
});

test("over-limit source images are compressed before final pasted-image validation", async () => {
  const source = image("large-source.png", "image/png", AGENT_IMAGE_MAX_BYTES + 2 * 1024 * 1024);
  let calls = 0;
  const prepared = await preparePastedAgentImages([source], async () => {
    calls += 1;
    return new Blob([new Uint8Array(AGENT_IMAGE_COMPRESSION_THRESHOLD_BYTES)], { type: "image/webp" });
  });
  const accepted = collectPastedAgentImages({
    files: prepared,
    existing: [],
    makeId: () => "compressed-large-source"
  });

  assert.equal(calls, 1);
  assert.equal(prepared[0]?.name, "large-source.webp");
  assert.equal(accepted.rejected, null);
  assert.equal(accepted.accepted.length, 1);

  const stillOversized = await preparePastedAgentImages([source], async () => (
    new Blob([new Uint8Array(AGENT_IMAGE_MAX_BYTES + 1)], { type: "image/webp" })
  ));
  const rejected = collectPastedAgentImages({
    files: stillOversized,
    existing: [],
    makeId: () => "still-oversized"
  });
  assert.equal(rejected.rejected, "size");
  assert.equal(rejected.accepted.length, 0);
});

test("clipboard items and files fallback both flow through pasted-image preparation", async () => {
  const fromItem = image("item.png", "image/png", AGENT_IMAGE_COMPRESSION_THRESHOLD_BYTES + 1);
  const fromFiles = image("fallback.png", "image/png", AGENT_IMAGE_COMPRESSION_THRESHOLD_BYTES + 1);
  const item = { kind: "file", type: "image/png", getAsFile: () => fromItem };
  const compressedFromItems = await preparePastedAgentImages(
    collectClipboardAgentImageFiles({ items: [item], files: [fromFiles] }),
    async () => new Blob([new Uint8Array(64)], { type: "image/webp" })
  );
  const compressedFromFiles = await preparePastedAgentImages(
    collectClipboardAgentImageFiles({ items: [], files: [fromFiles] }),
    async () => new Blob([new Uint8Array(64)], { type: "image/webp" })
  );
  assert.deepEqual(compressedFromItems.map((file) => file.name), ["item.webp"]);
  assert.deepEqual(compressedFromFiles.map((file) => file.name), ["fallback.webp"]);
  const pending = collectPastedAgentImages({
    files: compressedFromItems,
    existing: [],
    makeId: () => "prepared-item"
  });
  assert.equal(pending.rejected, null);
  assert.equal(pending.accepted[0]?.filename, "item.webp");
});

test("paste keeps text default behavior and stores valid images locally", () => {
  assert.equal(collectPastedAgentImages({ files: [], existing: [], makeId: () => "none" }).preventDefault, false);
  const result = collectPastedAgentImages({ files: [image("", "image/png")], existing: [], hasText: true, makeId: () => "one" });
  assert.equal(result.preventDefault, false);
  assert.equal(result.accepted[0]?.filename, "pasted-image.png");
  assert.equal(result.rejected, null);
});

test("paste enforces image type, empty file, per-image and count limits", () => {
  assert.equal(collectPastedAgentImages({ files: [image("x", "image/gif")], existing: [], makeId: () => "x" }).rejected, "type");
  assert.equal(collectPastedAgentImages({ files: [image("x", "image/png", 0)], existing: [], makeId: () => "x" }).rejected, "empty");
  assert.equal(collectPastedAgentImages({ files: [image("x", "image/png", AGENT_IMAGE_MAX_BYTES + 1)], existing: [], makeId: () => "x" }).rejected, "size");
  const existing = Array.from({ length: 4 }, (_, index) => ({ id: String(index), file: image(), filename: "x.png" }));
  assert.equal(collectPastedAgentImages({ files: [image()], existing, makeId: () => "x" }).rejected, "count");
});

test("multipart form has one payload and one images field per pending image", () => {
  const images = [{ id: "a", file: image("a.png"), filename: "a.png" }, { id: "b", file: image("b.png"), filename: "b.png" }];
  const form = createAgentMessageFormData({ workspaceId: "w", text: "hello" }, images);
  assert.equal(form.getAll("payload").length, 1);
  assert.equal(form.getAll("images").length, 2);
  assert.equal(JSON.parse(String(form.get("payload"))).text, "hello");
});

test("send attempt reuses its ID after failure and changes when the draft image set changes", () => {
  let nextId = 0;
  const makeClientRequestId = () => `req_${++nextId}`;
  const images = [{ id: "image-a", file: image("a.png"), filename: "a.png" }];
  const initialFingerprint = createAgentSendAttemptFingerprint({ draft: "hello", images });
  const first = resolveAgentSendAttempt({ attempt: null, fingerprint: initialFingerprint, makeClientRequestId });
  const retry = resolveAgentSendAttempt({ attempt: first, fingerprint: initialFingerprint, makeClientRequestId });
  assert.equal(first.clientRequestId, "req_1");
  assert.equal(retry.clientRequestId, first.clientRequestId);

  const changedText = resolveAgentSendAttempt({
    attempt: first,
    fingerprint: createAgentSendAttemptFingerprint({ draft: "hello again", images }),
    makeClientRequestId
  });
  assert.equal(changedText.clientRequestId, "req_2");

  const reorderedImages = [...images, { id: "image-b", file: image("b.png"), filename: "b.png" }].reverse();
  const changedImages = resolveAgentSendAttempt({
    attempt: first,
    fingerprint: createAgentSendAttemptFingerprint({ draft: "hello", images: reorderedImages }),
    makeClientRequestId
  });
  assert.equal(changedImages.clientRequestId, "req_3");

  const afterSuccess = resolveAgentSendAttempt({ attempt: null, fingerprint: initialFingerprint, makeClientRequestId });
  assert.equal(afterSuccess.clientRequestId, "req_4");
});

test("image slash controls are blocked and preview URLs are reused then revoked", async () => {
  assert.equal(shouldBlockImageSlashCommand("compact", 1), true);
  assert.equal(shouldBlockImageSlashCommand("clear", 1), true);
  assert.equal(shouldBlockImageSlashCommand("prompt", 1), false);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let loads = 0;
  const revoked: string[] = [];
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = (value) => revoked.push(value);
  try {
    const cache = new AttachmentPreviewCache();
    assert.equal(await cache.get("a", async () => { loads += 1; return new Blob(["x"]); }), "blob:test");
    assert.equal(await cache.get("a", async () => { loads += 1; return new Blob(["x"]); }), "blob:test");
    assert.equal(loads, 1);
    cache.clear();
    assert.deepEqual(revoked, ["blob:test"]);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("late preview requests do not cache or overwrite a newer image", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  const resolvers = new Map<string, (blob: Blob) => void>();
  let nextUrl = 0;
  URL.createObjectURL = () => `blob:${++nextUrl}`;
  URL.revokeObjectURL = (value) => revoked.push(value);
  try {
    const cache = new AttachmentPreviewCache();
    let current = "second";
    const load = (id: string) => new Promise<Blob>((resolve) => resolvers.set(id, resolve));
    const first = cache.get("first", load, () => current === "first");
    const second = cache.get("second", load, () => current === "second");
    resolvers.get("second")!(new Blob(["second"]));
    assert.equal(await second, "blob:1");
    resolvers.get("first")!(new Blob(["first"]));
    assert.equal(await first, null);
    assert.deepEqual(revoked, ["blob:2"]);
    cache.clear();
    assert.deepEqual(revoked, ["blob:2", "blob:1"]);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("closing preview rejects a late image and revokes its object URL", async () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  let resolve!: (blob: Blob) => void;
  URL.createObjectURL = () => "blob:late";
  URL.revokeObjectURL = (value) => revoked.push(value);
  try {
    const cache = new AttachmentPreviewCache();
    let open = true;
    const pending = cache.get("image", () => new Promise<Blob>((done) => { resolve = done; }), () => open);
    open = false;
    cache.clear();
    resolve(new Blob(["late"]));
    assert.equal(await pending, null);
    assert.deepEqual(revoked, ["blob:late"]);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
