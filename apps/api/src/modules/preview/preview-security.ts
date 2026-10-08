export class PreviewBrowserRequestForbiddenError extends Error {
  readonly code = "PREVIEW_REQUEST_FORBIDDEN";

  constructor(message = "Preview request must originate from the same site") {
    super(message);
  }
}

export type SameOriginBrowserRequest = {
  secFetchSite: string | undefined;
  origin?: string | undefined;
  expectedOrigin?: string | undefined;
};

function effectiveOrigin(raw: string) {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function assertExpectedOrigin(params: SameOriginBrowserRequest): void {
  if (!params.expectedOrigin || params.origin === undefined || params.origin === "") return;

  const expectedOrigin = effectiveOrigin(params.expectedOrigin);
  const origin = effectiveOrigin(params.origin);
  if (!expectedOrigin || !origin || origin !== expectedOrigin) {
    throw new PreviewBrowserRequestForbiddenError("Preview request origin is not allowed");
  }
}

/**
 * Enforces the browser-only Fetch Metadata boundary shared by future open and
 * exchange routes. It intentionally accepts plain values rather than a
 * framework request object and never inspects forwarded headers.
 */
export function assertSameOriginBrowserRequest(params: SameOriginBrowserRequest): void {
  if (params.secFetchSite !== "same-origin") {
    throw new PreviewBrowserRequestForbiddenError();
  }
  assertExpectedOrigin(params);
}

/**
 * Allows preview exchange clients that omit Fetch Metadata while preserving the
 * preview origin boundary and rejecting every explicit non-same-origin value.
 */
export function assertPreviewExchangeBrowserRequest(params: SameOriginBrowserRequest): void {
  if (params.secFetchSite !== undefined && params.secFetchSite !== "" && params.secFetchSite !== "same-origin") {
    throw new PreviewBrowserRequestForbiddenError();
  }
  assertExpectedOrigin(params);
}

/** Allows clients without Fetch Metadata while rejecting explicitly cross-site preview opens. */
export function assertPreviewOpenBrowserRequest(secFetchSite: string | undefined): void {
  if (secFetchSite === "cross-site") {
    throw new PreviewBrowserRequestForbiddenError();
  }
}
