import assert from "node:assert/strict";
import { test } from "node:test";
import { isMainPreviewReservedPathname } from "./webUiPaths.js";

test("main preview reserved prefixes match exact paths and descendants only", () => {
  for (const pathname of ["/s", "/s/a", "/__awb", "/__awb/bootstrap", "/preview", "/preview/demo"]) {
    assert.equal(isMainPreviewReservedPathname(pathname), true, pathname);
  }
  for (const pathname of ["/settings", "/__awb2", "/__awb2/x", "/previewer", "/previewer/x", "/sibling"]) {
    assert.equal(isMainPreviewReservedPathname(pathname), false, pathname);
  }
});
