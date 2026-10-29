import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { WORKSPACE_PREVIEW_RESOURCES } from "@agent-workbench/shared";
import { AUTH_COOKIE_NAME, createSessionCookieValue } from "../../infra/auth/sessionCookie.js";
import { createAgentTestFixture, createTestWorkspace } from "../agent/testkit/agent-testkit.js";

async function setup(t: TestContext, authToken?: string) {
  const fixture = await createAgentTestFixture({ withApp: true, authToken, dataDirPrefix: "workspace-media-" });
  t.after(() => fixture.dispose());
  const workspace = await createTestWorkspace(fixture);
  const app = fixture.app!;
  const url = (filePath: string, workspaceId = workspace.id) =>
    `/api/workspaces/${workspaceId}/files/media?${new URLSearchParams({ path: filePath })}`;
  const write = async (filePath: string, contents = "0123456789") => {
    const absolutePath = path.join(workspace.path, filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, contents);
    return absolutePath;
  };
  return { ...fixture, app, workspace, url, write };
}

test("媒体接口无需独立预览开关，沿用共享 MIME，普通 GET 和 HEAD 不更改下载语义", async (t) => {
  const { app, ctx, workspace, url, write } = await setup(t);
  assert.equal(ctx.preview.enabled, false);
  for (const resource of Object.values(WORKSPACE_PREVIEW_RESOURCES)) {
    if (resource.kind !== "audio" && resource.kind !== "video") continue;
    const filePath = `nested/中文 & clip${resource.extension.toUpperCase()}`;
    await write(filePath);
    const get = await app.inject({ method: "GET", url: url(filePath) });
    assert.equal(get.statusCode, 200, get.body);
    assert.equal(get.body, "0123456789");
    assert.equal(get.headers["content-type"], resource.mime);
    assert.equal(get.headers["content-length"], "10");
    assert.equal(get.headers["accept-ranges"], "bytes");
    assert.equal(get.headers["cache-control"], "no-store");
    assert.equal(get.headers["x-content-type-options"], "nosniff");
    assert.equal(get.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(get.headers["content-disposition"], undefined);
    const head = await app.inject({ method: "HEAD", url: url(filePath) });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], "10");
    const download = await app.inject({
      method: "GET", url: `/api/workspaces/${workspace.id}/files/download?${new URLSearchParams({ path: filePath })}`
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, "0123456789");
    assert.equal(download.headers["content-type"], "application/octet-stream");
    assert.match(String(download.headers["content-disposition"]), /^attachment;/);
  }
});

test("媒体 Range 支持指定区间、开放结尾和后缀，HEAD 与 GET 头一致，非法范围返回 416", async (t) => {
  const { app, url, write } = await setup(t);
  await write("clip.mp4");
  for (const [range, expected, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-100", "89", "bytes 8-9/10"]
  ]) {
    const get = await app.inject({ method: "GET", url: url("clip.mp4"), headers: { range: range! } });
    const head = await app.inject({ method: "HEAD", url: url("clip.mp4"), headers: { range: range! } });
    assert.equal(get.statusCode, 206, get.body);
    assert.equal(head.statusCode, 206);
    assert.equal(get.body, expected);
    assert.equal(head.body, "");
    assert.equal(get.headers["content-range"], contentRange);
    assert.equal(head.headers["content-range"], contentRange);
    assert.equal(get.headers["content-length"], String(expected!.length));
    assert.equal(head.headers["content-length"], get.headers["content-length"]);
  }
  for (const range of ["bytes=10-", "bytes=5-2", "bytes=-0", "bytes=0-1,3-4", "invalid"]) {
    for (const method of ["GET", "HEAD"] as const) {
      const response = await app.inject({ method, url: url("clip.mp4"), headers: { range } });
      assert.equal(response.statusCode, 416, response.body);
      assert.equal(response.headers["content-range"], "bytes */10");
      assert.equal(response.headers["accept-ranges"], "bytes");
      assert.equal(response.body, "");
    }
  }
  await write("empty.mp3", "");
  assert.equal((await app.inject({ method: "GET", url: url("empty.mp3") })).statusCode, 200);
  const emptyRange = await app.inject({ method: "GET", url: url("empty.mp3"), headers: { range: "bytes=0-" } });
  assert.equal(emptyRange.statusCode, 416);
  assert.equal(emptyRange.headers["content-range"], "bytes */0");
});

test("超过文本读取大小限制的大文件仅返回请求区间，尾部跳转不读取完整文件", async (t) => {
  const { app, ctx, url, write } = await setup(t);
  const filePath = await write("large.mp4", "");
  const size = 4 * 1024 ** 3 + 10;
  assert.ok(size > ctx.fileMaxBytes);
  const handle = await fs.open(filePath, "r+");
  try {
    await handle.truncate(size);
    await handle.write(Buffer.from("end"), 0, 3, size - 3);
  } finally {
    await handle.close();
  }
  const head = await app.inject({ method: "HEAD", url: url("large.mp4") });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["content-length"], String(size));
  const tail = await app.inject({ method: "GET", url: url("large.mp4"), headers: { range: "bytes=-3" } });
  assert.equal(tail.statusCode, 206);
  assert.equal(tail.body, "end");
  assert.equal(tail.headers["content-length"], "3");
  assert.equal(tail.headers["content-range"], `bytes ${size - 3}-${size - 1}/${size}`);
});

