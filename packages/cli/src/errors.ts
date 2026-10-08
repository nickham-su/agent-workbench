export type CliExitCode = 0 | 2 | 3 | 4 | 5 | 6 | 7;

const categories: Record<Exclude<CliExitCode, 0>, string> = {
  2: "USAGE",
  3: "CONFIG",
  4: "AUTH",
  5: "NETWORK",
  6: "RESPONSE",
  7: "PERSISTENCE"
};

/** Messages are authored locally. Never pass an exception or response body here. */
export class CliError extends Error {
  constructor(readonly exitCode: Exclude<CliExitCode, 0>, message: string) {
    super(message);
    this.name = "CliError";
  }
}

export function errorDiagnostic(error: CliError): string {
  return `[${categories[error.exitCode]}] ${error.message}\n`;
}

export function responseError(message: string): CliError {
  return new CliError(6, message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
