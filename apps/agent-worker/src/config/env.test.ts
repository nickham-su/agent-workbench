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

test("worker internal RPC timeout configuration uses parser-owned defaults", () => {
  const env = loadWorkerEnv(baseEnv);
  assert.equal(env.internalRpcTimeoutMs, 15_000);
});

test("worker internal RPC timeout configuration reads explicit positive integers", () => {
  const env = loadWorkerEnv({
    ...baseEnv,
    AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS: " 250 "
  });
  assert.equal(env.internalRpcTimeoutMs, 250);
});

test("worker internal RPC timeout configuration treats empty strings as unset", () => {
  const env = loadWorkerEnv({
    ...baseEnv,
    AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS: "  "
  });
  assert.equal(env.internalRpcTimeoutMs, 15_000);
});

test("worker internal RPC timeout configuration rejects non-positive and non-numeric values", () => {
  const cases = [
    ["AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS", "0"],
    ["AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS", "-1"],
    ["AWB_AGENT_INTERNAL_RPC_TIMEOUT_MS", "12ms"]
  ] as const;

  for (const [name, value] of cases) {
    assert.throws(() => loadWorkerEnv({ ...baseEnv, [name]: value }), new RegExp(`invalid ${name}:`));
  }
});
