/** Ordered longest suffix first. Matching never changes the actual file name. */
export const WORKSPACE_ARCHIVE_SUFFIXES = [
  [".tar.gz", "tar-gzip"],
  [".tgz", "tar-gzip"],
  [".zip", "zip"],
  [".tar", "tar"]
] as const;

export type WorkspaceArchiveFormat = (typeof WORKSPACE_ARCHIVE_SUFFIXES)[number][1];

/** Node kind is deliberately not inferred here: the UI must also require a file. */
export function detectWorkspaceArchiveFormat(name: string): WorkspaceArchiveFormat | null {
  const lower = name.replace(/[A-Z]/g, (char) => char.toLowerCase());
  return WORKSPACE_ARCHIVE_SUFFIXES.find(([suffix]) => lower.endsWith(suffix))?.[1] ?? null;
}
