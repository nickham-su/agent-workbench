import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../src/errors.js";
import { HttpClient, apiUrl } from "../src/http.js";
import { runCli } from "../src/program.js";
import { captureIO, httpServer } from "./helpers.js";

const errorCode = (exitCode: number, code?: string) => (error: unknown) => error instanceof CliError && error.exitCode === exitCode && (!code || error.details.code === code);
test("A-PARSE-ID-ENCODING: opaque path IDs encode once without normalization or route injection", async () => {
  for (const id of ["%2e%2e", "a/../b", "a/?#中文", "opaque-not-uuid"]) {
    const capture = captureIO();
    let requests = 0;
    const code = await runCli(["agent", "list", "-w", id, "--json"], { io: capture.io,
      createConfigStore: () => ({ load: async () => ({ version: 1, apiOrigin: "http://example.test", cookie: null }), save: async () => {} }), http: {
        request: async (_origin, path) => {
          requests++;
          assert.equal(path, `/api/workspaces/${encodeURIComponent(id)}/agents/available?surface=user`);
          return { status: 200, body: '{"agents":[]}', setCookies: [] };
        }
      }
    });
    assert.equal(code, 0);
    assert.equal(requests, 1);
    assert.equal(JSON.parse(capture.output()).data.workspaceId, id);
  }
  assert.equal(apiUrl("http://example.test", "/api/workspaces/%252e%252e/agents/available?surface=user").pathname, "/api/workspaces/%252e%252e/agents/available");
});

test("exact URL route guards reject dot normalization, fragments, backslashes and foreign origin before fetch", async () => {
  let requests = 0;
  const client = new HttpClient(async () => { requests++; throw new Error("Must not fetch"); });
  for (const path of ["/api/x/../y", "/api/%2e%2e/y", "/api/x/%2E/y", "/api/x#fragment", "/api/x\\y", "http://other.test/api/x", "//other.test/api/x", "/other/x"]) {
    await assert.rejects(client.request("http://example.test", path), errorCode(6));
  }
  assert.equal(requests, 0);
});

test("multipart foundation sends real boundary and binary bytes, without JSON serialization or handwritten content type", async (t) => {
  let calls = 0;
  const server = await httpServer(async (request, response) => {
    calls++;
    assert.match(request.headers["content-type"]!, /^multipart\/form-data; boundary=/);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.ok(bytes.includes(Buffer.from([0, 1, 2, 255])));
    assert.ok(bytes.toString("latin1").includes('name="payload"'));
    assert.ok(bytes.toString("latin1").includes('name="images"; filename="image.png"'));
    response.end('{"ok":true}');
  });
  t.after(server.close);
  const form = new FormData();
  form.append("payload", JSON.stringify({ text: "" }));
  form.append("images", new Blob([new Uint8Array([0, 1, 2, 255])], { type: "image/png" }), "image.png");
  const result = await new HttpClient().request(server.origin, "/api/upload", { method: "POST", formData: form });
  assert.equal(result.status, 200);
  assert.equal(calls, 1);
  await assert.rejects(new HttpClient().request(server.origin, "/api/upload", { body: {}, formData: form }), errorCode(2));
  assert.equal(calls, 1);
});

test("stream foundation consumes binary bytes without response.text and retains timeout through consumer completion", async (t) => {
  const bytes = Buffer.from([0, 128, 255, 13, 10]);
  const server = await httpServer((_request, response) => { response.writeHead(200, { "Content-Type": "application/octet-stream" }); response.end(bytes); });
  t.after(server.close);
  const client = new HttpClient();
  const received = await client.stream(server.origin, "/api/download", {}, async (response) => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    try { while (true) { const value = await reader.read(); if (value.done) break; chunks.push(value.value); } }
    finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  });
  assert.deepEqual(received, bytes);
  await assert.rejects(new HttpClient(fetch, 20).stream(server.origin, "/api/download", {}, async (response) => {
    await response.body!.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }), errorCode(5, "REQUEST_TIMEOUT"));
});

test("external AbortSignal stops complete body reads, is never retried, and pre-abort never dispatches", async (t) => {
  let calls = 0;
  let seen: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => { seen = resolve; });
  const server = await httpServer((_request, response) => { calls++; response.writeHead(200); response.write('{"partial":'); seen!(); });
  t.after(server.close);
  const controller = new AbortController();
  const running = new HttpClient().request(server.origin, "/api/hang", { signal: controller.signal });
  await dispatched;
  controller.abort();
  await assert.rejects(running, errorCode(5, "TRANSPORT_FAILED"));
  assert.equal(calls, 1);
  await assert.rejects(new HttpClient().request(server.origin, "/api/not-dispatched", { signal: controller.signal }), (error: unknown) => error instanceof CliError && error.details.effect === "not_sent");
  assert.equal(calls, 1);
});
