export type SubtaskParentKey = {
  parentRunId: string;
  parentToolItemId: number;
};

/** Minimal child-run shape consumed by context-item read-side projection. */
export type SubtaskRunProjectionRecord = {
  runId: string;
  parentRunId: string;
  parentToolItemId: number;
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
};
