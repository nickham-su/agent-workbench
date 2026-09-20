export type AgentTimelineQuery = {
  workspaceId: string;
  mode?: "snapshot" | "delta" | "before";
  sinceRevision?: number;
  knownHeadMessageId?: string;
  knownContextRootMessageId?: string;
  knownContextRootIsNull?: true;
  beforeMessageId?: string;
  limit?: number;
};

/**
 * Timeline 的查询参数序列化规则。
 * `knownContextRootIsNull=true` 是“客户端已知 root 为 null”的 URL 可传输表达，
 * 不依赖 Axios 对 null 的默认省略行为。
 */
export function serializeAgentTimelineQuery(query: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) search.append(key, String(item));
      }
      continue;
    }
    search.append(key, String(value));
  }
  return search.toString();
}
