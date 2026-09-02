import type { AgentGlobalPromptItem } from "@agent-workbench/shared";

export type SlashCommandAction = "compact" | "clear";

export type SlashCommandDefinition = {
  name: string;
  usage: string;
  summaryKey: string;
  strictOnly: boolean;
  action: SlashCommandAction;
};

export type SlashCandidateItem = {
  id: string;
  kind: "slash";
  label: string;
  command: SlashCommandDefinition;
};

export type PromptCommandCandidateItem = {
  id: string;
  kind: "prompt_command";
  label: string;
  description?: string;
  command: string;
};

export type MentionCandidateItem = {
  id: string;
  kind: "skill" | "file";
  label: string;
  description?: string;
  insertText: string;
};

export function createInputCandidateListId(instanceKey: string) {
  const encoded = Array.from(instanceKey).map((char) => char.codePointAt(0)?.toString(16).padStart(4, "0") || "0").join("-");
  return `agent-input-candidate-list-${encoded || "empty"}`;
}

export function createInputCandidateDomId(listId: string, index: number) {
  return `${listId}-option-${Math.max(0, Math.floor(index))}`;
}

export function buildPromptCommandMap(items: AgentGlobalPromptItem[], builtInCommands: SlashCommandDefinition[]) {
  const builtInNames = new Set(builtInCommands.map((item) => item.name));
  const map = new Map<string, AgentGlobalPromptItem>();
  for (const item of items) {
    if (!item || item.id === "global_system_prompt") continue;
    const command = typeof item.command === "string" ? item.command.trim().toLowerCase() : "";
    if (!command || builtInNames.has(command) || map.has(command)) continue;
    map.set(command, item);
  }
  return map;
}

export function buildSlashInputCandidates(params: {
  commands: SlashCommandDefinition[];
  promptCommands: Map<string, AgentGlobalPromptItem>;
  query: string;
}) {
  const slashItems: SlashCandidateItem[] = params.commands.filter((command) => !params.query || command.name.startsWith(params.query)).map((command) => ({
    id: `slash:${command.name}`,
    kind: "slash",
    label: command.usage,
    command
  }));
  const promptItems: PromptCommandCandidateItem[] = [...params.promptCommands.entries()]
    .filter(([name]) => !params.query || name.startsWith(params.query))
    .map(([name, item]) => ({
      id: `prompt_command:${name}`,
      kind: "prompt_command",
    label: `/${name}`,
    description: item.title,
    command: name
    }));
  return [...slashItems, ...promptItems];
}

export function limitMentionCandidates<T>(items: T[], limit: number) {
  return items.slice(0, Math.max(0, limit));
}

export function buildSlashCommandHint(params: {
  text: string;
  commands: SlashCommandDefinition[];
  selectedName: string;
}) {
  const trimmed = params.text.trimStart();
  if (!trimmed.startsWith("/")) {
    return {
      visible: false,
      query: "",
      commands: [] as SlashCommandDefinition[],
      activeCommand: ""
    };
  }
  const normalized = trimmed.trim().toLowerCase();
  for (const item of params.commands) {
    if (normalized === item.usage) {
      return {
        visible: false,
        query: "",
        commands: [] as SlashCommandDefinition[],
        activeCommand: ""
      };
    }
  }
  const query = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase() || "";
  const commands = params.commands.filter((item) => !query || item.name.startsWith(query));
  const active = commands.some((item) => item.name === params.selectedName)
    ? params.selectedName
    : (commands[0]?.name || "");
  return {
    visible: true,
    query,
    commands,
    activeCommand: active
  };
}

export function resolveSlashCommand(text: string, commandMap: Map<string, SlashCommandDefinition>) {
  const normalized = text.trim().toLowerCase();
  if (!normalized.startsWith("/")) return null;
  const commandName = normalized.slice(1);
  const command = commandMap.get(commandName);
  if (!command) return null;
  if (command.strictOnly && normalized !== command.usage) return null;
  return command;
}

export function shouldConvertLeadingIdeographicCommaToSlash(previousText: string, nextText: string) {
  return previousText.length === 0 && nextText.startsWith("、");
}

export function promptCommandInsertText(item: AgentGlobalPromptItem, command: string) {
  if (item.expandOnSelect === true) return item.prompt;
  return `/${command}`;
}

export function promptCommandInsertCaret(item: AgentGlobalPromptItem, command: string) {
  return promptCommandInsertText(item, command).length;
}

const MENTION_TERMINATORS = /[\s,;:)\]}，；：。]/;
const MENTION_ALLOWED_PREFIX = /[\s([{"'“‘，。！？、；：【《「『]/;
const MENTION_INVALID_PREFIX = /[0-9A-Za-z_./+\-]/;

export type MentionTarget = {
  triggerIndex: number;
  replaceFrom: number;
  replaceTo: number;
  query: string;
};

function isLegalMentionPrefix(text: string, atIndex: number) {
  if (atIndex <= 0) return true;
  const prev = text[atIndex - 1] || "";
  if (MENTION_INVALID_PREFIX.test(prev)) return false;
  return MENTION_ALLOWED_PREFIX.test(prev);
}

function isMentionQueryValid(query: string) {
  if (!query) return true;
  return !MENTION_TERMINATORS.test(query);
}

export function findMentionTarget(text: string, caretIndex: number): MentionTarget | null {
  const safeCaret = Math.max(0, Math.min(text.length, caretIndex));
  for (let i = safeCaret - 1; i >= 0; i -= 1) {
    if (text[i] !== "@") continue;
    if (!isLegalMentionPrefix(text, i)) continue;
    const query = text.slice(i + 1, safeCaret);
    if (!isMentionQueryValid(query)) return null;
    return {
      triggerIndex: i,
      replaceFrom: i,
      replaceTo: safeCaret,
      query
    };
  }
  return null;
}

export function isSlashMode(text: string) {
  return text.trimStart().startsWith("/");
}
