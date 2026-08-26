import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getWorkspacePreviewResourceDescriptor,
  isWorkspacePreviewEntryPath,
  WORKSPACE_PREVIEW_RESOURCES
} from "../src/contracts/workspace-preview.js";

const cases = [
  ["index.html", "text/html; charset=utf-8", "html", true, false],
  ["INDEX.HTM", "text/html; charset=utf-8", "html", true, false],
  ["styles.css", "text/css; charset=utf-8", "css", false, false],
  ["app.js", "text/javascript; charset=utf-8", "script", false, false],
  ["module.MJS", "text/javascript; charset=utf-8", "script", false, false],
  ["image.png", "image/png", "image", true, false],
  ["image.jpg", "image/jpeg", "image", true, false],
  ["image.jpeg", "image/jpeg", "image", true, false],
  ["image.gif", "image/gif", "image", true, false],
  ["image.webp", "image/webp", "image", true, false],
  ["image.avif", "image/avif", "image", true, false],
  ["image.bmp", "image/bmp", "image", true, false],
  ["favicon.ico", "image/x-icon", "image", true, false],
  ["image.svg", "image/svg+xml", "image", true, false],
  ["audio.mp3", "audio/mpeg", "audio", true, true],
  ["audio.wav", "audio/wav", "audio", true, true],
  ["audio.ogg", "audio/ogg", "audio", true, true],
  ["audio.m4a", "audio/mp4", "audio", true, true],
  ["audio.aac", "audio/aac", "audio", true, true],
  ["audio.flac", "audio/flac", "audio", true, true],
  ["video.mp4", "video/mp4", "video", true, true],
  ["video.webm", "video/webm", "video", true, true],
  ["video.ogv", "video/ogg", "video", true, true],
  ["video.mov", "video/quicktime", "video", true, true],
  ["font.woff", "font/woff", "font", false, false],
  ["font.woff2", "font/woff2", "font", false, false],
  ["font.ttf", "font/ttf", "font", false, false],
  ["font.otf", "font/otf", "font", false, false]
] as const;

test("workspace preview catalog has the documented resource descriptors", () => {
  assert.equal(Object.keys(WORKSPACE_PREVIEW_RESOURCES).length, cases.length);

  for (const [filePath, mime, kind, entry, range] of cases) {
    const descriptor = getWorkspacePreviewResourceDescriptor(`nested/${filePath}`);
    assert.deepEqual(descriptor, {
      extension: `.${filePath.split(".").at(-1)?.toLowerCase()}`,
      mime,
      kind,
      entry,
      range
    });
    assert.equal(isWorkspacePreviewEntryPath(filePath), entry);
  }
});

test("workspace preview catalog rejects paths without a supported filesystem extension", () => {
  for (const filePath of [
    "",
    "README",
    ".env",
    "trailing.",
    "asset.json",
    "module.wasm",
    "bundle.js.map",
    "document.pdf",
    "index.html?x=1",
    "index.html#section"
  ]) {
    assert.equal(getWorkspacePreviewResourceDescriptor(filePath), null, filePath);
    assert.equal(isWorkspacePreviewEntryPath(filePath), false, filePath);
  }
});

test("workspace preview catalog uses the basename last extension", () => {
  assert.equal(getWorkspacePreviewResourceDescriptor("nested/secret.json.js")?.extension, ".js");
  assert.equal(isWorkspacePreviewEntryPath("nested/secret.json.js"), false);
});
