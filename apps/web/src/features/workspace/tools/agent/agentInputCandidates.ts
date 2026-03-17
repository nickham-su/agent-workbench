export type SlashCommandAction = "compact" | "clear";

export type SlashCommandDefinition = {
  name: string;
  usage: string;
  summaryKey: string;
  strictOnly: boolean;
  action: SlashCommandAction;
};

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
