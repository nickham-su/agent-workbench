import { isWorkspaceEnvironmentUnicodeValid, TERMINAL_CONFIG_COMMAND_MAX_LENGTH } from "@agent-workbench/shared";
import { terminalEnvironmentProtocolError } from "./terminal-env-launch.protocol.js";

export const TERMINAL_STARTUP_BOOTSTRAP_NAME = "startup.bash";
export const TERMINAL_STARTUP_BOOTSTRAP_MAX_BYTES = 4 * TERMINAL_CONFIG_COMMAND_MAX_LENGTH + 4096;
/** Shell single quoting preserves newlines, heredocs, Unicode and literal metacharacters. */
function quote(value: string) { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function buildTerminalStartupBootstrap(command: string, attemptId: string): string {
  if (!command.trim() || command.length > TERMINAL_CONFIG_COMMAND_MAX_LENGTH || command.includes("\0") || !isWorkspaceEnvironmentUnicodeValid(command)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(attemptId)) terminalEnvironmentProtocolError();
  // FD 3 is an already opened regular file, NOT a Node pipe. FD 4 is the one-shot
  // consumption acknowledgement. No user command ever appears in launcher argv.
  // Do not replace PROMPT_COMMAND or install traps: keep the user's normal shell hooks.
  return [
    "# Private one-shot interactive Bash initialization.",
    'if [[ -f "$HOME/.bashrc" ]]; then builtin source "$HOME/.bashrc"; fi',
    "builtin unset __awb_terminal_startup_command || builtin exit 1",
    `__awb_terminal_startup_command=${quote(command)}`,
    `builtin printf '%s\\n' ${quote(attemptId)} >&4 || builtin exit 1`,
    "builtin exec 4>&- 3<&-",
    'builtin history -s -- "$__awb_terminal_startup_command"',
    // Expansion captures the complete command before eval unsets the temporary
    // variable; no trailing cleanup command masks the startup command's status.
    'builtin eval -- "builtin unset __awb_terminal_startup_command; $__awb_terminal_startup_command"',
    ""
  ].join("\n");
}
