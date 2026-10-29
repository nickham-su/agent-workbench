import { detectWorkspaceArchiveFormat, type WorkspaceFileExtractRequest, type WorkspaceFileExtractResponse } from "@agent-workbench/shared";

type ArchiveNode = { data: { kind: string; name: string; path: string } };
export type ArchiveExtractionScope = { workspaceId: string; scope: number };
export type ArchiveExtractionTarget = ArchiveExtractionScope & { path: string; dir: string };
export type ArchiveExtractionFeedback = { kind: "success" | "error" | "warning"; key: string };

export function canExtractWorkspaceArchive(node: ArchiveNode | null): boolean {
  return node?.data.kind === "file" && !!detectWorkspaceArchiveFormat(node.data.name);
}

// Only trusted codes select UI copy. Backend/transport messages can contain private paths.
const archiveErrorKeys: Readonly<Record<string, string>> = {
  ARCHIVE_PATH_INVALID: "invalidPath",
  ARCHIVE_FORMAT_UNSUPPORTED: "unsupportedFormat",
  ARCHIVE_INVALID: "invalidArchive",
  ARCHIVE_FEATURE_UNSUPPORTED: "unsupportedFeature",
  ARCHIVE_ENTRY_UNSUPPORTED: "unsupportedEntry",
  ARCHIVE_ENTRY_INVALID: "invalidEntry",
  ARCHIVE_PERMISSION_DENIED: "permissionDenied",
  ARCHIVE_SOURCE_NOT_FOUND: "sourceNotFound",
  ARCHIVE_TARGET_CONFLICT: "targetConflict",
  ARCHIVE_SOURCE_CHANGED: "sourceChanged",
  ARCHIVE_TARGET_CHANGED: "targetChanged",
  ARCHIVE_FILESYSTEM_UNSUPPORTED: "unsupportedFilesystem",
  ARCHIVE_LIMIT_EXCEEDED: "limitExceeded",
  ARCHIVE_TIMEOUT: "timeout",
  ARCHIVE_BUSY: "busy",
  ARCHIVE_STORAGE_EXHAUSTED: "storageExhausted",
  ARCHIVE_IO_FAILED: "ioFailed",
  ARCHIVE_CLEANUP_INCOMPLETE: "cleanupIncomplete",
  WORKSPACE_DELETING: "workspaceDeleting",
  WORKSPACE_PATH_INVALID: "workspaceInvalid"
};

export function archiveExtractionErrorFeedback(error: unknown): ArchiveExtractionFeedback {
  const candidate = error && typeof error === "object" ? error as { code?: unknown; status?: unknown } : {};
  const status = candidate.status;
  if (typeof status === "number" && status >= 400 && status <= 599) {
    const suffix = typeof candidate.code === "string" && Object.hasOwn(archiveErrorKeys, candidate.code)
      ? archiveErrorKeys[candidate.code] : undefined;
    if (suffix) return { kind: suffix === "cleanupIncomplete" ? "warning" : "error", key: `files.extract.errors.${suffix}` };
    if (status === 401) return { kind: "error", key: "files.extract.errors.unauthorized" };
    if (status === 403) return { kind: "error", key: "files.extract.errors.permissionDenied" };
    if (status === 404) return { kind: "error", key: "files.extract.errors.unavailable" };
    if (status === 400) return { kind: "error", key: "files.extract.errors.invalidRequest" };
  }
  // Includes lost responses and unclassified proxy/server errors: the operation may have committed.
  return { kind: "warning", key: "files.extract.resultUnknown" };
}

type ExtractionOperation = { target: ArchiveExtractionTarget; messageKey: string; loading: boolean };

/** Small view-local operation controller, not a background task or request cancellation layer. */
export function createArchiveExtractionController(options: {
  getScope: () => ArchiveExtractionScope;
  request: (params: { workspaceId: string } & WorkspaceFileExtractRequest) => Promise<WorkspaceFileExtractResponse>;
  refresh: (target: ArchiveExtractionTarget) => Promise<void>;
  setBusy: (busy: boolean) => void;
  loading: (key: string) => void;
  destroyLoading: (key: string) => void;
  notify: (feedback: ArchiveExtractionFeedback) => void;
}) {
  const controllerId = ++nextControllerId;
  let sequence = 0;
  let active: ExtractionOperation | undefined;
  let disposed = false;

  const closeLoading = (operation: ExtractionOperation) => {
    if (!operation.loading) return;
    operation.loading = false;
    options.destroyLoading(operation.messageKey);
  };
  const isCurrent = (operation: ExtractionOperation) => {
    const current = options.getScope();
    return !disposed && active === operation && current.workspaceId === operation.target.workspaceId && current.scope === operation.target.scope;
  };
  const finishWith = (operation: ExtractionOperation, feedback: ArchiveExtractionFeedback) => {
    if (!isCurrent(operation)) return;
    closeLoading(operation);
    options.notify(feedback);
  };
  const invalidate = () => {
    if (!active) return;
    closeLoading(active);
    active = undefined;
    options.setBusy(false);
  };

  return {
    invalidate,
    dispose() { disposed = true; invalidate(); },
    async extract(node: ArchiveNode | null): Promise<void> {
      if (disposed || active || !canExtractWorkspaceArchive(node) || !node?.data.path) return;
      // Copy primitives before the first await; selection and props can change while the request runs.
      const path = node.data.path;
      const target = { ...options.getScope(), path, dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" };
      const operation: ExtractionOperation = { target, messageKey: `files-extract-${controllerId}-${++sequence}`, loading: true };
      active = operation;
      options.setBusy(true);
      try {
        options.loading(operation.messageKey);
        let result: WorkspaceFileExtractResponse;
        try {
          result = await options.request({ workspaceId: target.workspaceId, path: target.path });
        } catch (error) {
          if (!isCurrent(operation)) return;
          const feedback = archiveExtractionErrorFeedback(error);
          // Publishing failures can leave known residuals; a failed refresh must not replace this error.
          try { await options.refresh(target); } catch { /* Preserve the original safe feedback. */ }
          finishWith(operation, feedback);
          return;
        }
        if (!isCurrent(operation)) return;
        try { await options.refresh(target); }
        catch {
          finishWith(operation, { kind: "warning", key: "files.extract.refreshFailed" });
          return;
        }
        finishWith(operation, { kind: "success", key: result.topLevelCount === 0 ? "files.extract.empty" : "files.extract.success" });
      } finally {
        closeLoading(operation);
        // An obsolete request must not clear the busy state of a later scope's operation.
        if (active === operation) {
          active = undefined;
          options.setBusy(false);
        }
      }
    }
  };
}

let nextControllerId = 0;
