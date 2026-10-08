import type { Db } from "./db.js";

/** Connection-local, deterministic JS trim semantics; never modifies persisted data. */
export function registerAgentQueryFunctions(db: Db): void {
  db.function("agent_trim_title", { deterministic: true }, (value: unknown) => String(value ?? "").trim());
}
