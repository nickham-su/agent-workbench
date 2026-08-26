import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { WORKSPACE_PREVIEW_RESOURCES } from "@agent-workbench/shared";
import {
  PREVIEW_BOOTSTRAP_CSP,
  PREVIEW_ERROR_HTML_CSP,
  PREVIEW_PERMISSIONS_POLICY,
  PREVIEW_SVG_CSP,
  PREVIEW_WORKSPACE_HTML_CSP,
  applyWorkspaceHtmlHeaders,
  buildBinaryResourceHeaders,
  buildBootstrapHeaders,
  buildPreviewErrorHtml,
  buildPreviewErrorHtmlHeaders,
  buildPreviewFileHeaders,
  buildSvgHeaders,
  buildWorkspaceHtmlHeaders,
  createPreviewStreamPlan,
  getPreviewStaticMethodResult,
  parseSingleByteRange,
  type PreviewHeaderSink
} from "./preview-response.js";

const html = WORKSPACE_PREVIEW_RESOURCES[".html"]!;
const svg = WORKSPACE_PREVIEW_RESOURCES[".svg"]!;
const css = WORKSPACE_PREVIEW_RESOURCES[".css"]!;
const mp4 = WORKSPACE_PREVIEW_RESOURCES[".mp4"]!;

function assertCommonHeaders(headers: Record<string, string>) {
  assert.equal(headers["Cache-Control"], "no-store");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-DNS-Prefetch-Control"], "off");
  assert.equal(headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal("Access-Control-Allow-Origin" in headers, false);
}

function assertNoUnsafeCsp(csp: string) {
  assert.equal(csp.includes("*"), false);
  assert.equal(csp.includes("https:"), false);
  assert.equal(csp.includes("unsafe-eval"), false);
}

test("header builders apply common protections and distinct bootstrap, HTML, SVG, error, and resource policies", () => {
  const bootstrap = buildBootstrapHeaders();
  const workspaceHtml = buildWorkspaceHtmlHeaders();
  const svgHeaders = buildSvgHeaders();
  const errorHeaders = buildPreviewErrorHtmlHeaders();
  const binary = buildBinaryResourceHeaders("text/css; charset=utf-8");

  for (const headers of [bootstrap, workspaceHtml, svgHeaders, errorHeaders, binary]) assertCommonHeaders(headers);
  assert.equal(bootstrap["Content-Security-Policy"], PREVIEW_BOOTSTRAP_CSP);
  assert.equal(workspaceHtml["Content-Security-Policy"], PREVIEW_WORKSPACE_HTML_CSP);
  assert.equal(svgHeaders["Content-Security-Policy"], PREVIEW_SVG_CSP);
  assert.equal(errorHeaders["Content-Security-Policy"], PREVIEW_ERROR_HTML_CSP);
  assert.notEqual(workspaceHtml["Content-Security-Policy"], svgHeaders["Content-Security-Policy"]);
  assert.equal(svgHeaders["Content-Disposition"], "inline");
  assert.equal(binary["Content-Type"], "text/css; charset=utf-8");
  assert.equal(binary["Cross-Origin-Opener-Policy"], undefined);

  for (const csp of [PREVIEW_BOOTSTRAP_CSP, PREVIEW_WORKSPACE_HTML_CSP, PREVIEW_SVG_CSP, PREVIEW_ERROR_HTML_CSP]) {
    assertNoUnsafeCsp(csp);
  }
  assert.match(PREVIEW_WORKSPACE_HTML_CSP, /worker-src 'none'/);
  assert.match(PREVIEW_WORKSPACE_HTML_CSP, /frame-src 'none'/);
  assert.match(PREVIEW_WORKSPACE_HTML_CSP, /form-action 'none'/);
  assert.match(PREVIEW_SVG_CSP, /script-src 'none'/);
  assert.equal(workspaceHtml["Permissions-Policy"], PREVIEW_PERMISSIONS_POLICY);
  for (const capability of ["camera", "microphone", "geolocation", "usb", "serial", "bluetooth", "payment", "midi", "document-domain"]) {
    assert.match(PREVIEW_PERMISSIONS_POLICY, new RegExp(`${capability}=\\(\\)`));
  }

  const applied: Record<string, string> = {};
  const sink: PreviewHeaderSink = { header: (name, value) => { applied[name] = value; } };
  applyWorkspaceHtmlHeaders(sink);
  assert.deepEqual(applied, workspaceHtml);
  assert.equal(buildPreviewFileHeaders(html)["Content-Security-Policy"], PREVIEW_WORKSPACE_HTML_CSP);
  assert.equal(buildPreviewFileHeaders(svg)["Content-Security-Policy"], PREVIEW_SVG_CSP);
  assert.equal(buildPreviewFileHeaders(css)["Content-Type"], css.mime);

  for (const resource of Object.values(WORKSPACE_PREVIEW_RESOURCES)) {
    const headers = buildPreviewFileHeaders(resource);
    assert.equal(headers["Content-Type"], resource.mime, resource.extension);
    if (resource.kind === "html") assert.equal(headers["Content-Security-Policy"], PREVIEW_WORKSPACE_HTML_CSP);
    else if (resource.extension === ".svg") assert.equal(headers["Content-Security-Policy"], PREVIEW_SVG_CSP);
    else assert.equal(headers["Content-Security-Policy"], undefined, resource.extension);
  }
});

test("error renderer is self-contained, fixed, and does not interpolate sensitive request data", () => {
  const document = buildPreviewErrorHtml();
  assert.match(document, /^<!doctype html>/i);
  assert.match(document, /预览已失效或不可用，请返回 Agent Workbench 重新打开。/);
  assert.equal(document.includes("<script"), false);
  assert.equal(document.includes("/data/workspaces"), false);
});

test("static method helper allows only GET and HEAD", () => {
  assert.deepEqual(getPreviewStaticMethodResult("GET"), { allowed: true, head: false });
  assert.deepEqual(getPreviewStaticMethodResult("HEAD"), { allowed: true, head: true });
  const rejected = getPreviewStaticMethodResult("POST");
  assert.equal(rejected.allowed, false);
  if (rejected.allowed) throw new Error("expected method rejection");
  assert.equal(rejected.statusCode, 405);
  assert.equal(rejected.headers.Allow, "GET, HEAD");
  assertCommonHeaders(rejected.headers);
});

test("single byte range parser accepts the three legal forms and rejects invalid values", () => {
  assert.deepEqual(parseSingleByteRange(undefined, 10), { kind: "none" });
  assert.deepEqual(parseSingleByteRange("bytes=2-5", 10), { kind: "range", start: 2, end: 5 });
  assert.deepEqual(parseSingleByteRange("bytes=2-", 10), { kind: "range", start: 2, end: 9 });
  assert.deepEqual(parseSingleByteRange("bytes=-3", 10), { kind: "range", start: 7, end: 9 });
  assert.deepEqual(parseSingleByteRange("bytes=2-99", 10), { kind: "range", start: 2, end: 9 });
  for (const value of ["items=0-1", "bytes=0-1,2-3", "bytes=10-", "bytes=3-2", "bytes=-0", "bytes=x-1", "bytes=0-x", "bytes=0-1-2", "bytes="]) {
    assert.deepEqual(parseSingleByteRange(value, 10), { kind: "invalid" }, value);
  }
  assert.deepEqual(parseSingleByteRange("bytes=0-0", 0), { kind: "invalid" });
});

function streamFixture() {
  let closeCalls = 0;
  let streamCalls: Array<{ filePath: string; fd: number; start?: number; end?: number }> = [];
  const stream = new PassThrough();
  return {
    handle: { fd: 42, close: async () => { closeCalls += 1; } },
    createReadStream: (options: { filePath: string; fd: number; start?: number; end?: number }) => {
      streamCalls.push(options);
      return stream;
    },
    stream,
    get closeCalls() { return closeCalls; },
    get streamCalls() { return streamCalls; }
  };
}

test("stream plans implement GET/HEAD and media Range status, headers, and no-body semantics", async () => {
  const full = streamFixture();
  const getPlan = await createPreviewStreamPlan({ method: "GET", resource: mp4, filePath: "/fixture.mp4", size: 10, handle: full.handle, createReadStream: full.createReadStream });
  assert.equal(getPlan.statusCode, 200);
  assert.equal(getPlan.headers["Content-Length"], "10");
  assert.equal(getPlan.headers["Accept-Ranges"], "bytes");
  assert.equal(getPlan.body, full.stream);
  assert.deepEqual(full.streamCalls, [{ filePath: "/fixture.mp4", fd: 42 }]);
  full.stream.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(full.closeCalls, 1);
  await getPlan.close();
  assert.equal(full.closeCalls, 1);

  const normalEnd = streamFixture();
  const normalEndPlan = await createPreviewStreamPlan({ method: "GET", resource: mp4, filePath: "/fixture.mp4", size: 10, handle: normalEnd.handle, createReadStream: normalEnd.createReadStream });
  normalEndPlan.body?.resume();
  normalEnd.stream.end("complete");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(normalEnd.closeCalls, 1);
  await normalEndPlan.close();
  assert.equal(normalEnd.closeCalls, 1);

  const failure = streamFixture();
  await createPreviewStreamPlan({ method: "GET", resource: mp4, filePath: "/fixture.mp4", size: 10, handle: failure.handle, createReadStream: failure.createReadStream });
  failure.stream.emit("error", new Error("stream failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failure.closeCalls, 1);
  failure.stream.destroy();

  const partial = streamFixture();
  const rangePlan = await createPreviewStreamPlan({ method: "GET", rangeHeader: "bytes=3-", resource: mp4, filePath: "/fixture.mp4", size: 10, handle: partial.handle, createReadStream: partial.createReadStream });
  assert.equal(rangePlan.statusCode, 206);
  assert.equal(rangePlan.headers["Content-Range"], "bytes 3-9/10");
  assert.equal(rangePlan.headers["Content-Length"], "7");
  assert.deepEqual(partial.streamCalls, [{ filePath: "/fixture.mp4", fd: 42, start: 3, end: 9 }]);
  await rangePlan.close();
  assert.equal(partial.closeCalls, 1);

  const head = streamFixture();
  const headPlan = await createPreviewStreamPlan({ method: "HEAD", rangeHeader: "bytes=-2", resource: mp4, filePath: "/fixture.mp4", size: 10, handle: head.handle, createReadStream: head.createReadStream });
  assert.equal(headPlan.statusCode, 206);
  assert.equal(headPlan.body, null);
  assert.equal(headPlan.headers["Content-Range"], "bytes 8-9/10");
  assert.deepEqual(head.streamCalls, []);
  assert.equal(head.closeCalls, 1);

  const invalid = streamFixture();
  const invalidPlan = await createPreviewStreamPlan({ method: "HEAD", rangeHeader: "bytes=50-", resource: mp4, filePath: "/fixture.mp4", size: 10, handle: invalid.handle, createReadStream: invalid.createReadStream });
  assert.equal(invalidPlan.statusCode, 416);
  assert.equal(invalidPlan.headers["Content-Range"], "bytes */10");
  assert.equal(invalidPlan.headers["Accept-Ranges"], "bytes");
  assert.equal(invalidPlan.body, null);
  assert.equal(invalid.closeCalls, 1);
});

test("non-media ignores Range and stream factory failures close the file handle", async () => {
  const ignored = streamFixture();
  const ignoredPlan = await createPreviewStreamPlan({ method: "GET", rangeHeader: "bytes=1-2", resource: css, filePath: "/fixture.css", size: 10, handle: ignored.handle, createReadStream: ignored.createReadStream });
  assert.equal(ignoredPlan.statusCode, 200);
  assert.equal(ignoredPlan.headers["Content-Range"], undefined);
  assert.equal(ignoredPlan.headers["Accept-Ranges"], undefined);
  assert.equal(ignoredPlan.headers["Content-Length"], "10");
  assert.deepEqual(ignored.streamCalls, [{ filePath: "/fixture.css", fd: 42 }]);
  await ignoredPlan.close();

  let closeCalls = 0;
  await assert.rejects(
    createPreviewStreamPlan({
      method: "GET",
      resource: mp4,
      filePath: "/fixture.mp4",
      size: 10,
      handle: { fd: 42, close: async () => { closeCalls += 1; } },
      createReadStream: () => { throw new Error("stream setup failed"); }
    }),
    /stream setup failed/
  );
  assert.equal(closeCalls, 1);
});
