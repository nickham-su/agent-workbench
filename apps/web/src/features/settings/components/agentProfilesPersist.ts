import type { AgentSettings, UpdateAgentSettingsRequest } from "@agent-workbench/shared";

export async function persistAgentProfilesDraft(params: {
  getRevision: () => number;
  applyIfLatest: (res: AgentSettings, revision: number) => void;
  update: (body: UpdateAgentSettingsRequest) => Promise<AgentSettings>;
  body: UpdateAgentSettingsRequest;
}) {
  const revision = params.getRevision();
  const res = await params.update(params.body);
  params.applyIfLatest(res, revision);
}
