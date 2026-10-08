import { CliError } from "./errors.js";

export function normalizeOrigin(raw: string): string {
  // Check the supplied spelling as well as WHATWG's normalized result. The URL
  // parser otherwise erases empty query/hash delimiters and dot-path segments.
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/i.test(raw)) {
    throw new CliError(2, "--url 必须是 HTTP(S) 服务 origin，不支持子路径、查询或片段。");
  }
  const authority = raw.replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (authority.includes("@")) {
    throw new CliError(2, "--url 不允许包含用户口令。");
  }
  try {
    const url = new URL(raw);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.origin === "null") {
      throw new Error("Invalid origin");
    }
    return url.origin;
  } catch {
    throw new CliError(2, "--url 不是有效的 HTTP(S) 服务 origin。");
  }
}
