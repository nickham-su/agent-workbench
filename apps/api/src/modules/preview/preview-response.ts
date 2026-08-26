import fs from "node:fs";
import type { Readable } from "node:stream";
import type { WorkspacePreviewResourceDescriptor } from "@agent-workbench/shared";

export type PreviewHeaders = Readonly<Record<string, string>>;

export type PreviewHeaderSink = {
  header(name: string, value: string): unknown;
};

export type PreviewRangeResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "range"; start: number; end: number }>
  | Readonly<{ kind: "invalid" }>;

export type PreviewStaticMethodResult =
  | Readonly<{ allowed: true; head: boolean }>
  | Readonly<{ allowed: false; statusCode: 405; headers: PreviewHeaders }>;

export type PreviewStreamFactory = (input: { filePath: string; fd: number; start?: number; end?: number }) => Readable;

export type PreviewClosableFile = {
  readonly fd: number;
  close(): Promise<void>;
};

export type PreviewStreamPlan = Readonly<{
  statusCode: 200 | 206 | 416;
  headers: PreviewHeaders;
  body: Readable | null;
  close(): Promise<void>;
}>;

export const PREVIEW_COMMON_HEADERS: PreviewHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "Cross-Origin-Resource-Policy": "same-origin"
});

export const PREVIEW_COOP_VALUE = "same-origin";

export const PREVIEW_PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "usb=()",
  "serial=()",
  "bluetooth=()",
  "payment=()",
  "midi=()",
  "document-domain=()"
].join(", ");

export const PREVIEW_BOOTSTRAP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'self'",
  "img-src data:",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

export const PREVIEW_WORKSPACE_HTML_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "manifest-src 'none'",
  "sandbox allow-scripts allow-same-origin allow-modals"
].join("; ");

export const PREVIEW_SVG_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "sandbox"
].join("; ");

export const PREVIEW_ERROR_HTML_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox"
].join("; ");

const PREVIEW_UNAVAILABLE_MESSAGE = "预览已失效或不可用，请返回 Agent Workbench 重新打开。";

function mergeHeaders(...sources: PreviewHeaders[]): PreviewHeaders {
  return Object.freeze(Object.assign({}, ...sources));
}

function applyHeaders(sink: PreviewHeaderSink, headers: PreviewHeaders) {
  for (const [name, value] of Object.entries(headers)) sink.header(name, value);
}

export function buildCommonPreviewHeaders(): PreviewHeaders {
  return PREVIEW_COMMON_HEADERS;
}

export function applyCommonPreviewHeaders(sink: PreviewHeaderSink): void {
  applyHeaders(sink, PREVIEW_COMMON_HEADERS);
}

export function buildBootstrapHeaders(): PreviewHeaders {
  return mergeHeaders(PREVIEW_COMMON_HEADERS, {
    "Content-Type": "text/html; charset=utf-8",
    "Cross-Origin-Opener-Policy": PREVIEW_COOP_VALUE,
    "Content-Security-Policy": PREVIEW_BOOTSTRAP_CSP
  });
}

export function applyBootstrapHeaders(sink: PreviewHeaderSink): void {
  applyHeaders(sink, buildBootstrapHeaders());
}

export function buildWorkspaceHtmlHeaders(mime = "text/html; charset=utf-8"): PreviewHeaders {
  return mergeHeaders(PREVIEW_COMMON_HEADERS, {
    "Content-Type": mime,
    "Cross-Origin-Opener-Policy": PREVIEW_COOP_VALUE,
    "Content-Security-Policy": PREVIEW_WORKSPACE_HTML_CSP,
    "Permissions-Policy": PREVIEW_PERMISSIONS_POLICY
  });
}

export function applyWorkspaceHtmlHeaders(sink: PreviewHeaderSink, mime?: string): void {
  applyHeaders(sink, buildWorkspaceHtmlHeaders(mime));
}

export function buildSvgHeaders(): PreviewHeaders {
  return mergeHeaders(PREVIEW_COMMON_HEADERS, {
    "Content-Type": "image/svg+xml",
    "Content-Disposition": "inline",
    "Cross-Origin-Opener-Policy": PREVIEW_COOP_VALUE,
    "Content-Security-Policy": PREVIEW_SVG_CSP
  });
}

export function applySvgHeaders(sink: PreviewHeaderSink): void {
  applyHeaders(sink, buildSvgHeaders());
}

export function buildBinaryResourceHeaders(mime: string): PreviewHeaders {
  return mergeHeaders(PREVIEW_COMMON_HEADERS, { "Content-Type": mime });
}

export function applyBinaryResourceHeaders(sink: PreviewHeaderSink, mime: string): void {
  applyHeaders(sink, buildBinaryResourceHeaders(mime));
}

export function buildPreviewErrorHtmlHeaders(): PreviewHeaders {
  return mergeHeaders(PREVIEW_COMMON_HEADERS, {
    "Content-Type": "text/html; charset=utf-8",
    "Cross-Origin-Opener-Policy": PREVIEW_COOP_VALUE,
    "Content-Security-Policy": PREVIEW_ERROR_HTML_CSP
  });
}

export function applyPreviewErrorHtmlHeaders(sink: PreviewHeaderSink): void {
  applyHeaders(sink, buildPreviewErrorHtmlHeaders());
}

