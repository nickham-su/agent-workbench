import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEnv } from "./env.js";

test("internal RPC response validation defaults to strict and accepts warn", () => {
  assert.equal(loadEnv({ AWB_DATA_DIR: ".tmp-env-default" }).agentWorkerResponseValidation, "strict");
  assert.equal(
    loadEnv({
      AWB_DATA_DIR: ".tmp-env-warn",
      AWB_INTERNAL_RPC_RESPONSE_VALIDATION: "warn"
    }).agentWorkerResponseValidation,
    "warn"
  );
});

test("internal RPC response validation rejects unsupported values", () => {
  assert.throws(
    () => loadEnv({
      AWB_DATA_DIR: ".tmp-env-invalid",
      AWB_INTERNAL_RPC_RESPONSE_VALIDATION: "relaxed"
    }),
    /Invalid AWB_INTERNAL_RPC_RESPONSE_VALIDATION: relaxed\. Expected "strict" or "warn"\./
  );
});
