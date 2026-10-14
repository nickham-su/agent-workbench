import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_PREVIEW_RESOURCES, type FileStatResponse } from "@agent-workbench/shared";
import { EDITOR_IMAGE_MAX_BYTES, loadEditorImage } from "./editorImages";

const statFile = (size: number): FileStatResponse => ({ path: "image.png", ok: true, kind: "file", version: { size, mtimeMs: 1 } });
for (const resource of Object.values(WORKSPACE_PREVIEW_RESOURCES).filter((resource) => resource.kind === "image")) {
  test(`uses shared image MIME for ${resource.extension} including uppercase paths`, async () => {
    const result = await loadEditorImage({ path: `repo/image${resource.extension.toUpperCase()}`, stat: async () => statFile(3), download: async () => new Blob(["abc"], { type: "application/octet-stream" }) });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.blob.type, resource.mime);
    assert.equal(result.blob.size, 3);
    assert.deepEqual(result.version, { size: 3, mtimeMs: 1 });
  });
}

test("20 MiB is permitted but a larger stat prevents download", async () => {
  let downloads = 0;
  const download = async () => { downloads++; return new Blob(["image"]); };
  assert.equal((await loadEditorImage({ path: "a.png", stat: async () => statFile(EDITOR_IMAGE_MAX_BYTES), download })).ok, true);
  assert.deepEqual(await loadEditorImage({ path: "a.png", stat: async () => statFile(EDITOR_IMAGE_MAX_BYTES + 1), download }), { ok: false, reason: "too_large" });
  assert.equal(downloads, 1);
});

test("checks the downloaded Blob again after a stat-to-download file change", async () => {
  const exact = new Blob([new Uint8Array(EDITOR_IMAGE_MAX_BYTES)]);
  assert.equal((await loadEditorImage({ path: "a.svg", stat: async () => statFile(1), download: async () => exact })).ok, true);
  const large = new Blob([exact, "x"]);
  assert.deepEqual(await loadEditorImage({ path: "a.svg", stat: async () => statFile(1), download: async () => large }), { ok: false, reason: "too_large" });
});

for (const [reason, expected] of [["missing", "missing"], ["unsafe_path", "unsafe_path"], ["permission_denied", "load_failed"], ["not_file", "load_failed"]] as const) {
  test(`does not download after stat ${reason}`, async () => {
    let downloaded = false;
    const result = await loadEditorImage({ path: "a.png", stat: async () => ({ path: "a.png", ok: false, reason }), download: async () => { downloaded = true; return new Blob(); } });
    assert.deepEqual(result, { ok: false, reason: expected });
    assert.equal(downloaded, false);
  });
}

for (const size of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
  test(`rejects invalid stat size ${size}`, async () => {
    const result = await loadEditorImage({ path: "a.png", stat: async () => statFile(size), download: async () => { throw new Error("must not download"); } });
    assert.deepEqual(result, { ok: false, reason: "load_failed" });
  });
}

test("uses shared types only, no stat or download for HTML", async () => {
  const result = await loadEditorImage({ path: "page.html", stat: async () => { throw new Error("must not stat"); }, download: async () => { throw new Error("must not download"); } });
  assert.deepEqual(result, { ok: false, reason: "load_failed" });
});

test("reports stat and download request failures", async () => {
  assert.deepEqual(await loadEditorImage({ path: "a.png", stat: async () => { throw new Error("offline"); }, download: async () => new Blob() }), { ok: false, reason: "load_failed" });
  assert.deepEqual(await loadEditorImage({ path: "a.png", stat: async () => statFile(1), download: async () => { throw new Error("offline"); } }), { ok: false, reason: "load_failed" });
});
