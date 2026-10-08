import type {
  AgentGlobalPromptItem,
  UpdateAgentGlobalPromptSettingsRequest
} from "@agent-workbench/shared";

export const RESERVED_GLOBAL_SYSTEM_PROMPT_ID = "global_system_prompt";
const RESERVED_BUILTIN_GLOBAL_PROMPT_COMMANDS = new Set(["compact"]);

export function isReservedAgentGlobalPromptItem(id: string) {
  return id.trim() === RESERVED_GLOBAL_SYSTEM_PROMPT_ID;
}

/** 前端设置校验仅保留当前真实内建 slash command 的命名空间。 */
export function isReservedBuiltinGlobalPromptCommand(command: string) {
  return RESERVED_BUILTIN_GLOBAL_PROMPT_COMMANDS.has(command.trim().toLowerCase());
}

export function normalizeAgentGlobalPromptItems(raw: unknown): AgentGlobalPromptItem[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentGlobalPromptItem[] = [];
  const seen = new Set<string>();
  for (const itemRaw of raw) {
    if (!itemRaw || typeof itemRaw !== "object" || Array.isArray(itemRaw)) continue;
    const item = itemRaw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const prompt = typeof item.prompt === "string" ? item.prompt : "";
    const command = typeof item.command === "string" ? item.command.trim() : "";
    const isReserved = isReservedAgentGlobalPromptItem(id);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const expandOnSelect = command && !isReserved && item.expandOnSelect === true;
    out.push({
      id,
      title,
      prompt,
      ...(command && !isReserved ? { command } : {}),
      ...(expandOnSelect ? { expandOnSelect: true } : {})
    });
  }
  return out;
}

export function toAgentGlobalPromptsRequest(
  items: readonly AgentGlobalPromptItem[]
): UpdateAgentGlobalPromptSettingsRequest {
  return {
    items: items.map((item) => {
      const command = typeof item.command === "string" ? item.command.trim() : "";
      const isReserved = isReservedAgentGlobalPromptItem(item.id);
      const expandOnSelect = command && !isReserved && item.expandOnSelect === true;
      return {
        id: item.id,
        title: item.title.trim(),
        prompt: item.prompt,
        ...(command && !isReserved ? { command } : {}),
        ...(expandOnSelect ? { expandOnSelect: true } : {})
      };
    })
  };
}
