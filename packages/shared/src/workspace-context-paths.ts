import { isValidSkillPathSegment } from "./skills-protocol.js";

export type ParsedWorkspaceRelativePath = {
  path: string;
  segments: string[];
};

/** Preserve the exact filesystem spelling: no trimming, case folding or Unicode normalization. */
export function parseWorkspaceRelativePosixPath(raw: unknown): ParsedWorkspaceRelativePath | null {
  if (typeof raw !== "string" || !raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return null;
  const segments = raw.split("/");
  if (!segments.every(isValidSkillPathSegment)) return null;
  return { path: raw, segments };
}

export function parseExternalWorkspaceSkillId(raw: unknown): ParsedWorkspaceRelativePath | null {
  const parsed = parseWorkspaceRelativePosixPath(raw);
  if (!parsed || parsed.segments.length > 4 || parsed.segments[0] === "builtin") return null;
  return parsed;
}

export function parseWorkspaceAgentsInstructionPath(raw: unknown): ParsedWorkspaceRelativePath | null {
  const parsed = parseWorkspaceRelativePosixPath(raw);
  if (!parsed || parsed.segments.length > 5 || parsed.segments.at(-1) !== "AGENTS.md") return null;
  return parsed;
}

/** localeCompare is locale-dependent; byte ordering is stable for discovered paths. */
export function compareWorkspaceRelativePathsUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
