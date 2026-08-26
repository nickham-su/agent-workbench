import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSameOriginBrowserRequest, PreviewBrowserRequestForbiddenError } from "./preview-security.js";

test("same-origin browser guard fails closed unless Sec-Fetch-Site is exactly same-origin", () => {
  for (const secFetchSite of [undefined, "", "none", "same-site", "cross-site", "Same-Origin"]) {
    assert.throws(
      () => assertSameOriginBrowserRequest({ secFetchSite }),
      PreviewBrowserRequestForbiddenError,
      String(secFetchSite)
    );
  }
  assert.doesNotThrow(() => assertSameOriginBrowserRequest({ secFetchSite: "same-origin" }));
});

test("same-origin browser guard validates a supplied Origin only against its expected effective origin", () => {
  const expectedOrigin = "https://preview.example.test";
  assert.doesNotThrow(() => assertSameOriginBrowserRequest({ secFetchSite: "same-origin", expectedOrigin }));
  assert.doesNotThrow(() => assertSameOriginBrowserRequest({ secFetchSite: "same-origin", expectedOrigin, origin: "https://preview.example.test/path" }));

  for (const origin of ["https://other.example.test", "not a url", "http://preview.example.test"]) {
    assert.throws(
      () => assertSameOriginBrowserRequest({ secFetchSite: "same-origin", expectedOrigin, origin }),
      PreviewBrowserRequestForbiddenError,
      origin
    );
  }
  assert.throws(
    () => assertSameOriginBrowserRequest({ secFetchSite: "same-origin", expectedOrigin: "not a url", origin: expectedOrigin }),
    PreviewBrowserRequestForbiddenError
  );
});
