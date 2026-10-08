import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionProfile } from "../../apiClient.js";
import { chatEndpointDigest } from "./endpoint-identity.js";

test("chat endpoint digest is stable, opaque, and separates implicit defaults and sensitive URLs", () => {
  const profile = (baseURL?: string) => ({ provider: { options: { baseURL } } }) as ExecutionProfile;
  const implicit = chatEndpointDigest(profile());
  const explicit = chatEndpointDigest(profile("https://api.moonshot.ai/v1"));
  const sensitive = "https://private-user:private-password@api.example.test/v1?private-query=abc#private-fragment";
  const first = chatEndpointDigest(profile(sensitive));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, chatEndpointDigest(profile(sensitive)));
  assert.notEqual(implicit, explicit);
  assert.notEqual(first, chatEndpointDigest(profile("https://api.example.test/v1")));
  assert.notEqual(first, chatEndpointDigest(profile(sensitive + "-changed")));
  for (const secret of ["private-user", "private-password", "private-query", "private-fragment", sensitive]) {
    assert.equal(first.includes(secret), false);
  }
});
