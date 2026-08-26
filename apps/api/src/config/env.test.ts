import assert from "node:assert/strict";
import { test } from "node:test";
import { loadEnv } from "./env.js";

test("internal RPC response validation defaults to strict and accepts warn", () => {
  assert.equal(loadEnv({ AWB_DATA_DIR: ".tmp-env-default" }).agentWorkerResponseValidation, "strict");
  assert.equal(
    loadEnv({
      AWB_DATA_DIR: ".tmp-env-warn",
      AWB_INTERNAL_RPC_RESPONSE_VALIDATION: "  WaRn "
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

test("preview configuration stays disabled without validating preview-only values", () => {
  const env = loadEnv({
    AWB_DATA_DIR: ".tmp-env-preview-disabled",
    AWB_PREVIEW_ORIGIN: "not a url",
    AWB_PREVIEW_HOST: "invalid host",
    AWB_PREVIEW_PORT: "not-a-port",
    AWB_PREVIEW_SESSION_TTL_SECONDS: "not-a-ttl"
  });

  assert.deepEqual(env.preview, { enabled: false });
});

test("preview configuration accepts the documented enabled defaults and normalizes its origin", () => {
  const env = loadEnv({
    AWB_DATA_DIR: ".tmp-env-preview-defaults",
    AWB_PREVIEW_ENABLED: "yes",
    AWB_PREVIEW_ORIGIN: "https://preview.example.test/"
  });

  assert.equal(env.preview.enabled, true);
  if (!env.preview.enabled) throw new Error("preview must be enabled");
  assert.equal(env.preview.origin, "https://preview.example.test");
  assert.equal(env.preview.originUrl.origin, "https://preview.example.test");
  assert.equal(env.preview.host, "127.0.0.1");
  assert.equal(env.preview.port, 4311);
  assert.equal(env.preview.sessionTtlMs, 3_600_000);
  assert.equal(env.preview.bootstrapTtlMs, 60_000);
});

test("preview configuration accepts valid TTL boundaries and rejects invalid port or TTL values", () => {
  for (const seconds of ["60", "3600", "86400"]) {
    const env = loadEnv({
      AWB_DATA_DIR: ".tmp-env-preview-ttl",
      AWB_PREVIEW_ENABLED: "true",
      AWB_PREVIEW_ORIGIN: "https://preview.example.test",
      AWB_PREVIEW_SESSION_TTL_SECONDS: seconds
    });
    assert.equal(env.preview.enabled, true);
  }

  for (const seconds of ["0", "59", "86401", "60.5", "invalid"]) {
    assert.throws(
      () => loadEnv({
        AWB_DATA_DIR: ".tmp-env-preview-invalid-ttl",
        AWB_PREVIEW_ENABLED: "true",
        AWB_PREVIEW_ORIGIN: "https://preview.example.test",
        AWB_PREVIEW_SESSION_TTL_SECONDS: seconds
      }),
      /Invalid AWB_PREVIEW_SESSION_TTL_SECONDS/
    );
  }

  for (const port of ["0", "-1", "65536", "4311.5", "invalid"]) {
    assert.throws(
      () => loadEnv({
        AWB_DATA_DIR: ".tmp-env-preview-invalid-port",
        AWB_PREVIEW_ENABLED: "true",
        AWB_PREVIEW_ORIGIN: "https://preview.example.test",
        AWB_PREVIEW_PORT: port
      }),
      /Invalid AWB_PREVIEW_PORT/
    );
  }
});

test("preview configuration rejects missing, unsafe, and main-origin public origins", () => {
  const invalidOrigins = [
    "",
    "not a url",
    "ftp://preview.example.test",
    "file:///tmp/preview",
    "https://user:password@preview.example.test",
    "https://preview.example.test/path",
    "https://preview.example.test?query=1",
    "https://preview.example.test#fragment"
  ];

  for (const origin of invalidOrigins) {
    assert.throws(
      () => loadEnv({
        AWB_DATA_DIR: ".tmp-env-preview-invalid-origin",
        AWB_PREVIEW_ENABLED: "on",
        AWB_PREVIEW_ORIGIN: origin
      }),
      /Invalid AWB_PREVIEW_ORIGIN/
    );
  }

  assert.throws(
    () => loadEnv({
      AWB_DATA_DIR: ".tmp-env-preview-same-origin",
      AWB_PREVIEW_ENABLED: "1",
      AWB_PREVIEW_ORIGIN: "http://127.0.0.1:4310"
    }),
    /preview origin must differ from the main origin/
  );
});

test("preview configuration rejects an equal listener port and invalid listener hosts", () => {
  assert.throws(
    () => loadEnv({
      AWB_DATA_DIR: ".tmp-env-preview-port-conflict",
      AWB_PREVIEW_ENABLED: "true",
      AWB_PREVIEW_ORIGIN: "https://preview.example.test",
      AWB_PREVIEW_PORT: "4310"
    }),
    /AWB_PREVIEW_PORT: must differ from AWB_PORT/
  );

  for (const host of ["invalid host", "preview.example.test:4311", "http://preview.example.test", "preview.example.test/path", "user@preview.example.test"]) {
    assert.throws(
      () => loadEnv({
        AWB_DATA_DIR: ".tmp-env-preview-invalid-host",
        AWB_PREVIEW_ENABLED: "true",
        AWB_PREVIEW_ORIGIN: "https://preview.example.test",
        AWB_PREVIEW_HOST: host
      }),
      /Invalid AWB_PREVIEW_HOST/
    );
  }
});
