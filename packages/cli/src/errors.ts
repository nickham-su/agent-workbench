import { escapeDisplayText } from "./session-list-output.js";

export type CliExitCode = 0 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 130 | 141 | 143;
export type ErrorPhase = "parse" | "input" | "config" | "discover" | "create" | "send" | "history" | "follow" | "status" | "cancel" | "compact" | "download" | "publish";
export type OperationEffect = "not_applicable" | "not_sent" | "rejected" | "accepted" | "unknown";
export interface ErrorContext {
  workspaceId?: string;
  sessionId?: string;
  agentId?: string;
  messageId?: string;
  runId?: string;
  clientRequestId?: string;
  published?: boolean;
}
export interface ErrorDetails {
  code?: string;
  phase?: ErrorPhase;
  effect?: OperationEffect;
  context?: ErrorContext;
  help?: string;
  serviceCode?: string;
}
const categories: Record<Exclude<CliExitCode, 0>, string> = {
  2: "USAGE", 3: "CONFIG", 4: "AUTH", 5: "NETWORK", 6: "RESPONSE", 7: "PERSISTENCE",
  8: "RUN_FAILED", 9: "RUN_CANCELLED", 10: "FOLLOW_TIMEOUT", 130: "INTERRUPTED", 141: "OUTPUT", 143: "INTERRUPTED"
};
const defaultCodes: Record<Exclude<CliExitCode, 0>, string> = {
  2: "INPUT_INVALID", 3: "CONFIG_INVALID", 4: "AUTH_REQUIRED", 5: "TRANSPORT_FAILED", 6: "RESPONSE_INVALID", 7: "LOCAL_IO_FAILED",
  8: "RUN_FAILED", 9: "RUN_CANCELLED", 10: "FOLLOW_TIMEOUT", 130: "INTERRUPTED", 141: "OUTPUT_CLOSED", 143: "INTERRUPTED"
};

/** Messages/details must be locally authored or previously validated, never raw exceptions/bodies. */
export class CliError extends Error {
  constructor(readonly exitCode: Exclude<CliExitCode, 0>, message: string, readonly details: ErrorDetails = {}) {
    super(message);
    this.name = "CliError";
  }
}

/** Add command boundaries without overwriting more precise transport/operation evidence. */
export function withErrorDetails(error: unknown, details: ErrorDetails): CliError {
  const safe = error instanceof CliError ? error : responseError("CLI 执行失败，未能确认完整结果。");
  return new CliError(safe.exitCode, safe.message, {
    ...details, ...safe.details,
    context: { ...details.context, ...safe.details.context }
  });
}

export function errorObject(error: CliError) {
  return { schemaVersion: 1, ok: false, error: {
    category: categories[error.exitCode], code: error.details.code ?? defaultCodes[error.exitCode], message: error.message,
    phase: error.details.phase ?? "parse", effect: error.details.effect ?? "not_applicable",
    context: error.details.context ?? {},
    ...(error.details.serviceCode ? { serviceCode: error.details.serviceCode } : {}),
    help: error.details.help ?? "awb --help"
  } };
}

export function errorDiagnostic(error: CliError): string {
  const value = errorObject(error).error;
  const context = Object.entries(value.context).map(([key, item]) => `${key}=${escapeDisplayText(String(item))}`).join(" ");
  return `[${value.category}] ${value.message}\n阶段：${value.phase}；effect=${value.effect}${context ? `；${context}` : ""}\n帮助：${value.help}\n`;
}

export function responseError(message: string): CliError { return new CliError(6, message); }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
