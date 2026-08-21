export type ApplyPatchSlimFile = {
  type: "add" | "update" | "delete" | "move";
  path: string;
  fromPath?: string;
  additions: number;
  deletions: number;
};

type ApplyPatchSlimResult = {
  text: string;
  summary: { fileCount: number; additions: number; deletions: number };
  files: ApplyPatchSlimFile[];
};

type ApplyPatchUiArtifactPayload = {
  schemaVersion: 1;
  toolName: "apply_patch";
  summary: { fileCount: number; additions: number; deletions: number };
  files: Array<ApplyPatchSlimFile & { before: string; after: string }>;
};

type WriteSlimResult = {
  summary: string;
  filePath: string;
  bytesWritten: number;
  existedBefore: boolean;
};

type WriteUiArtifactSide = {
  available: boolean;
  text?: string;
  truncated: boolean;
  bytes: number;
  reason?: string;
};

type WriteUiArtifactPayload = {
  schemaVersion: 1;
  toolName: "write";
  filePath: string;
  summary: { bytesWritten: number; existedBefore: boolean };
  before: WriteUiArtifactSide;
  after: WriteUiArtifactSide;
};

/** Writeback-only full-result splitting; artifact I/O remains in the capability. */
export function splitApplyPatchResult(raw: unknown): { slim: ApplyPatchSlimResult; artifact: ApplyPatchUiArtifactPayload } {
  const src = toRecord(raw) || {};
  const text = typeof src.text === "string" ? src.text : "";
  const summaryRaw = toRecord(src.summary) || {};
  const filesRaw = Array.isArray(src.files) ? src.files : [];
  const filesSlim: ApplyPatchSlimFile[] = [];
  const filesArtifact: Array<ApplyPatchSlimFile & { before: string; after: string }> = [];

  for (const row of filesRaw) {
    const file = toRecord(row);
    if (!file) continue;
    const typeRaw = String(file.type || "update").trim();
    const type = (typeRaw === "add" || typeRaw === "update" || typeRaw === "delete" || typeRaw === "move")
      ? typeRaw as ApplyPatchSlimFile["type"]
      : "update";
    const path = String(file.path || file.relativePath || file.filePath || "").trim();
    if (!path) continue;
    const fromPath = String(file.fromPath || file.moveFromPath || "").trim();
    const additions = toNonNegativeInt(file.additions);
    const deletions = toNonNegativeInt(file.deletions);
    const before = typeof file.before === "string" ? file.before : "";
    const after = typeof file.after === "string" ? file.after : "";
    const slim: ApplyPatchSlimFile = { type, path, ...(fromPath ? { fromPath } : {}), additions, deletions };
    filesSlim.push(slim);
    filesArtifact.push({ ...slim, before, after });
  }

  const summary = {
    fileCount: toNonNegativeInt(summaryRaw.fileCount ?? filesSlim.length),
    additions: toNonNegativeInt(summaryRaw.additions ?? filesSlim.reduce((sum, file) => sum + file.additions, 0)),
    deletions: toNonNegativeInt(summaryRaw.deletions ?? filesSlim.reduce((sum, file) => sum + file.deletions, 0))
  };
  return { slim: { text, summary, files: filesSlim }, artifact: { schemaVersion: 1, toolName: "apply_patch", summary, files: filesArtifact } };
}

export function splitWriteResult(raw: unknown): { slim: WriteSlimResult; artifact: WriteUiArtifactPayload } {
  const src = toRecord(raw) || {};
  const filePath = String(src.filePath || src.path || "").trim();
  const bytesWritten = toNonNegativeInt(src.bytesWritten ?? src.bytes);
  const existedBefore = src.existedBefore === true;
  const summary = typeof src.summary === "string" && src.summary.trim()
    ? src.summary
    : filePath ? `Wrote file ${filePath}` : "write completed";
  const before = normalizeWriteUiSide(src.before, "missing_file");
  const after = normalizeWriteUiSide(src.after, "missing_content");
  return {
    slim: { summary, filePath, bytesWritten, existedBefore },
    artifact: { schemaVersion: 1, toolName: "write", filePath, summary: { bytesWritten, existedBefore }, before, after }
  };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNonNegativeInt(value: unknown) {
  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function normalizeWriteUiSide(raw: unknown, fallbackReason: string): WriteUiArtifactSide {
  const side = toRecord(raw);
  if (!side) return { available: false, truncated: false, bytes: 0, reason: fallbackReason };
  const available = side.available === true;
  const text = typeof side.text === "string" ? side.text : "";
  const bytes = toNonNegativeInt(side.bytes ?? Buffer.byteLength(text, "utf8"));
  const truncated = side.truncated === true;
  const reason = typeof side.reason === "string" && side.reason.trim() ? side.reason.trim() : fallbackReason;
  if (!available) return { available: false, truncated: false, bytes, reason };
  return { available: true, text, truncated, bytes };
}
