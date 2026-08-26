export type WorkspacePreviewResourceKind =
  | "html"
  | "css"
  | "script"
  | "image"
  | "audio"
  | "video"
  | "font";

export type WorkspacePreviewResourceDescriptor = {
  extension: string;
  mime: string;
  kind: WorkspacePreviewResourceKind;
  entry: boolean;
  range: boolean;
};

function resource(
  extension: string,
  mime: string,
  kind: WorkspacePreviewResourceKind,
  entry: boolean,
  range: boolean
): WorkspacePreviewResourceDescriptor {
  return { extension, mime, kind, entry, range };
}

/**
 * 唯一的 workspace 静态预览资源目录。
 *
 * 键必须是 ASCII 小写扩展名；调用方不得自行维护额外白名单或 MIME 映射。
 */
export const WORKSPACE_PREVIEW_RESOURCES: Readonly<Record<string, WorkspacePreviewResourceDescriptor>> = Object.freeze({
  ".html": resource(".html", "text/html; charset=utf-8", "html", true, false),
  ".htm": resource(".htm", "text/html; charset=utf-8", "html", true, false),
  ".css": resource(".css", "text/css; charset=utf-8", "css", false, false),
  ".js": resource(".js", "text/javascript; charset=utf-8", "script", false, false),
  ".mjs": resource(".mjs", "text/javascript; charset=utf-8", "script", false, false),
  ".png": resource(".png", "image/png", "image", true, false),
  ".jpg": resource(".jpg", "image/jpeg", "image", true, false),
  ".jpeg": resource(".jpeg", "image/jpeg", "image", true, false),
  ".gif": resource(".gif", "image/gif", "image", true, false),
  ".webp": resource(".webp", "image/webp", "image", true, false),
  ".avif": resource(".avif", "image/avif", "image", true, false),
  ".bmp": resource(".bmp", "image/bmp", "image", true, false),
  ".ico": resource(".ico", "image/x-icon", "image", true, false),
  ".svg": resource(".svg", "image/svg+xml", "image", true, false),
  ".mp3": resource(".mp3", "audio/mpeg", "audio", true, true),
  ".wav": resource(".wav", "audio/wav", "audio", true, true),
  ".ogg": resource(".ogg", "audio/ogg", "audio", true, true),
  ".m4a": resource(".m4a", "audio/mp4", "audio", true, true),
  ".aac": resource(".aac", "audio/aac", "audio", true, true),
  ".flac": resource(".flac", "audio/flac", "audio", true, true),
  ".mp4": resource(".mp4", "video/mp4", "video", true, true),
  ".webm": resource(".webm", "video/webm", "video", true, true),
  ".ogv": resource(".ogv", "video/ogg", "video", true, true),
  ".mov": resource(".mov", "video/quicktime", "video", true, true),
  ".woff": resource(".woff", "font/woff", "font", false, false),
  ".woff2": resource(".woff2", "font/woff2", "font", false, false),
  ".ttf": resource(".ttf", "font/ttf", "font", false, false),
  ".otf": resource(".otf", "font/otf", "font", false, false)
});

/**
 * 返回文件 basename 最后一个扩展名对应的预览资源定义。
 * query 与 fragment 不是文件系统路径的一部分，传入时必须由调用方先拒绝。
 */
export function getWorkspacePreviewResourceDescriptor(filePath: string): WorkspacePreviewResourceDescriptor | null {
  if (!filePath || filePath.includes("?") || filePath.includes("#")) return null;

  const basenameStart = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1;
  const basename = filePath.slice(basenameStart);
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return null;

  const extension = basename.slice(dotIndex).toLowerCase();
  return WORKSPACE_PREVIEW_RESOURCES[extension] ?? null;
}

export function isWorkspacePreviewEntryPath(filePath: string): boolean {
  return getWorkspacePreviewResourceDescriptor(filePath)?.entry === true;
}
