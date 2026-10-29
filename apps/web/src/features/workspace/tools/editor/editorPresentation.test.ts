import assert from "node:assert/strict";
import test from "node:test";
import { WORKSPACE_PREVIEW_RESOURCES } from "@agent-workbench/shared";
import { getEditorFilePresentation } from "./editorPresentation";

for (const [path, expected] of [
  ["notes.txt", "source"], ["main.ts", "source"], ["README.md", "markdown"],
  ["docs/README.MD", "markdown"], ["flow.mmd", "mermaid"], ["flow.MERMAID", "mermaid"],
  ["diagram.MMD", "mermaid"], ["page.HTML", "html"], ["page.htm", "html"],
  ["docs/readme.md/example.txt", "source"], [".md", "source"], ["readme.md?raw", "source"],
  ["readme.md#heading", "source"], ["", "source"], ["file.md.bak", "source"],
] as const) {
  test(`展示能力 ${path || "空路径"} -> ${expected}`, () => {
    assert.equal(getEditorFilePresentation(path), expected);
  });
}

test("图片展示能力完全沿用共享资源目录，不另维护扩展名或 MIME 表", () => {
  for (const resource of Object.values(WORKSPACE_PREVIEW_RESOURCES)) {
    if (resource.kind === "image") assert.equal(getEditorFilePresentation(`folder/image${resource.extension.toUpperCase()}`), "image");
  }
  assert.equal(getEditorFilePresentation("image.png?raw"), "source");
  assert.equal(getEditorFilePresentation("image.png#fragment"), "source");
});

test("音视频展示能力完全沿用共享目录，扩展名不区分大小写", () => {
  for (const resource of Object.values(WORKSPACE_PREVIEW_RESOURCES)) {
    if (resource.kind !== "audio" && resource.kind !== "video") continue;
    assert.equal(getEditorFilePresentation(`folder/media${resource.extension.toUpperCase()}`), resource.kind);
  }
  assert.equal(getEditorFilePresentation("clip.mp4?raw"), "source");
  assert.equal(getEditorFilePresentation("clip.mp4#fragment"), "source");
  assert.equal(getEditorFilePresentation("clip.mkv"), "source");
  assert.equal(getEditorFilePresentation("clip.mp4.txt"), "source");
});
