import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpError } from "../../../app/errors.js";
import { PeripheralAgentQueryApplication } from "./peripheral-agent-query-application.js";

function createApplication(params?: { workspaceExists?: boolean; hasRun?: boolean }) {
  const calls: unknown[][] = [];
  const application = new PeripheralAgentQueryApplication({
    store: {
      workspaceExists: (id) => { calls.push(["workspace", id]); return params?.workspaceExists ?? true; },
      listRecentSessions: (limit, kind) => { calls.push(["sessions", limit, kind]); return [{ id: "session" }] as any; },
      listRecentWorkspaces: (limit) => { calls.push(["workspaces", limit]); return [{ id: "workspace" }] as any; },
      getRun: (runId) => params?.hasRun === false ? null : { runId },
      getLatestTerminalAssistantText: () => ({ itemId: 1, text: "final" })
    },
    availableAgentsQuery: {
      listUserAgents: (workspaceId) => {
        calls.push(["agents", workspaceId]);
        return [{ id: "later", name: "Zulu", order: 2 }, { id: "first", name: "Alpha", order: 1 }] as any;
      }
    }
  });
  return { application, calls };
}

test("PeripheralAgentQueryApplication owns clamp and final-text projections", () => {
  const { application, calls } = createApplication();
  assert.deepEqual(application.listRecentSessions({ limit: 999, kind: "unexpected" as any }), { items: [{ id: "session" }] });
  assert.deepEqual(application.listRecentWorkspaces({ limit: 0 }), { items: [{ id: "workspace" }] });
  assert.deepEqual(application.listRecentSessions({}), { items: [{ id: "session" }] });
  assert.deepEqual(application.listRecentWorkspaces({}), { items: [{ id: "workspace" }] });
  assert.deepEqual(application.getRunFinalText({ runId: " run " }), { found: true, text: "final" });
  assert.deepEqual(application.getRunFinalText({ runId: "  " }), { found: false, text: "" });
  assert.deepEqual(calls.slice(0, 4), [["sessions", 50, "all"], ["workspaces", 10], ["sessions", 10, "all"], ["workspaces", 10]]);
});

test("PeripheralAgentQueryApplication owns workspace, surface, enablement and ordering", () => {
  const { application } = createApplication();
  assert.deepEqual(application.listAvailableAgents({ workspaceId: " workspace " }).agents.map((agent) => agent.id), ["first", "later"]);
  assert.throws(() => application.listAvailableAgents({ workspaceId: " " }), (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_ID_REQUIRED");
  assert.throws(() => application.listAvailableAgents({ workspaceId: "workspace", surface: "subtask" }), (error: unknown) => error instanceof HttpError && error.code === "AGENT_SURFACE_INVALID");
  assert.throws(() => createApplication({ workspaceExists: false }).application.listAvailableAgents({ workspaceId: "workspace" }), (error: unknown) => error instanceof HttpError && error.code === "WORKSPACE_NOT_FOUND");
});
