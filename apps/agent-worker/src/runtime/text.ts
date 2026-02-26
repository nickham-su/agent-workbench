import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

type TextPayload = {
  preview: string;
  truncated: boolean;
  artifactPath: string | null;
  bytes: number;
  lines: number;
};

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

function workspaceAgentArtifactsRoot(workspacePath: string) {
  return path.join(workspacePath, ".agent-workbench", "internal", "artifacts");
}

function countLines(text: string) {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function newSortableId(prefix: string) {
  const now = Date.now().toString(36).padStart(10, "0");
  const random = randomBytes(6).toString("hex");
  return `${prefix}_${now}${random}`;
}

function truncateText(text: string, maxLines: number, maxBytes: number) {
  const bytes = Buffer.byteLength(text, "utf8");
  const lines = countLines(text);
  if (bytes <= maxBytes && lines <= maxLines) {
    return { preview: text, truncated: false, bytes, lines };
  }

  const chunks: string[] = [];
  let remainingBytes = maxBytes;
  let lineCount = 0;
  for (const line of text.split("\n")) {
    if (lineCount >= maxLines) break;
    const withBreak = lineCount === 0 ? line : `\n${line}`;
    const chunkBytes = Buffer.byteLength(withBreak, "utf8");
    if (chunkBytes > remainingBytes) break;
    chunks.push(withBreak);
    remainingBytes -= chunkBytes;
    lineCount += 1;
  }

  const preview = `${chunks.join("")}\n... [truncated]`;
  return { preview, truncated: true, bytes, lines };
}

async function writeArtifact(workspacePath: string, text: string) {
  const artifactsDir = workspaceAgentArtifactsRoot(workspacePath);
  await fs.mkdir(artifactsDir, { recursive: true });
  const fileName = `${newSortableId("artifact")}.txt`;
  const tempPath = path.join(artifactsDir, `${fileName}.tmp`);
  const finalPath = path.join(artifactsDir, fileName);
  await fs.writeFile(tempPath, text, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, finalPath);
  return path.relative(workspacePath, finalPath).replace(/\\/g, "/");
}

export async function buildTextPayload(params: {
  workspacePath: string;
  text: string;
  maxLines?: number;
  maxBytes?: number;
}): Promise<TextPayload> {
  const maxLines = params.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES;
  const reduced = truncateText(params.text, maxLines, maxBytes);
  if (!reduced.truncated) {
    return {
      preview: reduced.preview,
      truncated: false,
      artifactPath: null,
      bytes: reduced.bytes,
      lines: reduced.lines
    };
  }

  const artifactPath = await writeArtifact(params.workspacePath, params.text);
  return {
    preview: reduced.preview,
    truncated: true,
    artifactPath,
    bytes: reduced.bytes,
    lines: reduced.lines
  };
}
