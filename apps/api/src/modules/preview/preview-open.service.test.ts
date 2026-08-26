import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../app/errors.js";
import { openWorkspacePreview } from "./preview-open.service.js";

const entryTarget = {
  kind: "file" as const,
  workspaceId: "workspace",
  rootRealPath: "/workspace",
  relativePath: "demo/index.html",
  absolutePath: "/workspace/demo/index.html",
  stat: {} as any,
  resource: { extension: ".html", mime: "text/html", kind: "html" as const, entry: true, range: false }
};

function runtime() {
  const issued: Array<{ workspaceId: string; entryPath: string }> = [];
  return {
    runtime: {
      publicOrigin: "https://preview.example.test",
      issueBootstrap(input: { workspaceId: string; entryPath: string }) {
        issued.push(input);
        return { code: "bootstrap_code_0123456789abcdefg" };
      }
    },
    issued
  };
}

function previewFileError(failure: string) {
  return Object.assign(new Error(`Preview file request rejected: ${failure}`), { name: "PreviewFileError", failure });
}

async function expectHttpError(action: () => Promise<unknown>, statusCode: number, code?: string) {
  await assert.rejects(action, (error: unknown) => error instanceof HttpError && error.statusCode === statusCode && error.code === code);
}

test("open requires Fetch Metadata before resolving or issuing a code", async () => {
  const state = runtime();
  let resolved = false;
  await expectHttpError(
    () => openWorkspacePreview({
      runtime: state.runtime as any,
      fileService: { async resolve() { resolved = true; return entryTarget; }, async open() { throw new Error("not used"); } },
      workspaceId: "workspace", path: "demo/index.html", secFetchSite: undefined, origin: undefined
    }),
    403,
    "PREVIEW_REQUEST_FORBIDDEN"
  );
  assert.equal(resolved, false);
  assert.deepEqual(state.issued, []);
});

test("open only accepts validated entry files and returns a fragment-only bootstrap capability", async () => {
  const state = runtime();
  const location = await openWorkspacePreview({
    runtime: state.runtime as any,
    fileService: { async resolve() { return entryTarget; }, async open() { throw new Error("not used"); } },
    workspaceId: "workspace", path: "demo/index.html", secFetchSite: "same-origin", origin: "https://main.example.test"
  });
  assert.equal(location, "https://preview.example.test/__awb/bootstrap#bootstrap_code_0123456789abcdefg");
  assert.deepEqual(state.issued, [{ workspaceId: "workspace", entryPath: "demo/index.html" }]);

  await expectHttpError(
    () => openWorkspacePreview({
      runtime: state.runtime as any,
      fileService: { async resolve() { return { ...entryTarget, resource: { ...entryTarget.resource, entry: false } }; }, async open() { throw new Error("not used"); } },
      workspaceId: "workspace", path: "demo/styles.css", secFetchSite: "same-origin", origin: undefined
    }),
    403,
    "PREVIEW_ENTRY_UNSUPPORTED"
  );
});

test("open maps missing workspace and unsafe paths to main app error contracts", async () => {
  const state = runtime();
  await expectHttpError(
    () => openWorkspacePreview({
      runtime: state.runtime as any,
      fileService: { async resolve() { throw previewFileError("workspace_missing"); }, async open() { throw new Error("not used"); } },
      workspaceId: "missing", path: "demo/index.html", secFetchSite: "same-origin", origin: undefined
    }),
    404
  );
  await expectHttpError(
    () => openWorkspacePreview({
      runtime: state.runtime as any,
      fileService: { async resolve() { throw previewFileError("symlink"); }, async open() { throw new Error("not used"); } },
      workspaceId: "workspace", path: "demo/index.html", secFetchSite: "same-origin", origin: undefined
    }),
    403,
    "PREVIEW_PATH_UNSAFE"
  );
});
