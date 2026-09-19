export type AgentCycleOption = { value: string };

export function resolveCycledAgentId(
  options: readonly AgentCycleOption[],
  currentId: string,
  step: 1 | -1,
): string | null {
  if (options.length === 0) return null;
  let index = options.findIndex((item) => item.value === currentId);
  if (index < 0) index = 0;
  const nextId = options[(index + step + options.length) % options.length]?.value;
  return nextId && nextId !== currentId ? nextId : null;
}

export function formatAgentHeaderTokens(
  tokens: number | null | undefined,
  contextTokenRatio: number | null | undefined,
  locale?: string,
): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return "";
  const formattedTokens = new Intl.NumberFormat(locale).format(Math.floor(tokens));
  if (typeof contextTokenRatio !== "number" || !Number.isFinite(contextTokenRatio) || contextTokenRatio < 0) {
    return `${formattedTokens} tokens`;
  }
  const formattedRatio = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(contextTokenRatio);
  return `${formattedTokens} tokens (${formattedRatio})`;
}

export function copyTextWithExecCommand(content: string, targetDocument: Document = document): boolean {
  const textarea = targetDocument.createElement("textarea");
  try {
    textarea.value = content;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    targetDocument.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    return targetDocument.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export function shouldRunAgentElapsedTimer(input: {
  active: boolean;
  status: "idle" | "running";
  activeRunStartedAt: number | null | undefined;
}): boolean {
  return input.active
    && input.status === "running"
    && typeof input.activeRunStartedAt === "number"
    && Number.isFinite(input.activeRunStartedAt);
}
