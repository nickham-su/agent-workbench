import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { loadWorkerEnv } from "./env.js";

const baseEnv = {
  AWB_AGENT_INTERNAL_TOKEN: "TOKEN"
};

test("worker data directory follows the API default and resolves explicit values", () => {
  assert.equal(loadWorkerEnv(baseEnv).dataDir, path.resolve(".data"));
  assert.equal(
    loadWorkerEnv({ ...baseEnv, AWB_DATA_DIR: "  .tmp-worker-data  " }).dataDir,
    path.resolve(".tmp-worker-data")
  );
  assert.equal(loadWorkerEnv({ ...baseEnv, AWB_DATA_DIR: "   " }).dataDir, path.resolve(".data"));
});

test("worker response validation defaults to strict", () => {
  assert.equal(loadWorkerEnv(baseEnv).responseValidation, "strict");
});

test("worker response validation normalizes warn", () => {
  assert.equal(
    loadWorkerEnv({ ...baseEnv, AWB_INTERNAL_RPC_RESPONSE_VALIDATION: "  WaRn " }).responseValidation,
    "warn"
  );
});

test("worker response validation rejects unsupported values", () => {
  assert.throws(
    () => loadWorkerEnv({ ...baseEnv, AWB_INTERNAL_RPC_RESPONSE_VALIDATION: "relaxed" }),
    /Invalid AWB_INTERNAL_RPC_RESPONSE_VALIDATION: relaxed\. Expected "strict" or "warn"\./
  );
});
