import assert from "node:assert/strict";
import test from "node:test";
import { editorMarkdownHeadingId, resolveMarkdownTarget } from "./editorMarkdown";

test("章节 ID 使用稳定命名空间，不改变原始 fragment 或重复编号", () => {
  for (const fragment of ["location", "name", "constructor", "location-1", "中文标题", "中文标题-1"]) {
    assert.equal(editorMarkdownHeadingId(fragment), `editor-md-heading-${fragment}`);
    assert.notEqual(editorMarkdownHeadingId(fragment), fragment);
  }
});

for (const [href, path] of [["./image.png", "repo/docs/image.png"], ["../image.svg", "repo/image.svg"], ["../../README.md", "README.md"], ["chapter%20one.md", "repo/docs/chapter one.md"], ["a/../b.md", "repo/docs/b.md"]]) {
  test(`Markdown 相对路径 ${href}`, () => assert.deepEqual(resolveMarkdownTarget("repo/docs/readme.md", href), { kind: "file", path }));
}
for (const href of ["../../../escape.md", "/etc/file", "//evil.example/file", "C:/file", "file:///etc/file", "javascript:alert(1)", "data:text/plain,secret", "vbscript:test", "a\\b.png", "https%3A%2F%2Fevil.example", "%2fetc/file", "%2e%2e/%2e%2e/%2e%2e/file", "%252e%252e/file", "x%00.md", "x%5c.md", "x%3fquery.md", "x%23fragment.md", "file.md?raw=1", "%E0%A4%A", "", "../../..", "#", "#bad%00id"]) {
  test(`Markdown 拒绝含糊或越界地址 ${JSON.stringify(href)}`, () => assert.equal(resolveMarkdownTarget("repo/docs/readme.md", href).kind, "invalid"));
}
test("文内及文件章节分开解析", () => {
  assert.deepEqual(resolveMarkdownTarget("README.md", "#hello%20world"), { kind: "anchor", fragment: "hello world" });
  assert.deepEqual(resolveMarkdownTarget("repo/README.md", "docs/a.md#章节"), { kind: "file", path: "repo/docs/a.md", fragment: "章节" });
});
for (const href of ["https://example.com/a", "http://example.com/a", "mailto:hello@example.com"]) {
  test(`Markdown 外链 ${href}`, () => assert.deepEqual(resolveMarkdownTarget("README.md", href), { kind: "external", href }));
}
test("未知来源文档路径不能当作相对文件基准", () => {
  for (const path of ["/repo/a.md", "../repo/a.md", "repo/../a.md", "repo\\docs/a.md"]) assert.equal(resolveMarkdownTarget(path, "image.png").kind, "invalid");
});
