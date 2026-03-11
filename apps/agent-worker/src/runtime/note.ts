const NOTE_MAX_CHARS = 1000;

export type ParsedNoteArgs = {
  content: string;
};

export function parseNoteArgs(raw: Record<string, unknown>): ParsedNoteArgs {
  if (typeof raw.content !== "string") {
    throw new Error("note.content must be a string");
  }
  const trimmed = raw.content.trim();
  const content = trimmed.length > NOTE_MAX_CHARS ? trimmed.slice(0, NOTE_MAX_CHARS) : trimmed;
  return { content };
}

export function toNoteResult(input: ParsedNoteArgs) {
  return { content: input.content };
}
