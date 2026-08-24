import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertSafeRegularFile,
  ensureSafeDirectoryUnderWorkspace,
  readSafeRegularFileUtf8,
  requireNoFollowFlag,
  resolveSafeWorkspace,
  safePathSegment,
  type SafeWorkspace
} from "./workspaceSafeIo.js";

export type FailureKind = "tool" | "policy" | "recovery" | "runtime";

export type ToolErrorArtifactIdentity = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  itemId: number;
  toolCallId: string;
};

export type ToolErrorArtifact = {
  schemaVersion: 1;
  kind: "tool_error";
  captureId: string;
  recordedAt: number;
  failureKind: FailureKind;
  identity: ToolErrorArtifactIdentity;
  [key: string]: unknown;
};

export type ToolErrorStoreInput = {
  workspacePath: string;
  artifact: ToolErrorArtifact;
};

export type ToolErrorStoreResult =
  | { outcome: "published"; path: string; relativePath: string; conflict: false }
  | { outcome: "idempotent"; path: string; relativePath: string; conflict: false }
  | { outcome: "published"; path: string; relativePath: string; conflict: true }
  | { outcome: "failed"; operation: string; error: unknown; relativePath?: string };

type StoreDependencies = {
  open: typeof fs.open;
  lstat: typeof fs.lstat;
  link: typeof fs.link;
  unlink: typeof fs.unlink;
  resolveSafeWorkspace: typeof resolveSafeWorkspace;
  ensureSafeDirectoryUnderWorkspace: typeof ensureSafeDirectoryUnderWorkspace;
  assertSafeRegularFile: typeof assertSafeRegularFile;
  readSafeRegularFileUtf8: typeof readSafeRegularFileUtf8;
  requireNoFollowFlag: typeof requireNoFollowFlag;
};

const defaultDependencies: StoreDependencies = {
  open: fs.open,
  lstat: fs.lstat,
  link: fs.link,
  unlink: fs.unlink,
  resolveSafeWorkspace,
  ensureSafeDirectoryUnderWorkspace,
  assertSafeRegularFile,
  readSafeRegularFileUtf8,
  requireNoFollowFlag
};

let temporarySequence = 0;

function isErrno(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === code);
}

function errorCode(error: unknown) {
  return error && typeof error === "object" ? (error as NodeJS.ErrnoException).code : undefined;
}

function assertIdentity(identity: ToolErrorArtifactIdentity) {
  if (!Number.isSafeInteger(identity.itemId) || identity.itemId <= 0) {
    throw new Error("tool error artifact itemId must be a positive safe integer");
  }
  for (const value of [identity.workspaceId, identity.sessionId, identity.runId, identity.toolCallId]) {
    if (typeof value !== "string") throw new Error("tool error artifact identity values must be strings");
  }
}

function assertArtifact(artifact: ToolErrorArtifact) {
  if (artifact.schemaVersion !== 1 || artifact.kind !== "tool_error") {
    throw new Error("unsupported tool error artifact schema");
  }
  if (!isFailureKind(artifact.failureKind)) throw new Error("invalid tool error artifact failureKind");
  if (typeof artifact.captureId !== "string" || typeof artifact.recordedAt !== "number") {
    throw new Error("invalid tool error artifact metadata");
  }
  assertIdentity(artifact.identity);
}

export function isFailureKind(value: unknown): value is FailureKind {
  return value === "tool" || value === "policy" || value === "recovery" || value === "runtime";
}

export function buildToolErrorArtifactRelativePath(identity: ToolErrorArtifactIdentity, failureKind: FailureKind) {
  assertIdentity(identity);
  if (!isFailureKind(failureKind)) throw new Error("invalid tool error artifact failureKind");
  const baseName = `${identity.itemId}-${safePathSegment(identity.toolCallId)}.${failureKind}.json`;
  return path.join(
    ".awb",
    "agent",
    "tool-errors",
    "by_run",
    safePathSegment(identity.sessionId),
    safePathSegment(identity.runId),
    baseName
  );
}

function identityMatches(value: unknown, identity: ToolErrorArtifactIdentity, failureKind: FailureKind) {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ToolErrorArtifact>;
  const existing = candidate.identity;
  if (!existing) return false;
  return candidate.schemaVersion === 1
    && candidate.kind === "tool_error"
    && candidate.failureKind === failureKind
    && existing.workspaceId === identity.workspaceId
    && existing.sessionId === identity.sessionId
    && existing.runId === identity.runId
    && existing.itemId === identity.itemId
    && existing.toolCallId === identity.toolCallId;
}

