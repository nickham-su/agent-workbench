import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { CliError, withErrorDetails } from "./errors.js";
import type { TokenInput } from "./token-input.js";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
export interface InputOptions { prompt?: string; promptFile?: string; stdin?: boolean; image?: string[]; }
export interface PreparedImage { bytes: Buffer; mediaType: "image/png" | "image/jpeg" | "image/webp"; filename: string; }
export interface PreparedInput { text: string; images: PreparedImage[]; }
function invalid(message: string): CliError { return new CliError(2, message, { phase: "input", effect: "not_sent" }); }

/** Open non-blocking first: a FIFO/device or a replacement between stat/open must not hang. */
async function readFileBounded(path: string, maximum: number): Promise<Buffer> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw invalid("输入必须是大小合规的可读普通文件。");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximum - size + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return Buffer.concat(chunks, size);
      size += bytesRead;
      if (size > maximum) throw invalid("输入文件超过允许的字节上限。");
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw invalid("无法读取输入文件；请检查文件类型、大小和权限。");
  } finally { await file?.close().catch(() => {}); }
}
function decodeText(bytes: Buffer): string {
  try {
    // Preserve BOMs while decoding, then remove exactly one leading BOM.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch { throw invalid("提示词必须是有效 UTF-8 文本，不接受非法编码。"); }
}
async function readPromptStdin(stdin: TokenInput): Promise<Buffer> {
  if (stdin.isTTY) throw invalid("--stdin 需要非交互输入，请使用 --prompt 或管道。");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_TEXT_BYTES) throw invalid("标准输入文本超过 1 MiB。");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw invalid("无法完整读取标准输入提示词。");
  }
}
export function detectImage(bytes: Buffer): PreparedImage["mediaType"] {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw invalid("图片必须具有 PNG、JPEG 或 WebP 字节签名，且不能为空。");
}
export async function prepareInput(options: InputOptions, stdin: TokenInput): Promise<PreparedInput> {
  try {
    if ([options.prompt !== undefined, options.promptFile !== undefined, Boolean(options.stdin)].filter(Boolean).length > 1) throw invalid("--prompt、--prompt-file 和 --stdin 最多选择一个。");
    const paths = options.image ?? [];
    if (paths.length > 4) throw invalid("每次最多发送 4 张图片。");
    let text = "";
    if (options.prompt !== undefined) {
      const bytes = Buffer.from(options.prompt, "utf8");
      if (bytes.toString("utf8") !== options.prompt || bytes.length > MAX_TEXT_BYTES) throw invalid("提示词必须是有效 UTF-8，且不超过 1 MiB。");
      text = decodeText(bytes);
    } else if (options.promptFile !== undefined) text = decodeText(await readFileBounded(options.promptFile, MAX_TEXT_BYTES));
    else if (options.stdin) text = decodeText(await readPromptStdin(stdin));
    const images: PreparedImage[] = [];
    let total = 0;
    for (const path of paths) {
      const bytes = await readFileBounded(path, MAX_IMAGE_BYTES);
      total += bytes.length;
      if (total > MAX_TOTAL_IMAGE_BYTES) throw invalid("图片总大小不得超过 20 MiB。");
      const mediaType = detectImage(bytes);
      // Only a basename is transmitted; control characters cannot become multipart metadata.
      const filename = basename(path).replace(/[\u0000-\u001f\u007f-\u009f]/g, "_") || "image";
      images.push({ bytes, mediaType, filename });
    }
    if (!text.trim() && images.length === 0) throw invalid("至少提供非空白提示词或一张有效图片。");
    return { text, images };
  } catch (error) { throw withErrorDetails(error, { phase: "input", effect: "not_sent" }); }
}

export interface SendPayload { workspaceId: string; clientRequestId: string; agentId: string; text: string; }
export function preparePayload(input: PreparedInput, workspaceId: string, agentId: string, clientRequestId: string): SendPayload {
  const payload = { workspaceId, clientRequestId, agentId, text: input.text };
  const maximum = input.images.length ? MAX_PAYLOAD_BYTES : MAX_TEXT_BYTES;
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maximum) throw invalid(input.images.length ? "multipart payload 超过 64 KiB。" : "JSON 请求体超过 1 MiB。");
  return payload;
}
export function imageFormData(input: PreparedInput, payload: SendPayload): FormData {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (const image of input.images) form.append("images", new Blob([new Uint8Array(image.bytes)], { type: image.mediaType }), image.filename);
  return form;
}
