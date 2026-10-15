/** The single browser/Node policy for Workspace environment configuration. */
export const WORKSPACE_ENVIRONMENT_LIMITS = Object.freeze({
  nameLength: 128,
  valueBytes: 16 * 1024,
  remarkLength: 160,
  variables: 128,
  totalBytes: 64 * 1024
});

const RESERVED_NAMES = new Set([
  "GIT_TERMINAL_PROMPT", "GIT_ASKPASS", "GIT_ASKPASS_USERNAME", "GIT_ASKPASS_TOKEN_FILE",
  "GIT_ASKPASS_TOKEN", "SSH_ASKPASS", "GIT_SSH_COMMAND", "GIT_SSH", "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS"
]);

export function isWorkspaceEnvironmentReservedName(name: string): boolean {
  return name.startsWith("AWB_") || name.startsWith("GIT_CONFIG_KEY_") ||
    name.startsWith("GIT_CONFIG_VALUE_") || RESERVED_NAMES.has(name);
}

export type WorkspaceEnvironmentPolicyIssue = {
  code: "WORKSPACE_ENV_INVALID_INPUT" | "WORKSPACE_ENV_RESERVED_NAME" | "WORKSPACE_ENV_LIMIT_EXCEEDED";
  field: "name" | "value" | "remark" | "enabled" | "variables";
};
export type WorkspaceEnvironmentInput = { name: string; value: string; remark: string; enabled: boolean };

/** Reject isolated UTF-16 surrogates rather than silently replacing them on UTF-8 encoding. */
export function isWorkspaceEnvironmentUnicodeValid(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function workspaceEnvironmentUtf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Does not trim, expand, normalize, or echo supplied values. */
export function validateWorkspaceEnvironmentInput(input: WorkspaceEnvironmentInput): WorkspaceEnvironmentPolicyIssue | null {
  if (typeof input.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.name)) {
    return { code: "WORKSPACE_ENV_INVALID_INPUT", field: "name" };
  }
  if (input.name.length > WORKSPACE_ENVIRONMENT_LIMITS.nameLength) return { code: "WORKSPACE_ENV_LIMIT_EXCEEDED", field: "name" };
  if (isWorkspaceEnvironmentReservedName(input.name)) return { code: "WORKSPACE_ENV_RESERVED_NAME", field: "name" };
  for (const field of ["value", "remark"] as const) {
    const value = input[field];
    if (typeof value !== "string" || value.includes("\0") || !isWorkspaceEnvironmentUnicodeValid(value)) {
      return { code: "WORKSPACE_ENV_INVALID_INPUT", field };
    }
  }
  if (workspaceEnvironmentUtf8Bytes(input.value) > WORKSPACE_ENVIRONMENT_LIMITS.valueBytes) return { code: "WORKSPACE_ENV_LIMIT_EXCEEDED", field: "value" };
  if (input.remark.length > WORKSPACE_ENVIRONMENT_LIMITS.remarkLength) return { code: "WORKSPACE_ENV_LIMIT_EXCEEDED", field: "remark" };
  if (typeof input.enabled !== "boolean") return { code: "WORKSPACE_ENV_INVALID_INPUT", field: "enabled" };
  return null;
}

/** Includes disabled entries, which must remain valid and count towards limits. */
export function validateWorkspaceEnvironmentCollection(inputs: readonly WorkspaceEnvironmentInput[]): WorkspaceEnvironmentPolicyIssue | null {
  if (inputs.length > WORKSPACE_ENVIRONMENT_LIMITS.variables) return { code: "WORKSPACE_ENV_LIMIT_EXCEEDED", field: "variables" };
  let bytes = 0;
  for (const input of inputs) {
    const issue = validateWorkspaceEnvironmentInput(input);
    if (issue) return issue;
    bytes += workspaceEnvironmentUtf8Bytes(input.name) + 1 + workspaceEnvironmentUtf8Bytes(input.value) + 1;
  }
  return bytes > WORKSPACE_ENVIRONMENT_LIMITS.totalBytes ? { code: "WORKSPACE_ENV_LIMIT_EXCEEDED", field: "variables" } : null;
}
