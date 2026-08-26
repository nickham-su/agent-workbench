import assert from "node:assert/strict";
import { test } from "node:test";
import { ReadSideApplication } from "./read-side-application.js";

test("ReadSideApplication validates ownership before delegating profile and messages use cases", async () => {
  const calls: string[] = [];
  const application = new ReadSideApplication({
    findSession(sessionId) {
      calls.push(`session:${sessionId}`);
      return sessionId === "missing" ? null : { workspaceId: "ws", kind: "primary", headItemId: 7 };
    },
    findRun(runId) {
      calls.push(`run:${runId}`);
      return runId === "missing" ? null : { runId, workspaceId: "ws", sessionId: "session", agentId: "agent", providerId: "provider", modelId: "model", subtaskDepth: 0, triggerItemId: 9 };
    },
    resolveExecutionProfile(input) {
      calls.push(`profile:${input.run.runId}`);
      return { kind: "profile" as const, headItemId: input.session.headItemId };
    },
    async projectMessagesContext(input) {
      calls.push(`messages:${input.sessionId}`);
      return { kind: "messages" as const, appendMessage: input.appendMessage ?? null };
    },
    ensureWorkspace(workspaceId) {
      calls.push(`workspace:${workspaceId}`);
    },
    async projectPromptContext(input) {
      calls.push(`prompt:${input.run.runId}`);
      return { kind: "prompt" as const };
    }
  });

  assert.deepEqual(application.getExecutionProfileForRun({ workspaceId: "ws", sessionId: "session", runId: "run" }), { kind: "profile", headItemId: 7 });
  assert.deepEqual(await application.getMessagesContext({ workspaceId: "ws", sessionId: "session", appendMessage: { role: "user", content: "one-shot" } }), { kind: "messages", appendMessage: { role: "user", content: "one-shot" } });
  assert.deepEqual(await application.getPromptContextForRun({ workspaceId: "ws", sessionId: "session", runId: "run" }), { kind: "prompt" });
  assert.throws(
    () => application.getExecutionProfileForRun({ workspaceId: "ws", sessionId: "missing", runId: "run" }),
    (error: unknown) => (error as { statusCode?: unknown; message?: unknown }).statusCode === 404 && (error as { message?: unknown }).message === "session not found"
  );
  assert.throws(
    () => application.getExecutionProfileForRun({ workspaceId: "other", sessionId: "session", runId: "run" }),
    (error: unknown) => (error as { statusCode?: unknown; message?: unknown }).statusCode === 400 && (error as { message?: unknown }).message === "workspaceId mismatch"
  );
  assert.throws(
    () => application.getExecutionProfileForRun({ workspaceId: "ws", sessionId: "session", runId: "missing" }),
    (error: unknown) => (error as { statusCode?: unknown; message?: unknown }).statusCode === 404 && (error as { message?: unknown }).message === "run not found"
  );
  await assert.rejects(
    () => application.getMessagesContext({ workspaceId: "other", sessionId: "session" }),
    (error: unknown) => (error as { statusCode?: unknown; message?: unknown }).statusCode === 400 && (error as { message?: unknown }).message === "workspaceId mismatch"
  );
  assert.deepEqual(calls, [
    "session:session",
    "run:run",
    "profile:run",
    "session:session",
    "messages:session",
    "session:session",
    "workspace:ws",
    "run:run",
    "prompt:run",
    "session:missing",
    "session:session",
    "session:session",
    "run:missing",
    "session:session"
  ]);
});
