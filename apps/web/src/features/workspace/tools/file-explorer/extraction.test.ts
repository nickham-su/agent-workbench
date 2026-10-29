import assert from "node:assert/strict";
import test from "node:test";
import { createI18n } from "vue-i18n";
import type { WorkspaceFileExtractResponse } from "@agent-workbench/shared";
import zhCN from "../../../../shared/i18n/locales/zh-CN";
import enUS from "../../../../shared/i18n/locales/en-US";
import { createFileExplorerRuntime } from "./runtime";
import {
  archiveExtractionErrorFeedback, canExtractWorkspaceArchive, createArchiveExtractionController,
  type ArchiveExtractionFeedback, type ArchiveExtractionTarget
} from "./extraction";

const node = (path: string, kind = "file") => ({ data: { path, name: path.slice(path.lastIndexOf("/") + 1), kind } });
const response = (topLevelCount = 1): WorkspaceFileExtractResponse => ({
  path: "source.zip", dir: "", format: "zip", topLevelCount, fileCount: topLevelCount, directoryCount: 0, extractedBytes: topLevelCount
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let scope = { workspaceId: "old-workspace", scope: 1 };
  const calls: Array<{ workspaceId: string; path: string }> = [];
  const replies: ReturnType<typeof deferred<WorkspaceFileExtractResponse>>[] = [];
  const refreshed: ArchiveExtractionTarget[] = [];
  const busy: boolean[] = [];
  const loading: string[] = [];
  const destroyed: string[] = [];
  const notices: ArchiveExtractionFeedback[] = [];
  let refresh: (target: ArchiveExtractionTarget) => Promise<void> = async () => {};
  const controller = createArchiveExtractionController({
    getScope: () => scope,
    request: (params) => { calls.push(params); const reply = deferred<WorkspaceFileExtractResponse>(); replies.push(reply); return reply.promise; },
    refresh: async (target) => { refreshed.push(target); await refresh(target); },
    setBusy: (value) => { busy.push(value); },
    loading: (key) => { loading.push(key); },
    destroyLoading: (key) => { destroyed.push(key); },
    notify: (notice) => { notices.push(notice); }
  });
  return { controller, calls, replies, refreshed, busy, loading, destroyed, notices,
    scope: (next: typeof scope) => { scope = next; }, refresh: (next: typeof refresh) => { refresh = next; } };
}

test("A-UI-01: file-only extraction visibility uses shared compound and case-insensitive suffix rules", () => {
  for (const path of ["A.ZIP", "a.TAR", "d/a.TaR.Gz", "d/a.TgZ"]) assert.equal(canExtractWorkspaceArchive(node(path)), true, path);
  for (const path of ["a.gz", "a.tar.bz2", "a.tar.xz", "a.rar", "a.7z", "a.zip.txt"]) assert.equal(canExtractWorkspaceArchive(node(path)), false, path);
  assert.equal(canExtractWorkspaceArchive(node("a.zip", "dir")), false);
  assert.equal(canExtractWorkspaceArchive(null), false);
});

test("A-UI-02/03/04: capture primitives before awaiting; prevent double requests and refresh the source parent", async () => {
  const f = fixture();
  const selected = node("nested/source.ZIP");
  const run = f.controller.extract(selected);
  selected.data.path = "other/new.zip";
  await f.controller.extract(node("another.tar"));
  assert.deepEqual(f.calls, [{ workspaceId: "old-workspace", path: "nested/source.ZIP" }]);
  assert.deepEqual(f.busy, [true]);
  f.replies[0]!.resolve(response());
  await run;
  assert.deepEqual(f.refreshed, [{ workspaceId: "old-workspace", scope: 1, path: "nested/source.ZIP", dir: "nested" }]);
  assert.deepEqual(f.notices, [{ kind: "success", key: "files.extract.success" }]);
  assert.deepEqual(f.busy, [true, false]);
  assert.deepEqual(f.destroyed, f.loading);
});

test("A-UI-04: empty archive succeeds with distinct copy and root parent is an empty string", async () => {
  const f = fixture();
  const run = f.controller.extract(node("empty.tar"));
  f.replies[0]!.resolve(response(0));
  await run;
  assert.equal(f.refreshed[0]!.dir, "");
  assert.deepEqual(f.notices, [{ kind: "success", key: "files.extract.empty" }]);
});

test("A-UI-06: extraction success with refresh failure is not reported as extraction failure", async () => {
  const f = fixture();
  f.refresh(async () => { throw new Error("private refresh path"); });
  const run = f.controller.extract(node("source.zip"));
  f.replies[0]!.resolve(response());
  await run;
  assert.deepEqual(f.notices, [{ kind: "warning", key: "files.extract.refreshFailed" }]);
  assert.deepEqual(f.destroyed, f.loading);
});

test("A-UI-07/API-03: a failed best-effort refresh cannot replace a localized business failure", async () => {
  const f = fixture();
  f.refresh(async () => { throw new Error("private refresh data"); });
  const run = f.controller.extract(node("source.zip"));
  f.replies[0]!.reject({ status: 409, code: "ARCHIVE_TARGET_CONFLICT", message: "/private/example" });
  await run;
  assert.deepEqual(f.notices, [{ kind: "error", key: "files.extract.errors.targetConflict" }]);
  assert.equal(f.refreshed.length, 1);
  assert.deepEqual(f.busy, [true, false]);
});

test("A-UI-07/PUB-14: lost responses and unclassified proxy failures remain unknown and never retry", async () => {
  for (const error of [new Error("network /private/path"), { code: "ECONNABORTED" }, { status: 502 }, { status: 503 }, { status: 504 }, { status: 500, code: "UNEXPECTED" }]) {
    const f = fixture();
    const run = f.controller.extract(node("source.zip"));
    f.replies[0]!.reject(error);
    await run;
    assert.deepEqual(f.notices, [{ kind: "warning", key: "files.extract.resultUnknown" }]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.refreshed.length, 1);
    assert.deepEqual(f.destroyed, f.loading);
  }
});

test("A-UI-05: switching scopes frees only old loading; a late old finally cannot clear a new operation", async () => {
  const f = fixture();
  const old = f.controller.extract(node("old.zip"));
  f.scope({ workspaceId: "new-workspace", scope: 2 });
  f.controller.invalidate();
  assert.deepEqual(f.destroyed, [f.loading[0]]);
  const current = f.controller.extract(node("new.tgz"));
  assert.notEqual(f.loading[0], f.loading[1]);
  f.replies[0]!.resolve(response());
  await old;
  assert.equal(f.refreshed.length, 0);
  assert.equal(f.notices.length, 0);
  assert.deepEqual(f.busy, [true, false, true]);
  f.replies[1]!.resolve(response());
  await current;
  assert.equal(f.refreshed[0]!.workspaceId, "new-workspace");
  assert.equal(f.notices.length, 1);
  assert.deepEqual(f.busy, [true, false, true, false]);
  assert.deepEqual(f.destroyed, f.loading);
});

test("A-UI-05: scope identity is checked even before the invalidation watcher executes", async () => {
  const f = fixture();
  const run = f.controller.extract(node("old.zip"));
  f.scope({ workspaceId: "changed-workspace", scope: 1 });
  f.replies[0]!.reject({ status: 400, code: "ARCHIVE_INVALID" });
  await run;
  assert.equal(f.refreshed.length, 0);
  assert.equal(f.notices.length, 0);
  assert.deepEqual(f.destroyed, f.loading);
});

test("A-UI-05: switching while refreshing suppresses the old result and old state updates", async () => {
  const f = fixture();
  const refresh = deferred<void>();
  f.refresh(() => refresh.promise);
  const run = f.controller.extract(node("old.zip"));
  f.replies[0]!.resolve(response());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.refreshed.length, 1);
  f.scope({ workspaceId: "new-workspace", scope: 2 });
  f.controller.invalidate();
  refresh.reject(new Error("stale refresh /private/path"));
  await run;
  assert.equal(f.notices.length, 0);
  assert.deepEqual(f.destroyed, f.loading);
});

