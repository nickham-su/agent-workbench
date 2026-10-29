import assert from "node:assert/strict";
import test from "node:test";
import { MERMAID_MAX_TEXT, MermaidPreviewError, validateMermaidSource } from "./editorMermaid";

function rejected(text: string, reason: string) {
  assert.throws(() => validateMermaidSource(text), (error: unknown) => error instanceof MermaidPreviewError && error.reason === reason);
}
for (const text of ["flowchart LR\nA[Start] --> B{Done?}\nB --> C[End]", "sequenceDiagram\nAlice->>Bob: Hello", "classDiagram\nAnimal <|-- Dog", "stateDiagram-v2\n[*] --> Idle", "flowchart LR\nA-->B\nclassDef default fill:#fff,stroke:#333,stroke-width:2px", "flowchart LR\nA@{ shape: rect, label: Normal } --> B"]) {
  test(`允许普通图源及有限安全样式：${text.split("\n")[0]}`, () => assert.doesNotThrow(() => validateMermaidSource(text)));
}
for (const text of [
  "sequenceDiagram\nAlice->>Bob: image: upload complete",
  'flowchart LR\nA["src: local path"]',
  'flowchart LR\nA@{ label: "icon: local text" }',
  'flowchart LR\nA@{ label: "} \\u0073rc: local text" }',
]) test("普通标签中的资源词汇及转义不作为结构属性拒绝", () => assert.doesNotThrow(() => validateMermaidSource(text)));
test("空白、文本和语句预算在加载库之前失败", () => {
  rejected("  ", "empty");
  rejected("x".repeat(MERMAID_MAX_TEXT + 1), "tooLarge");
  rejected("flowchart LR\n" + "A-->B\n".repeat(501), "tooLarge");
});
for (const text of [
  '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B',
  "---\nconfig:\n  htmlLabels: true\n---\nflowchart LR\nA-->B",
  'flowchart LR\nA["<img src=https://example.test/x>"]',
  'flowchart LR\nA["#lt;img src=https://example.test/x#gt;"]',
  'flowchart LR\nA["&amp;lt;img src=https://example.test/x&amp;gt;"]',
  'flowchart LR\nA["![x](https://example.test/x)"]',
  'mindmap\n  root((root))\n    ::icon(fa fa-book)',
  'flowchart LR\nA["$$\\includegraphics{https://example.test/x}$$"]',
  'flowchart LR\nA-->B\nclassDef default fill:url(https://example.test/x)',
  'flowchart LR\nA-->B\nclassDef default fill:u/**/rl(https://example.test/x)',
  'flowchart LR\nA-->B\nclassDef default fill:u\\72l(https://example.test/x)',
  'flowchart LR\nA-->B\nclassDef default fill:red}body{background:red',
  'flowchart LR\nA-->B\nclassDef x}body{color:red}x{ fill:red',
  'flowchart LR\nA-->B\nstyle A}body{color:red}x{ fill:red',
  'flowchart LR\nA-->B\nclassDef default fill:red,@import "https://example.test/x"',
  'flowchart LR\nA-->B\nstyle A background-image:https://example.test/x',
  'flowchart LR\nA-->B;linkStyle default stroke:expression(alert(1))',
]) test("渲染前拒绝配置、HTML、外部资源及危险样式", () => rejected(text, "unsafe"));

for (const newline of ["\r", "\r\n"]) {
  const name = newline === "\r" ? "CR-only" : "CRLF";
  test(`${name} 配置及各类危险样式在前置校验中拒绝`, () => {
    for (const lines of [
      ["---", "config:", "  theme: dark", "---", "flowchart LR", "A-->B"],
      ['%%{init: {"theme":"dark"}}%%', "flowchart LR", "A-->B"],
      ["flowchart LR", "A-->B", "classDef default fill:red}body{background:red"],
      ["flowchart LR", "A-->B", "style A filter:blur(2px)"],
      ["flowchart LR", "A-->B", "linkStyle default stroke-linecap:square"],
      ["flowchart LR", 'A["<img src=\"https://example.invalid/x\">"]'],
    ]) rejected(lines.join(newline), "unsafe");
  });
  test(`${name} 语句预算按正规化后的换行和分号累计`, () => {
    const boundary = ["flowchart LR", ...Array<string>(499).fill("A")].join(newline);
    assert.equal(validateMermaidSource(boundary), boundary.replace(/\r\n?/g, "\n"));
    rejected(`${boundary}${newline}A`, "tooLarge");
    rejected(`${boundary};A`, "tooLarge");
  });
  test(`${name} 正常图及安全样式返回一致的 LF 图源`, () => {
    for (const source of [
      "flowchart LR\n%% comment\nA[Start]-->B[End]\nclassDef default fill:#fff,stroke:#333",
      "sequenceDiagram\nAlice->>Bob: image: upload complete",
    ]) assert.equal(validateMermaidSource(source.replace(/\n/g, newline)), source);
    assert.equal(validateMermaidSource("flowchart LR\r\nA-->B\rstyle A fill:red\n"), "flowchart LR\nA-->B\nstyle A fill:red\n");
  });
}
