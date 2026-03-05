import type { ToolPromptProjector } from "./types.js";

const WRITE_CONTENT_PREVIEW_MAX_CHARS = 280;

function toNonNegativeInt(raw: unknown) {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export const writeToolPromptProjector: ToolPromptProjector = {
  projectCallInput(args) {
    const filePath = typeof args.filePath === "string" ? args.filePath : "";
    if (typeof args.content === "string") {
      const content = args.content;
      const contentPreview = content.slice(0, WRITE_CONTENT_PREVIEW_MAX_CHARS);
      return {
        ...(filePath ? { filePath } : {}),
        contentBytes: Buffer.byteLength(content, "utf8"),
        ...(contentPreview ? { contentPreview } : {}),
        ...(contentPreview.length < content.length ? { contentTruncated: true } : {})
      };
    }

    const contentPreview = typeof args.contentPreview === "string" ? args.contentPreview : "";
    const contentBytes = toNonNegativeInt(args.contentBytes ?? Buffer.byteLength(contentPreview, "utf8"));
    const contentTruncated = args.contentTruncated === true;
    return {
      ...(filePath ? { filePath } : {}),
      contentBytes,
      ...(contentPreview ? { contentPreview } : {}),
      ...(contentTruncated ? { contentTruncated: true } : {})
    };
  },
  projectResult(result) {
    return result;
  }
};
