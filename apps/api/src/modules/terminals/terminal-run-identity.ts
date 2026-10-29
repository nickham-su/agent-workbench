import fs from "node:fs/promises";
import { HttpError } from "../../app/errors.js";

const bootIdPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const identityPattern = new RegExp(`^${bootIdPattern}:(?:0|[1-9][0-9]*)$`);
export function isTerminalRunIdentity(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && identityPattern.test(value);
}

/** PID 1 outlives API restarts, but is replaced on a container/machine restart.
 * boot_id separates machine boots; starttime stays in its original clock ticks.
 * Requires one owner of the data directory and the default private PID namespace.
 */
export async function readTerminalRunIdentity(
  readText: (file: string) => Promise<string> = (file) => fs.readFile(file, "utf8"),
): Promise<string> {
  try {
    const bootId = (await readText("/proc/sys/kernel/random/boot_id")).trim();
    const stat = (await readText("/proc/1/stat")).trim();
    // comm can contain spaces, newlines and ')': fields resume after its last ')'.
    const end = stat.lastIndexOf(")");
    if (!stat.startsWith("1 (") || end < 3 || stat[end + 1] !== " ") throw new Error();
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    // Supported Linux kernels expose at least fields 3..52; reject truncation.
    if (fields.length < 50 || !/^[A-Za-z]$/.test(fields[0]!)
      || !fields.slice(1).every((field) => /^-?[0-9]+$/.test(field))) throw new Error();
    const identity = `${bootId}:${fields[19]}`;
    if (!isTerminalRunIdentity(identity)) throw new Error();
    return identity;
  } catch {
    // Never expose raw procfs data or filesystem errors.
    throw new HttpError(503, "The terminal runtime identity could not be confirmed. No new run was started.", "TERMINAL_RUN_IDENTITY_UNAVAILABLE");
  }
}
