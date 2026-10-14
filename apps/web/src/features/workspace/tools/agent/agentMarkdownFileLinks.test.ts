import assert from "node:assert/strict";
import test from "node:test";
import type { FileStatResponse } from "@agent-workbench/shared";
import { agentMarkdownFileHref, parseAgentMarkdownFileLink, resolveAgentMarkdownFileLink } from "./agentMarkdownFileLinks.js";

for (const [href, expected] of [
  ["src/a.ts", { path: "src/a.ts" }],
  ["./repo/src/a.ts", { path: "repo/src/a.ts" }],
  ["src/./a.ts", { path: "src/a.ts" }],
  ["README.md:12", { path: "README.md", line: 12 }],
  ["README.md:12:3", { path: "README.md", line: 12, column: 3 }],
  ["src/a.ts#L12", { path: "src/a.ts", line: 12 }],
  ["src/a.ts#L12-L20", { path: "src/a.ts", line: 12 }],
  ["src/a%20b.ts:2:4", { path: "src/a b.ts", line: 2, column: 4 }],
  ["src/%E4%B8%AD%E6%96%87.ts#L2", { path: "src/中文.ts", line: 2 }],
  ["src/a%23b.ts", { path: "src/a#b.ts" }],
  ["src/a%2520b.ts", { path: "src/a%20b.ts" }],
] as const) {
  test(`parse relative file link ${href}`, () => {
    assert.deepEqual(parseAgentMarkdownFileLink(href), { kind: "file", link: expected });
  });
}

for (const href of ["https://example.com/a.ts:12", "http://example.com", "mailto:a@example.com", "//example.com/a.ts", "#section", "#L12"]) {
  test(`leave external/section link unchanged: ${href}`, () => {
    assert.deepEqual(parseAgentMarkdownFileLink(href), { kind: "other" });
  });
}

for (const href of ["../a.ts", "src/../a.ts", "%2e%2e/a.ts", "src/%2E%2E/a.ts", "/repo/a.ts", "%2Frepo/a.ts", "file:///repo/a.ts", "C:/repo/a.ts", "C:12", "src\\a.ts", "src%5C..%5Ca.ts", "src/%00a.ts", "src/%0aa.ts", "src/a%ZZ.ts", "javascript:alert(1)", "./", "-a.ts", "src/a.ts/", "a%20", "a.ts?line=2"]) {
  test(`reject unsafe/unsupported file path ${href}`, () => {
    assert.equal(parseAgentMarkdownFileLink(href).kind, "invalid");
  });
}

for (const href of ["a.ts:0", "a.ts:12:0", "src/a.ts:-1", "src/a.ts:1.5", "src/a.ts:9007199254740992", "src/a.ts#L0", "src/a.ts#L5-L2", "src/a.ts#L1-L9007199254740992", "src/a.ts#Lbad", "src/a.ts:2#L3"]) {
  test(`reject invalid file position ${href}`, () => {
    assert.deepEqual(parseAgentMarkdownFileLink(href), { kind: "invalid", reason: "invalid_position" });
  });
}

test("render-safe href encodes filenames and does not look like a URL scheme", () => {
  assert.equal(agentMarkdownFileHref({ path: "README.md", line: 12, column: 3 }), "./README.md");
  assert.equal(agentMarkdownFileHref({ path: "src/a #中文%.ts" }), "./src/a%20%23%E4%B8%AD%E6%96%87%25.ts");
});

const missing = (path: string): FileStatResponse => ({ path, ok: false, reason: "missing" });
const file = (path: string): FileStatResponse => ({ path, normalizedPath: path, ok: true, kind: "file", version: { size: 10, mtimeMs: 1 } });

function probeFixture(responses: Record<string, FileStatResponse | Error>, repoDirNames = ["repo-a", "repo-b"], path = "src/a.ts") {
  const calls: string[] = [];
  return {
    calls,
    result: resolveAgentMarkdownFileLink({
      path, repoDirNames,
      stat: async (candidate) => {
        calls.push(candidate);
        const result = responses[candidate];
        if (result instanceof Error) throw result;
        return result ?? missing(candidate);
      },
    }),
  };
}

test("Workspace root takes priority without repository requests", async () => {
  const fixture = probeFixture({ "src/a.ts": file("src/a.ts"), "repo-a/src/a.ts": file("repo-a/src/a.ts") });
  assert.deepEqual(await fixture.result, { kind: "file", path: "src/a.ts" });
  assert.deepEqual(fixture.calls, ["src/a.ts"]);
});

