import { Type } from "@sinclair/typebox";

/** A dedicated incarnation UUID, never an Analytics generation or a PID. */
export const AgentRuntimeInstanceIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
});
export const AGENT_STOP_PROTOCOL_VERSION = "agent-stop-runs-v1";
