import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { ArchiveReadApplication } from "./archive-read-application.js";

function create() {
  const calls: any[] = [];
  const app = new ArchiveReadApplication(
    { get: (id) => id === "session" ? { id, workspaceId: "workspace" } : null },
    {
      async search(params) { calls.push(["search", params]); return { text: "pos=1 | match" }; },
      async read(params) { calls.push(["read", params]); return { text: "pos=1 | line" }; }
    }
  );
  return { app, calls };
}

test("ArchiveReadApplication preserves normalized search/read bounds and owner validation", async () => {
  const { app, calls } = create();
  await app.search({ workspaceId: "workspace", sessionId: "session", query: "  needle  ", maxHits: 999, maxChars: 1, snippet: true });
  await app.read({ workspaceId: "workspace", sessionId: "session", lineCount: 999, maxChars: 1 });
  assert.deepEqual(calls, [
    ["search", { workspaceId: "workspace", sessionId: "session", query: "needle", maxHits: 100, maxChars: 1000, snippet: true, regex: false }],
    ["read", { workspaceId: "workspace", sessionId: "session", lineCount: 200, maxChars: 1000 }]
  ]);
  await assert.rejects(app.read({ workspaceId: "workspace", sessionId: "session", beforePos: 1 }), (e: unknown) => e instanceof HttpError && e.code === "AGENT_ARCHIVE_BEFORE_POS_INVALID");
  await assert.rejects(app.search({ workspaceId: "other", sessionId: "session", query: "needle" }), /workspaceId mismatch/);
});