test("root missing/not_file probes all repositories and opens the sole file", async () => {
  for (const reason of ["missing", "not_file"] as const) {
    const fixture = probeFixture({ "src/a.ts": { path: "src/a.ts", ok: false, reason }, "repo-b/src/a.ts": file("repo-b/src/a.ts") });
    assert.deepEqual(await fixture.result, { kind: "file", path: "repo-b/src/a.ts" });
    assert.deepEqual(fixture.calls, ["src/a.ts", "repo-a/src/a.ts", "repo-b/src/a.ts"]);
  }
});

test("a repository prefix never suppresses fallback", async () => {
  const fixture = probeFixture({ "repo-b/repo-a/src/a.ts": file("repo-b/repo-a/src/a.ts") }, ["repo-a", "repo-b"], "repo-a/src/a.ts");
  assert.deepEqual(await fixture.result, { kind: "file", path: "repo-b/repo-a/src/a.ts" });
  assert.deepEqual(fixture.calls, ["repo-a/src/a.ts", "repo-a/repo-a/src/a.ts", "repo-b/repo-a/src/a.ts"]);
});

test("zero/multiple files are unresolved, including no registered repositories", async () => {
  assert.deepEqual(await probeFixture({}).result, { kind: "unresolved" });
  assert.deepEqual(await probeFixture({}, []).result, { kind: "unresolved" });
  assert.deepEqual(await probeFixture({ "repo-a/src/a.ts": file("repo-a/src/a.ts"), "repo-b/src/a.ts": file("repo-b/src/a.ts") }).result, { kind: "unresolved" });
});

test("root permission/safety/request failures do not trigger fallback", async () => {
  for (const response of [{ path: "src/a.ts", ok: false, reason: "unsafe_path" }, { path: "src/a.ts", ok: false, reason: "permission_denied" }, new Error("request failed")] as const) {
    const fixture = probeFixture({ "src/a.ts": response });
    assert.deepEqual(await fixture.result, { kind: "failed" });
    assert.deepEqual(fixture.calls, ["src/a.ts"]);
  }
});

test("any repository failure forbids deciding uniqueness from partial results", async () => {
  for (const response of [{ path: "repo-b/src/a.ts", ok: false, reason: "unsafe_path" }, { path: "repo-b/src/a.ts", ok: false, reason: "permission_denied" }, new Error("request failed")] as const) {
    const fixture = probeFixture({ "repo-a/src/a.ts": file("repo-a/src/a.ts"), "repo-b/src/a.ts": response });
    assert.deepEqual(await fixture.result, { kind: "failed" });
    assert.equal(fixture.calls.length, 3);
  }
});

test("a late second repository candidate is awaited before opening", async () => {
  let release!: (response: FileStatResponse) => void;
  let settled = false;
  const result = resolveAgentMarkdownFileLink({
    path: "src/a.ts", repoDirNames: ["repo-a", "repo-b"],
    stat: async (path) => path === "src/a.ts" ? missing(path) : path.startsWith("repo-a/") ? file(path) : new Promise((resolve) => { release = resolve; }),
  }).then((value) => { settled = true; return value; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release(file("repo-b/src/a.ts"));
  assert.deepEqual(await result, { kind: "unresolved" });
});

test("large files remain candidates and there is no stale negative cache", async () => {
  const large = { ...file("repo-a/src/a.ts"), version: { size: 1024 ** 3, mtimeMs: 1 } };
  assert.deepEqual(await probeFixture({ "repo-a/src/a.ts": large }).result, { kind: "file", path: "repo-a/src/a.ts" });
  let exists = false;
  const params = { path: "src/a.ts", repoDirNames: [], stat: async (path: string) => exists ? file(path) : missing(path) };
  assert.deepEqual(await resolveAgentMarkdownFileLink(params), { kind: "unresolved" });
  exists = true;
  assert.deepEqual(await resolveAgentMarkdownFileLink(params), { kind: "file", path: "src/a.ts" });
});

test("malformed stat results/unsafe normalized paths fail closed", async () => {
  assert.deepEqual(await probeFixture({ "src/a.ts": { path: "src/a.ts", ok: true } }).result, { kind: "failed" });
  assert.deepEqual(await probeFixture({ "src/a.ts": { ...file("src/a.ts"), normalizedPath: "../a.ts" } }).result, { kind: "failed" });
});
