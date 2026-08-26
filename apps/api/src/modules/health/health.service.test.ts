import assert from "node:assert/strict";
import { test } from "node:test";
import { getHealth } from "./health.service.js";

test("health reports preview as disabled before the preview runtime is introduced", () => {
  const result = getHealth(
    { authToken: null, version: "test" } as any,
    { headers: {} }
  );

  assert.equal(result.previewEnabled, false);
});

test("health exposes the actual enabled preview capability without preview configuration", () => {
  const result = getHealth(
    { authToken: null, version: "test", preview: { enabled: true, runtime: {} } } as any,
    { headers: {} }
  );

  assert.equal(result.previewEnabled, true);
});
