import { AgentApi } from "./agent-api.js";
import type { ReadCommandDependencies } from "./discovery.js";
import { writeSuccess } from "./output.js";
import { renderSessionList } from "./session-list-output.js";
import { validateSessionQueryResponse, type SessionListQuery } from "./session-query.js";

export type SessionListDependencies = ReadCommandDependencies;
export async function listSessions(query: SessionListQuery, dependencies: SessionListDependencies): Promise<void> {
  const parameters = new URLSearchParams({ workspaceId: query.workspaceId, updatedWithinSeconds: String(query.updatedWithinSeconds), kind: query.kind, status: query.status });
  const api = await AgentApi.connect(dependencies);
  const response = await api.json(`/api/agent/sessions/query?${parameters}`, {
    phase: "history", context: { workspaceId: query.workspaceId }, validate: (value) => validateSessionQueryResponse(value, query)
  });
  const { total, ...data } = response;
  await writeSuccess(dependencies.io, Boolean(dependencies.json), "session list", { ...data, count: total }, renderSessionList(response, query.duration), { phase: "history", effect: "not_applicable", context: { workspaceId: query.workspaceId } });
}