test("同源媒体接口拒绝非音视频、目录、越界路径、内部目录及所有软链", async (t) => {
  const { app, dataDir, workspace, url, write } = await setup(t);
  for (const filePath of ["page.html", "script.js", "image.svg", "image.png", "text.txt"]) {
    await write(filePath, "must not be served");
    for (const method of ["GET", "HEAD"] as const) {
      const response = await app.inject({ method, url: url(filePath) });
      assert.equal(response.statusCode, 415, `${filePath}: ${response.body}`);
      assert.ok(!response.body.includes("must not be served"));
    }
  }
  await write("folder/clip.mp4");
  assert.equal((await app.inject({ method: "GET", url: url("folder") })).statusCode, 415);
  for (const filePath of [".git/private.mp4", ".awb/private.mp4"]) await write(filePath, "private");
  const outside = path.join(dataDir, "outside.mp4");
  await fs.writeFile(outside, "outside");
  await fs.symlink(path.join(workspace.path, "folder/clip.mp4"), path.join(workspace.path, "inside-link.mp4"));
  await fs.symlink(outside, path.join(workspace.path, "outside-link.mp4"));
  await fs.symlink(path.join(workspace.path, "folder"), path.join(workspace.path, "linked-folder"));
  for (const filePath of [
    ".git/private.mp4", ".awb/private.mp4", "../outside.mp4", "/outside.mp4", "folder\\clip.mp4",
    "inside-link.mp4", "outside-link.mp4", "linked-folder/clip.mp4", "bad\0.mp4"
  ]) {
    const response = await app.inject({ method: "GET", url: url(filePath) });
    assert.equal(response.statusCode, 403, `${filePath}: ${response.body}`);
    assert.ok(!response.body.includes(workspace.path));
    assert.ok(!response.body.includes(dataDir));
  }
  assert.equal((await app.inject({ method: "GET", url: url("missing.mp4") })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: url("folder/clip.mp4", "missing-workspace") })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: `/api/workspaces/${workspace.id}/files/media` })).statusCode, 400);
  // Percent signs in the actual filename must not trigger a second decoding pass.
  await write("clip%2fpart.mp4", "literal-percent");
  const literal = await app.inject({ method: "GET", url: url("clip%2fpart.mp4") });
  assert.equal(literal.statusCode, 200);
  assert.equal(literal.body, "literal-percent");
});

test("GET、HEAD 和 Range 均受主站 Cookie 鉴权保护，不向 URL 放入凭证", async (t) => {
  const authToken = randomUUID();
  const { app, url, write } = await setup(t, authToken);
  await write("clip.mp4");
  for (const method of ["GET", "HEAD"] as const) {
    assert.equal((await app.inject({ method, url: url("clip.mp4") })).statusCode, 401);
    assert.equal((await app.inject({ method, url: url("clip.mp4"), headers: { range: "bytes=0-1" } })).statusCode, 401);
  }
  const cookie = `${AUTH_COOKIE_NAME}=${createSessionCookieValue({ authToken, nowMs: Date.now(), ttlMs: 60_000 })}`;
  const authorized = await app.inject({ method: "GET", url: url("clip.mp4"), headers: { cookie, range: "bytes=0-1" } });
  assert.equal(authorized.statusCode, 206);
  assert.equal(authorized.body, "01");
});

test("客户端取消大媒体请求后释放文件句柄，后续 Range 请求仍可播放", async (t) => {
  const { app, url, write } = await setup(t);
  const absolutePath = await write("cancel.mp4", "");
  const size = 128 * 1024 ** 2;
  await fs.truncate(absolutePath, size);
  const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === absolutePath) opened.push(handle);
    return handle;
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  let received = 0;
  await new Promise<void>((resolve, reject) => {
    let cancelled = false;
    const request = http.get(`${origin}${url("cancel.mp4")}`, (response) => {
      assert.equal(response.statusCode, 200);
      response.once("data", (chunk: Buffer) => {
        received += chunk.length;
        cancelled = true;
        response.destroy();
        request.destroy();
        resolve();
      });
      response.once("error", (error) => { if (!cancelled) reject(error); });
    });
    request.once("error", (error) => { if (!cancelled) reject(error); });
  });
  assert.ok(received > 0 && received < size);
  for (let attempt = 0; attempt < 100 && (!opened.length || opened.some((handle) => handle.fd !== -1)); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(opened.length, 1);
  assert.equal(opened[0]!.fd, -1);
  const next = await app.inject({ method: "GET", url: url("cancel.mp4"), headers: { range: "bytes=10-19" } });
  assert.equal(next.statusCode, 206);
  assert.equal(next.rawPayload.length, 10);
});

test("客户端在安全打开过程中断连也会关闭稍后返回的文件句柄", async (t) => {
  const { app, url, write } = await setup(t);
  const absolutePath = await write("opening.mp4");
  let reportOpened!: () => void;
  const didOpen = new Promise<void>((resolve) => { reportOpened = resolve; });
  let resumeOpen!: () => void;
  const openGate = new Promise<void>((resolve) => { resumeOpen = resolve; });
  t.after(() => resumeOpen());
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === absolutePath) {
      handles.push(handle);
      reportOpened();
      await openGate;
    }
    return handle;
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = http.get(`${origin}${url("opening.mp4")}`);
  const disconnected = new Promise<void>((resolve) => request.once("close", resolve));
  request.on("error", () => {}); // Expected ECONNRESET when aborting before response headers.
  await didOpen;
  request.destroy();
  await disconnected;
  // Wait until the server has observed the disconnect before releasing its async open.
  for (let attempt = 0; attempt < 100 && app.server.listening; attempt++) {
    const connections = await new Promise<number>((resolve, reject) => app.server.getConnections((error, count) => error ? reject(error) : resolve(count)));
    if (connections === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  resumeOpen();
  for (let attempt = 0; attempt < 100 && handles.some((handle) => handle.fd !== -1); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(handles.length, 1);
  assert.equal(handles[0]!.fd, -1);
});
