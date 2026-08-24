export const AgentWorkerEndpoints = {
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
  }
} as const;
