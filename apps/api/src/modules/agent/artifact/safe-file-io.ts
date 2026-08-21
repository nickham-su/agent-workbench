import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../../../app/errors.js";

/**
 * 受限于已知根目录的文件原语。
 *
 * 这些原语只提供路径 containment、目录创建和 no-follow 文件读写；
 * 调用方仍负责决定具体 artifact 的路径、格式、时机及失败政策。
 */
export async function ensureRealPathUnderRoot(rootAbs: string, targetAbs: string) {
  const rootReal = await fs.realpath(rootAbs);
  const targetReal = await fs.realpath(targetAbs);
  const withSep = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
  if (targetReal !== rootReal && !targetReal.startsWith(withSep)) {
    throw new HttpError(400, "Invalid path");
  }
}

export async function ensureDirSafeUnderRoot(rootAbs: string, dirAbs: string) {
  const rootResolved = path.resolve(rootAbs);
  const dirResolved = path.resolve(dirAbs);
  const rel = path.relative(rootResolved, dirResolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HttpError(400, "Invalid path");
  }

  let current = rootResolved;
  await fs.mkdir(current, { recursive: true });
  await ensureRealPathUnderRoot(rootResolved, current);

  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    const st = await fs.lstat(current).catch(() => null);
    if (!st) {
      try {
        await fs.mkdir(current);
      } catch (err: any) {
        if (!err || err.code !== "EEXIST") throw err;
      }
    } else {
      if (st.isSymbolicLink()) throw new HttpError(400, "Invalid path");
      if (!st.isDirectory()) throw new HttpError(409, "Parent is not a directory");
    }
    await ensureRealPathUnderRoot(rootResolved, current);
  }
}

export async function writeFileNoFollow(fileAbs: string, content: string) {
  const handle = await fs.open(
    fileAbs,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
    0o644
  );
  try {
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export async function readFileNoFollow(fileAbs: string) {
  const handle = await fs.open(fileAbs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}