async function canonicalState(
  workspace: SafeWorkspace,
  canonicalPath: string,
  artifact: ToolErrorArtifact,
  deps: StoreDependencies
): Promise<"missing" | "same" | "conflict"> {
  try {
    await deps.assertSafeRegularFile(workspace, canonicalPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return "missing";
    return "conflict";
  }

  try {
    const parsed = JSON.parse(await deps.readSafeRegularFileUtf8(workspace, canonicalPath)) as unknown;
    return identityMatches(parsed, artifact.identity, artifact.failureKind) ? "same" : "conflict";
  } catch {
    return "conflict";
  }
}

function conflictPathFor(canonicalPath: string, recordedAt: number, attempt: number) {
  const extension = ".json";
  const base = canonicalPath.endsWith(extension) ? canonicalPath.slice(0, -extension.length) : canonicalPath;
  return `${base}.conflict-${safePathSegment(String(recordedAt))}-${attempt}.json`;
}

async function writeTempAndSync(filePath: string, payload: string, deps: StoreDependencies) {
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | deps.requireNoFollowFlag();
  const handle = await deps.open(filePath, flags, 0o600);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeBestEffort(filePath: string, deps: StoreDependencies) {
  try {
    await deps.unlink(filePath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

function relativePathFor(workspace: SafeWorkspace, filePath: string) {
  return path.relative(workspace.workspacePath, filePath);
}

/**
 * Publishes one error artifact without overwriting an existing canonical file.
 * It intentionally returns failures instead of throwing so Runner integration can stay best-effort.
 */
export async function storeToolErrorArtifact(
  input: ToolErrorStoreInput,
  overrides: Partial<StoreDependencies> = {}
): Promise<ToolErrorStoreResult> {
  const deps = { ...defaultDependencies, ...overrides };
  let temporaryPath: string | undefined;
  let operation = "validate";
  // 校验 identity 前不能安全地构造规范路径；此类早期失败按合同保留 path=unknown。
  let relativePath: string | undefined;

  try {
    assertArtifact(input.artifact);
    relativePath = buildToolErrorArtifactRelativePath(input.artifact.identity, input.artifact.failureKind);
    const payload = `${JSON.stringify(input.artifact, null, 2)}\n`;
    operation = "resolve_workspace";
    const workspace = await deps.resolveSafeWorkspace(input.workspacePath);
    const segments = relativePath.split(path.sep);
    const fileName = segments.pop();
    if (!fileName) throw new Error("tool error artifact file name is missing");

    operation = "ensure_directory";
    const directory = await deps.ensureSafeDirectoryUnderWorkspace(workspace, segments);
    const canonicalPath = path.join(directory, fileName);

    operation = "inspect_canonical";
    const currentState = await canonicalState(workspace, canonicalPath, input.artifact, deps);
    if (currentState === "same") {
      return { outcome: "idempotent", path: canonicalPath, relativePath, conflict: false };
    }

    const publishConflict = currentState === "conflict";
    const captureSegment = safePathSegment(input.artifact.captureId);
    const nextSequence = ++temporarySequence;
    temporaryPath = path.join(directory, `.${fileName}.${process.pid}.${captureSegment}.${nextSequence}.tmp`);

    operation = "write_temp";
    await deps.ensureSafeDirectoryUnderWorkspace(workspace, segments);
    await writeTempAndSync(temporaryPath, payload, deps);

    for (let attempt = publishConflict ? 1 : 0; attempt <= 1000; attempt += 1) {
      const finalPath = publishConflict ? conflictPathFor(canonicalPath, input.artifact.recordedAt, attempt || 1) : canonicalPath;
      operation = "publish_link";
      await deps.ensureSafeDirectoryUnderWorkspace(workspace, segments);
      try {
        await deps.link(temporaryPath, finalPath);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;

        if (!publishConflict) {
          operation = "reinspect_canonical";
          const stateAfterConflict = await canonicalState(workspace, canonicalPath, input.artifact, deps);
          if (stateAfterConflict === "same") {
            await removeBestEffort(temporaryPath, deps);
            temporaryPath = undefined;
            return { outcome: "idempotent", path: canonicalPath, relativePath, conflict: false };
          }
          return await publishConflictArtifact(workspace, canonicalPath, relativePath, input.artifact, temporaryPath, deps);
        }
        continue;
      }

      operation = "verify_final";
      await deps.assertSafeRegularFile(workspace, finalPath);
      await removeBestEffort(temporaryPath, deps);
      temporaryPath = undefined;
      return {
        outcome: "published",
        path: finalPath,
        relativePath: relativePathFor(workspace, finalPath),
        conflict: publishConflict
      };
    }

    throw new Error("tool error artifact conflict attempts exhausted");
  } catch (error) {
    if (temporaryPath) {
      try {
        await removeBestEffort(temporaryPath, deps);
      } catch {
        // Store remains best-effort; cleanup failures are included in the caller's warning context only by operation.
      }
    }
    return { outcome: "failed", operation, error, ...(relativePath ? { relativePath } : {}) };
  }
}

async function publishConflictArtifact(
  workspace: SafeWorkspace,
  canonicalPath: string,
  relativePath: string,
  artifact: ToolErrorArtifact,
  temporaryPath: string,
  deps: StoreDependencies
): Promise<ToolErrorStoreResult> {
  for (let attempt = 1; attempt <= 1000; attempt += 1) {
    const conflictPath = conflictPathFor(canonicalPath, artifact.recordedAt, attempt);
    await deps.ensureSafeDirectoryUnderWorkspace(workspace, relativePath.split(path.sep).slice(0, -1));
    try {
      await deps.link(temporaryPath, conflictPath);
    } catch (error) {
      if (isErrno(error, "EEXIST")) continue;
      throw error;
    }
    await deps.assertSafeRegularFile(workspace, conflictPath);
    await removeBestEffort(temporaryPath, deps);
    return {
      outcome: "published",
      path: conflictPath,
      relativePath: relativePathFor(workspace, conflictPath),
      conflict: true
    };
  }
  throw new Error("tool error artifact conflict attempts exhausted");
}

function normalizeWarningText(value: unknown) {
  return String(value ?? "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatToolErrorStoreWarning(input: {
  relativePath?: string;
  operation: string;
  error: unknown;
  suppressed?: number;
}) {
  const error = input.error instanceof Error ? input.error : undefined;
  const code = errorCode(input.error);
  const message = error ? error.message : String(input.error ?? "unknown error");
  const suffix = input.suppressed ? ` suppressed=${input.suppressed}` : "";
  const line = [
    "[tool-error-store]",
    `path=${input.relativePath ?? "unknown"}`,
    `operation=${input.operation}`,
    `error=${error?.name ?? "Error"}`,
    ...(code ? [`code=${code}`] : []),
    `message=${normalizeWarningText(message)}`
  ].join(" ");
  const normalized = normalizeWarningText(line);
  return `${normalized.slice(0, Math.max(0, 512 - suffix.length))}${suffix}`;
}
