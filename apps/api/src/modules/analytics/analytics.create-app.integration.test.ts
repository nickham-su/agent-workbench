import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentTestFixture } from "../agent/testkit/agent-testkit.js";

test("createApp registers the Dashboard query endpoint and its OpenAPI contract", async (t) => {
  const fixture = await createAgentTestFixture({ withApp: true, dataDirPrefix: "analytics-create-app-" });
  t.after(() => fixture.dispose());
  const app = fixture.app;
  assert.ok(app);

  const custom = await app.inject({
    method: "POST",
    url: "/api/analytics/dashboard/query",
    payload: { rangeKind: "custom", timezone: "UTC", from: 1, to: 2 }
  });
  assert.equal(custom.statusCode, 503);
  assert.deepEqual(custom.json(), { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE" } });

  const document = (app as any).swagger();
  const route = document.paths["/api/analytics/dashboard/query"];
  assert.ok(route);
  assert.deepEqual(Object.keys(route), ["post"]);
  assert.deepEqual(Object.keys(route.post.responses).sort(), ["200", "400", "503"]);
});
