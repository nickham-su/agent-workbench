import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";

export type ReadableTopLevelSkillNode = {
  entryName: string;
  text: string;
};

export async function scanReadableTopLevelSkills(params: {
  rootPath: string;
  logger: FastifyBaseLogger;
  logMessage: string;
}): Promise<ReadableTopLevelSkillNode[]> {
  const rootEntries = await fs.readdir(params.rootPath, { withFileTypes: true }).catch((err: any) => {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return [] as Awaited<ReturnType<typeof fs.readdir>>;
    throw err;
  });

  const items: ReadableTopLevelSkillNode[] = [];
  for (const entry of rootEntries.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const entryName = String(entry.name || "");
    const skillDir = path.join(params.rootPath, entryName);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    const skillStat = await fs.lstat(skillMdPath).catch((err: any) => {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return null;
      throw err;
    });
    if (!skillStat || !skillStat.isFile() || skillStat.isSymbolicLink()) continue;
    let text = "";
    try {
      const bytes = await fs.readFile(skillMdPath);
      if (bytes.includes(0x00)) continue;
      text = bytes.toString("utf8");
    } catch (err) {
      params.logger.warn({ err, skillMdPath }, params.logMessage);
      continue;
    }
    items.push({ entryName, text });
  }
  return items;
}

export function parseSkillFrontmatter(text: string): { name: string; description: string } {
  const raw = String(text || "");
  if (!raw.startsWith("---\n")) return { name: "", description: "" };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { name: "", description: "" };
  const yaml = raw.slice(4, end);
  let name = "";
  let description = "";
  for (const line of yaml.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key === "name" && !name) name = value;
    if (key === "description" && !description) description = value;
  }
  return { name, description };
}
