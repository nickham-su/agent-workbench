import fs from "node:fs/promises";

export async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(p: string) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function rmrf(p: string) {
  await fs.rm(p, { recursive: true, force: true });
}

export async function readFileUtf8Truncated(
  filePath: string,
  maxBytes: number
): Promise<{ content: string; truncated: boolean }> {
  const buf = await fs.readFile(filePath);
  if (buf.byteLength <= maxBytes) {
    return { content: buf.toString("utf-8"), truncated: false };
  }
  return { content: buf.subarray(0, maxBytes).toString("utf-8"), truncated: true };
}

