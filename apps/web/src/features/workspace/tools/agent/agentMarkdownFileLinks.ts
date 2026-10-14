import type { FileStatResponse } from "@agent-workbench/shared";

export type AgentMarkdownFileLink = {
  path: string;
  line?: number;
  column?: number;
};

export type AgentMarkdownFileLinkError = "invalid_path" | "invalid_position";
export type ParsedAgentMarkdownFileLink =
  | { kind: "file"; link: AgentMarkdownFileLink }
  | { kind: "invalid"; reason: AgentMarkdownFileLinkError }
  | { kind: "other" };

function positiveInteger(value: string) {
  const number = Number(value);
  return /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0 ? number : null;
}

// The file API consumes decoded relative paths, not URLs. Never decode a path again here.
function normalizeRelativePath(path: string) {
  if (!path || path !== path.trim() || path.endsWith("/") || /^[\/\\-]/.test(path) || /[\\:\x00-\x1f\x7f]/.test(path)) return null;
  const segments = path.split("/");
  if (segments.includes("..")) return null;
  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  return normalized && !normalized.startsWith("-") ? normalized : null;
}

/** The same parser is used before HTML sanitization and when handling a click. */
export function parseAgentMarkdownFileLink(rawHref: string): ParsedAgentMarkdownFileLink {
  const href = rawHref.trim();
  if (!href || /^(?:https?:|mailto:|\/\/|#)/i.test(href)) return { kind: "other" };
  if (/^(?:[a-z]:|file:)/i.test(href)) return { kind: "invalid", reason: "invalid_path" };

  let path = href;
  let line: number | undefined;
  let column: number | undefined;
  const hashIndex = path.indexOf("#");
  if (hashIndex !== -1) {
    const location = /^L(\d+)(?:-L(\d+))?$/.exec(path.slice(hashIndex + 1));
    const first = location ? positiveInteger(location[1]) : null;
    const last = location?.[2] ? positiveInteger(location[2]) : first;
    if (first === null || last === null || last < first) return { kind: "invalid", reason: "invalid_position" };
    line = first;
    path = path.slice(0, hashIndex);
  }

  const colonLocation = /:(\d+)(?::(\d+))?$/.exec(path);
  if (colonLocation) {
    const first = positiveInteger(colonLocation[1]);
    const col = colonLocation[2] ? positiveInteger(colonLocation[2]) : undefined;
    if (line !== undefined || first === null || col === null) return { kind: "invalid", reason: "invalid_position" };
    line = first;
    column = col;
    path = path.slice(0, colonLocation.index);
  }
  if (path.includes(":")) {
    return { kind: "invalid", reason: /:\s*[-+\d]/.test(path) ? "invalid_position" : "invalid_path" };
  }
  // Queries are not file locations. Encoded punctuation remains part of the filename.
  if (path.includes("?")) return { kind: "invalid", reason: "invalid_path" };
  try {
    path = decodeURIComponent(path);
  } catch {
    return { kind: "invalid", reason: "invalid_path" };
  }
  const normalized = normalizeRelativePath(path);
  if (!normalized) return { kind: "invalid", reason: "invalid_path" };
  return { kind: "file", link: { path: normalized, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) } };
}

/** A safe relative href keeps e.g. README.md:12 from being treated as a URL scheme. */
export function agentMarkdownFileHref(link: AgentMarkdownFileLink) {
  return `./${link.path.split("/").map(encodeURIComponent).join("/")}`;
}

export type ResolvedAgentMarkdownFileLink =
  | { kind: "file"; path: string }
  | { kind: "unresolved" }
  | { kind: "failed" };

type ProbeResult = { kind: "file"; path: string } | { kind: "missing" } | { kind: "failed" };

/** Stat every repository candidate before deciding uniqueness; size/content are the editor's concern. */
export async function resolveAgentMarkdownFileLink(params: {
  path: string;
  repoDirNames: string[];
  stat: (path: string) => Promise<FileStatResponse>;
}): Promise<ResolvedAgentMarkdownFileLink> {
  const probe = async (path: string): Promise<ProbeResult> => {
    try {
      const result = await params.stat(path);
      if (result.ok && result.kind === "file") {
        const normalized = normalizeRelativePath(result.normalizedPath || path);
        return normalized ? { kind: "file", path: normalized } : { kind: "failed" };
      }
      if (!result.ok && (result.reason === "missing" || result.reason === "not_file")) return { kind: "missing" };
      return { kind: "failed" };
    } catch {
      // Request, permission and safety failures must never masquerade as missing files.
      return { kind: "failed" };
    }
  };

  const root = await probe(params.path);
  if (root.kind !== "missing") return root;
  const results = await Promise.all([...new Set(params.repoDirNames)].map((dirName) => probe(`${dirName}/${params.path}`)));
  if (results.some((result) => result.kind === "failed")) return { kind: "failed" };
  const files = results.filter((result): result is Extract<ProbeResult, { kind: "file" }> => result.kind === "file");
  return files.length === 1 ? files[0] : { kind: "unresolved" };
}
