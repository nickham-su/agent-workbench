const SCRATCHPAD_MAX_CHARS = 1000;

export type ParsedScratchpadArgs = {
  content: string;
};

export function parseScratchpadArgs(raw: Record<string, unknown>): ParsedScratchpadArgs {
  if (typeof raw.content !== "string") {
    throw new Error("scratchpad.content must be a string");
  }
  const trimmed = raw.content.trim();
  const content = trimmed.length > SCRATCHPAD_MAX_CHARS ? trimmed.slice(0, SCRATCHPAD_MAX_CHARS) : trimmed;
  return { content };
}

export function toScratchpadResult(input: ParsedScratchpadArgs) {
  return { content: input.content };
}