test("A-UI-05: disposal releases loading, invalidates callbacks and cannot cancel or restart backend work", async () => {
  for (const reject of [false, true]) {
    const f = fixture();
    const run = f.controller.extract(node("pending.zip"));
    f.controller.dispose();
    await f.controller.extract(node("ignored.tar"));
    if (reject) f.replies[0]!.reject({ status: 500, code: "ARCHIVE_CLEANUP_INCOMPLETE" });
    else f.replies[0]!.resolve(response());
    await run;
    assert.equal(f.calls.length, 1);
    assert.equal(f.refreshed.length, 0);
    assert.equal(f.notices.length, 0);
    assert.deepEqual(f.destroyed, f.loading);
    assert.deepEqual(f.busy, [true, false]);
  }
});

test("A-UI-03: pending refresh remains busy and invalid nodes never send a request", async () => {
  const f = fixture();
  await f.controller.extract(null);
  await f.controller.extract(node("folder.zip", "dir"));
  await f.controller.extract(node("source.rar"));
  assert.equal(f.calls.length, 0);
  const refresh = deferred<void>();
  f.refresh(() => refresh.promise);
  const run = f.controller.extract(node("source.zip"));
  f.replies[0]!.resolve(response());
  await new Promise<void>((resolve) => setImmediate(resolve));
  await f.controller.extract(node("another.tar"));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.busy, [true]);
  refresh.resolve();
  await run;
});