export function buildPreviewFileHeaders(resource: WorkspacePreviewResourceDescriptor): PreviewHeaders {
  if (resource.kind === "html") return buildWorkspaceHtmlHeaders(resource.mime);
  if (resource.extension === ".svg") return buildSvgHeaders();
  return buildBinaryResourceHeaders(resource.mime);
}

/** Produces a static, non-sensitive preview error document without interpolating request data. */
export function buildPreviewErrorHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>预览不可用</title><style>body{margin:2rem;font-family:system-ui,sans-serif;color:#1f2937;background:#fff}main{max-width:36rem}h1{font-size:1.25rem}</style></head><body><main><h1>预览不可用</h1><p>${PREVIEW_UNAVAILABLE_MESSAGE}</p></main></body></html>`;
}

export function getPreviewStaticMethodResult(method: string): PreviewStaticMethodResult {
  if (method === "GET") return { allowed: true, head: false };
  if (method === "HEAD") return { allowed: true, head: true };
  return { allowed: false, statusCode: 405, headers: mergeHeaders(PREVIEW_COMMON_HEADERS, { Allow: "GET, HEAD" }) };
}

/** Parses exactly one RFC bytes range. Callers must only use it for range-enabled media resources. */
export function parseSingleByteRange(raw: string | undefined, size: number): PreviewRangeResult {
  if (raw === undefined) return { kind: "none" };
  if (!Number.isSafeInteger(size) || size < 0 || size === 0) return { kind: "invalid" };

  const value = raw.trim();
  if (!value.startsWith("bytes=") || value.includes(",")) return { kind: "invalid" };
  const spec = value.slice("bytes=".length);
  if (!spec) return { kind: "invalid" };

  const parseDecimal = (candidate: string): number | null => {
    if (!/^\d+$/.test(candidate)) return null;
    const number = Number(candidate);
    return Number.isSafeInteger(number) ? number : null;
  };

  if (spec.startsWith("-")) {
    const suffixLength = parseDecimal(spec.slice(1));
    if (suffixLength === null || suffixLength <= 0) return { kind: "invalid" };
    return { kind: "range", start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const separator = spec.indexOf("-");
  if (separator < 0 || spec.indexOf("-", separator + 1) !== -1) return { kind: "invalid" };
  const start = parseDecimal(spec.slice(0, separator));
  const rawEnd = spec.slice(separator + 1);
  if (start === null || start >= size) return { kind: "invalid" };
  if (!rawEnd) return { kind: "range", start, end: size - 1 };

  const end = parseDecimal(rawEnd);
  if (end === null || end < start) return { kind: "invalid" };
  return { kind: "range", start, end: Math.min(end, size - 1) };
}

function buildRangeHeaders(size: number, range: PreviewRangeResult): PreviewHeaders {
  if (range.kind === "invalid") {
    return Object.freeze({ "Accept-Ranges": "bytes", "Content-Range": `bytes */${size}` });
  }
  if (range.kind === "range") {
    return Object.freeze({
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
      "Content-Length": String(range.end - range.start + 1)
    });
  }
  return Object.freeze({ "Accept-Ranges": "bytes", "Content-Length": String(size) });
}

/**
 * Creates a stream from an already-open descriptor. `autoClose` remains false
 * so the stream plan owns the handle lifetime on success, abort, and failure.
 */
export function createPreviewFileReadStream(input: { filePath: string; fd: number; start?: number; end?: number }): Readable {
  return fs.createReadStream(input.filePath, {
    fd: input.fd,
    autoClose: false,
    start: input.start,
    end: input.end
  });
}

/**
 * Builds a route-agnostic response plan for an already-open, validated file.
 * The route sends `body` when present and must call `close()` if it aborts before stream completion.
 */
export async function createPreviewStreamPlan(input: {
  method: "GET" | "HEAD";
  rangeHeader?: string;
  resource: WorkspacePreviewResourceDescriptor;
  filePath: string;
  size: number;
  handle: PreviewClosableFile;
  createReadStream: PreviewStreamFactory;
}): Promise<PreviewStreamPlan> {
  const baseHeaders = buildPreviewFileHeaders(input.resource);
  const range = input.resource.range ? parseSingleByteRange(input.rangeHeader, input.size) : { kind: "none" } as const;
  const rangeHeaders = input.resource.range
    ? buildRangeHeaders(input.size, range)
    : Object.freeze({ "Content-Length": String(input.size) });
  const headers = mergeHeaders(baseHeaders, rangeHeaders);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await input.handle.close();
  };

  if (range.kind === "invalid") {
    await close();
    return { statusCode: 416, headers, body: null, close };
  }
  if (input.method === "HEAD") {
    await close();
    return { statusCode: range.kind === "range" ? 206 : 200, headers, body: null, close };
  }

  try {
    const body = range.kind === "range"
      ? input.createReadStream({ filePath: input.filePath, fd: input.handle.fd, start: range.start, end: range.end })
      : input.createReadStream({ filePath: input.filePath, fd: input.handle.fd });
    body.once("end", () => { void close().catch(() => undefined); });
    body.once("error", () => { void close().catch(() => undefined); });
    body.once("close", () => { void close().catch(() => undefined); });
    return { statusCode: range.kind === "range" ? 206 : 200, headers, body, close };
  } catch (error) {
    await close();
    throw error;
  }
}
