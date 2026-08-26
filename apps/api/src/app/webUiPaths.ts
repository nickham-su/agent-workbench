const MAIN_PREVIEW_RESERVED_PREFIXES = ["/s", "/__awb", "/preview"] as const;

/** Paths owned by the isolated preview origin and never eligible for the main SPA fallback. */
export function isMainPreviewReservedPathname(pathname: string) {
  return MAIN_PREVIEW_RESERVED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
