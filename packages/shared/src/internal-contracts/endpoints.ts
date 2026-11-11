export const AgentWorkerEndpoints = {
  runtimeIdentity: { method: "GET", path: "/internal/agent-worker/runtime-identity" },
  stopRunsAndWait: { method: "POST", path: "/internal/agent-worker/stop-runs-and-wait" },
  health: {
    method: "GET",
    path: "/internal/health"
  },
  enqueueRun: {
    method: "POST",
    path: "/internal/runs/enqueue"
  },
  cancelSession: {
    method: "POST",
    path: "/internal/runs/cancel-session"
  },
  cancelSessionAndWait: {
    method: "POST",
    path: "/internal/runs/cancel-session-and-wait"
  }
} as const;
