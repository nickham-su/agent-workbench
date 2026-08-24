import path from "node:path";

export const MAX_WORKSPACE_REPO_DIR_NAMES = 100;

/**
 * Validates one untrusted workspace repository directory name without filesystem access.
 * Keep this rule aligned with the API's independent boundary validation.
 */
export function isSafeWorkspaceRepoDirName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return Boolean(value)
    && value.trim() === value
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0")
    && !value.includes("\n")
    && !value.includes("\r")
    && !path.isAbsolute(value)
    && !path.win32.isAbsolute(value);
}

/**
 * Filters unsafe values, preserves first-seen order, removes duplicates, and applies the Worker limit.
 */
export function normalizeWorkspaceRepoDirNames(values: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!isSafeWorkspaceRepoDirName(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length === MAX_WORKSPACE_REPO_DIR_NAMES) break;
  }
  return result;
}
