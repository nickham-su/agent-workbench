import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "@sinclair/typebox/value";
import { detectWorkspaceArchiveFormat, WORKSPACE_ARCHIVE_SUFFIXES } from "../src/workspace-archive-formats.js";
import { WorkspaceFileExtractRequestSchema, WorkspaceFileExtractResponseSchema } from "../src/contracts/workspace-files.js";

test("archive suffix detection is ASCII case insensitive, compound first, and does not trim", () => {
  assert.equal(WORKSPACE_ARCHIVE_SUFFIXES[0][0], ".tar.gz");
  for (const [name, format] of [["A.ZIP", "zip"], ["a.TaR", "tar"], ["demo.TAR.GZ", "tar-gzip"], ["a.TgZ", "tar-gzip"], [".zip", "zip"], ["包.zip", "zip"]]) {
    assert.equal(detectWorkspaceArchiveFormat(name), format);
  }
  for (const name of ["a.gz", "a.tar.xz", "a.zip.bak", "a.zip ", "a.rar", "a.7z", "", "ZIP"]) {
    assert.equal(detectWorkspaceArchiveFormat(name), null, name);
  }
});

test("extract request restricts its contract to a bounded path, never extraction controls", () => {
  assert.ok(Value.Check(WorkspaceFileExtractRequestSchema, { path: "a.zip" }));
  assert.ok(Value.Check(WorkspaceFileExtractRequestSchema, { path: "x".repeat(4096) }));
  for (const value of [{ path: "" }, { path: "x".repeat(4097) }, { path: "a.zip", destination: "x" }, { path: "a.zip", overwrite: true }, { path: "a.zip", password: "test-only" }]) {
    assert.equal(Value.Check(WorkspaceFileExtractRequestSchema, value), false);
  }
  // Schema length is not a substitute for endpoint UTF-8 and canonical-path checks.
  assert.ok(Value.Check(WorkspaceFileExtractRequestSchema, { path: "中".repeat(2000) }));
});

test("extract response supports an empty archive and root parent without unbounded lists", () => {
  const value = { path: "a.tgz", dir: "", format: "tar-gzip", topLevelCount: 0, fileCount: 0, directoryCount: 0, extractedBytes: 0 };
  assert.ok(Value.Check(WorkspaceFileExtractResponseSchema, value));
  for (const change of [{ format: "rar" }, { fileCount: -1 }, { directoryCount: 0.5 }, { topLevelCount: 20_001 }, { extractedBytes: 2 * 1024 ** 3 + 1 }, { files: [] }]) {
    assert.equal(Value.Check(WorkspaceFileExtractResponseSchema, { ...value, ...change }), false);
  }
});