test("A-UI-08/API-03: every stable archive code has safe Chinese and English copy; no raw error fallback", () => {
  const codes = ["PATH_INVALID", "FORMAT_UNSUPPORTED", "INVALID", "FEATURE_UNSUPPORTED", "ENTRY_UNSUPPORTED", "ENTRY_INVALID", "PERMISSION_DENIED", "SOURCE_NOT_FOUND", "TARGET_CONFLICT", "SOURCE_CHANGED", "TARGET_CHANGED", "FILESYSTEM_UNSUPPORTED", "LIMIT_EXCEEDED", "TIMEOUT", "BUSY", "STORAGE_EXHAUSTED", "IO_FAILED", "CLEANUP_INCOMPLETE"];
  for (const [locale, messages] of [["zh-CN", zhCN], ["en-US", enUS]] as const) {
    const i18n = createI18n({ legacy: false, locale, messages: { [locale]: messages } });
    for (const suffix of codes) {
      const code = `ARCHIVE_${suffix}`;
      const feedback = archiveExtractionErrorFeedback({ code, status: 500, message: "/private/secret" });
      assert.notEqual(feedback.key, "files.extract.resultUnknown", code);
      const content = i18n.global.t(feedback.key);
      assert.notEqual(content, feedback.key, `${locale}/${code}`);
      assert.ok(content.length > 0);
      assert.doesNotMatch(content, /private|secret/);
      assert.equal(feedback.kind, suffix === "CLEANUP_INCOMPLETE" ? "warning" : "error");
    }
    for (const code of ["WORKSPACE_DELETING", "WORKSPACE_PATH_INVALID"]) {
      const feedback = archiveExtractionErrorFeedback({ status: 409, code, message: "/private/secret" });
      assert.notEqual(i18n.global.t(feedback.key), feedback.key);
    }
  }
  assert.equal(zhCN.files.actions.extract, "解压");
  assert.equal(enUS.files.actions.extract, "Extract");
  for (const status of [400, 401, 403, 404]) assert.equal(archiveExtractionErrorFeedback({ status, message: "/private/secret" }).kind, "error");
  for (const code of ["__proto__", "constructor", "toString", "OTHER"]) {
    assert.deepEqual(archiveExtractionErrorFeedback({ status: 500, code }), { kind: "warning", key: "files.extract.resultUnknown" });
  }
});

test("A-UI-09: hiding preserves work; becoming visible reuses the existing runtime refresh", () => {
  const calls: unknown[] = [];
  const runtime = createFileExplorerRuntime({ toolId: "files", host: { setToolDot: (...args: unknown[]) => calls.push(args) }, refreshView: () => { calls.push("refresh"); } } as unknown as Parameters<typeof createFileExplorerRuntime>[0]);
  runtime.onVisibilityChange?.(false);
  assert.deepEqual(calls, []);
  runtime.onVisibilityChange?.(true);
  assert.deepEqual(calls, ["refresh"]);
});
