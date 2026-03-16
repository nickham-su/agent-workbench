const SUBTASK_SESSION_ID_HEADER_RE = /^subtask_session_id\s*:\s*(\S+)/im;

function normalizeSessionId(value: unknown) {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return id;
}

export function resolveSubtaskSessionIdForDisplay(input: {
  resultSubtaskSessionId?: unknown;
  outputText?: unknown;
  fallbackText?: unknown;
}) {
  const fromResult = normalizeSessionId(input.resultSubtaskSessionId);
  if (fromResult) return fromResult;

  const textCandidates = [input.outputText, input.fallbackText];
  for (const candidate of textCandidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(SUBTASK_SESSION_ID_HEADER_RE);
    const parsed = match?.[1] ? normalizeSessionId(match[1]) : "";
    if (parsed) return parsed;
  }

  return "";
}

export const __testOnly = {
  SUBTASK_SESSION_ID_HEADER_RE
};
