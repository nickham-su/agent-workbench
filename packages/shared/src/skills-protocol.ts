export type ParsedSkillFrontmatter = {
  name: string;
  description: string;
  body: string;
};

export type ParsedStableSkillIdentifier =
  | { skill: string; namespace: "builtin"; skillDir: string }
  | { skill: string; namespace: "workspace"; rootDir: string; skillDir: string }
  | { skill: string; namespace: "repo"; repoId: string; rootDir: string; skillDir: string };

const ASCII_SPACE_OR_TAB_AT_EDGES = /^[\u0020\u0009]+|[\u0020\u0009]+$/g;
const FORBIDDEN_SKILL_SEGMENT_CHARS = /[\\`\u2028\u2029]|\p{Cc}|\p{Cf}/u;
const EDGE_UNICODE_WHITESPACE = /^\p{White_Space}|\p{White_Space}$/u;

export const trimAsciiSpaceTab = (value: string): string => value.replace(ASCII_SPACE_OR_TAB_AT_EDGES, "");

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

export function isValidSkillPathSegment(segment: string): boolean {
  return Boolean(
    segment
      && segment !== "."
      && segment !== ".."
      && isWellFormedUnicode(segment)
      && !segment.includes("/")
      && !FORBIDDEN_SKILL_SEGMENT_CHARS.test(segment)
      && !EDGE_UNICODE_WHITESPACE.test(segment)
  );
}

export function isValidSkillRelativePath(value: string): boolean {
  if (!isWellFormedUnicode(value) || !value || value.startsWith("/") || value.includes("\\")) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;
  const segments = value.split("/");
  return segments.every(isValidSkillPathSegment);
}

export function parseStableSkillIdentifier(raw: unknown):
  | { kind: "required" }
  | { kind: "invalid" }
  | { kind: "valid"; value: ParsedStableSkillIdentifier } {
  if (typeof raw !== "string") return { kind: "invalid" };
  const skill = trimAsciiSpaceTab(raw);
  if (!skill) return { kind: "required" };
  if (!isWellFormedUnicode(skill) || skill.includes("\\") || skill.startsWith("/") || /^[A-Za-z]:\//.test(skill)) {
    return { kind: "invalid" };
  }
  const segments = skill.split("/");
  if (!segments.every(isValidSkillPathSegment)) return { kind: "invalid" };

  if (segments[0] === "builtin" && segments.length === 2) {
    return { kind: "valid", value: { skill, namespace: "builtin", skillDir: segments[1]! } };
  }
  if (segments[0] === "workspace" && segments.length === 3) {
    return { kind: "valid", value: { skill, namespace: "workspace", rootDir: segments[1]!, skillDir: segments[2]! } };
  }
  if (segments[0] === "repo" && segments.length === 4) {
    return {
      kind: "valid",
      value: { skill, namespace: "repo", repoId: segments[1]!, rootDir: segments[2]!, skillDir: segments[3]! }
    };
  }
  return { kind: "invalid" };
}

export function parseSkillFrontmatter(text: string): ParsedSkillFrontmatter {
  const raw = String(text ?? "");
  const firstLineEnd = raw.startsWith("---\r\n") ? 5 : raw.startsWith("---\n") ? 4 : -1;
  if (firstLineEnd < 0) return { name: "", description: "", body: raw };

  let cursor = firstLineEnd;
  let boundaryStart = -1;
  let blockEnd = -1;
  while (cursor <= raw.length) {
    const lf = raw.indexOf("\n", cursor);
    if (lf < 0) {
      if (raw.slice(cursor) === "---") {
        boundaryStart = cursor;
        blockEnd = raw.length;
      }
      break;
    }
    const lineEnd = lf > cursor && raw[lf - 1] === "\r" ? lf - 1 : lf;
    if (raw.slice(cursor, lineEnd) === "---") {
      boundaryStart = cursor;
      blockEnd = lf + 1;
      break;
    }
    cursor = lf + 1;
  }
  if (boundaryStart < 0 || blockEnd < 0) return { name: "", description: "", body: raw };

  const yaml = raw.slice(firstLineEnd, boundaryStart);
  let name = "";
  let description = "";
  for (const line of yaml.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    if (key === "name" && !name && value) name = value;
    if (key === "description" && !description && value) description = value;
  }
  return { name, description, body: raw.slice(blockEnd) };
}
