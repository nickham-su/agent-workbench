import { HttpError } from "../../app/errors.js";
import type { PreviewFileError, PreviewFileService, ResolvedPreviewFile } from "./preview-file.service.js";
import type { PreviewRuntime } from "./preview-runtime.js";
import { assertSameOriginBrowserRequest, PreviewBrowserRequestForbiddenError } from "./preview-security.js";

function isPreviewFileError(error: unknown): error is PreviewFileError {
  return error instanceof Error && error.name === "PreviewFileError" && typeof (error as PreviewFileError).failure === "string";
}

function mapPreviewOpenFileError(error: unknown): never {
  if (!isPreviewFileError(error)) throw error;
  if (error.failure === "workspace_missing" || error.failure === "path_missing") {
    throw new HttpError(404, "Not Found");
  }
  if (error.failure === "unsupported_type") {
    throw new HttpError(403, "Preview entry is not supported", "PREVIEW_ENTRY_UNSUPPORTED");
  }
  throw new HttpError(403, "Preview path is not allowed", "PREVIEW_PATH_UNSAFE");
}

function isPreviewEntry(target: Awaited<ReturnType<PreviewFileService["resolve"]>>): target is ResolvedPreviewFile {
  return target.kind === "file" && target.resource.entry;
}

/** Validates a main-origin form request and creates its one-time preview capability. */
export async function openWorkspacePreview(params: {
  runtime: PreviewRuntime;
  fileService: PreviewFileService;
  workspaceId: string;
  path: string;
  secFetchSite: string | undefined;
  origin: string | undefined;
}) {
  try {
    // Main deployments can be behind Vite's development proxy. V1 has no trusted
    // main public-origin config, so Fetch Metadata is the mandatory boundary.
    assertSameOriginBrowserRequest({ secFetchSite: params.secFetchSite, origin: params.origin });
  } catch (error) {
    if (error instanceof PreviewBrowserRequestForbiddenError) {
      throw new HttpError(403, "Preview request is not allowed", "PREVIEW_REQUEST_FORBIDDEN");
    }
    throw error;
  }

  let target: Awaited<ReturnType<PreviewFileService["resolve"]>>;
  try {
    target = await params.fileService.resolve({
      workspaceId: params.workspaceId,
      decodedPath: params.path,
      trailingSlash: params.path.endsWith("/")
    });
  } catch (error) {
    return mapPreviewOpenFileError(error);
  }
  if (!isPreviewEntry(target)) {
    throw new HttpError(403, "Preview entry is not supported", "PREVIEW_ENTRY_UNSUPPORTED");
  }

  const bootstrap = params.runtime.issueBootstrap({ workspaceId: target.workspaceId, entryPath: target.relativePath });
  return `${params.runtime.publicOrigin}/__awb/bootstrap#${bootstrap.code}`;
}
