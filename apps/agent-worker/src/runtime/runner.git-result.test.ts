import assert from "node:assert/strict";
import test from "node:test";
import type { GitToolResult } from "@agent-workbench/shared/internal-contracts/agent-api";
import { buildToolSuccessTextForTest } from "./runner.js";
import { successfulGitProcessResult } from "./git.testkit.js";

const base: GitToolResult = { ...successfulGitProcessResult, repo: "fixture-repo", leaseDisposition: "released", warnings: [] };
const secretArgs = { repo: "fixture-repo", args: ["fixture-secret-argv", "/private-fixture-lease"] };
for (const [name, result, expected] of [
  ["success", base, ["ok: true", "exit_code: 0", "process_stop_confirmed: true", "lease_disposition: released"]],
  ["nonzero", { ...base, ok: false, exitCode: 128, stderr: "fatal: fixture diagnostic" }, ["ok: false", "exit_code: 128", "fatal: fixture diagnostic"]],
  ["signal", { ...base, ok: false, exitCode: null, signal: "SIGTERM", cancelled: true }, ["ok: false", "exit_code: null", "signal: SIGTERM", "cancelled: true"]],
  ["unconfirmed parent-zero", { ...base, ok: false, processStopConfirmed: false, failureCode: "GIT_PROCESS_STOP_UNCONFIRMED", leaseDisposition: "retained" }, ["ok: false", "exit_code: 0", "process_stop_confirmed: false", "lease_disposition: retained", "may require maintenance"]],
  ["cleanup unconfirmed", { ...base, leaseDisposition: "release_unconfirmed", warnings: ["LEASE_CLEANUP_FAILED"] }, ["ok: true", "lease_disposition: release_unconfirmed", "LEASE_CLEANUP_FAILED", "Do not repeat Git"]],
] as const) {
  test(`Git result text: ${name}`, () => {
    const text = buildToolSuccessTextForTest({ toolName: "git", args: secretArgs, result, completedAt: 0 });
    for (const value of expected) assert(text.includes(value), value);
    assert(!text.includes("fixture-secret-argv")); assert(!text.includes("/private-fixture-lease"));
    assert(!text.includes("env:")); assert(!text.includes("command:"));
  });
}

test("Git result text rejects malformed structured metadata instead of rendering raw fields", () => {
  assert.throws(() => buildToolSuccessTextForTest({ toolName: "git", args: secretArgs, result: { ...base, env: secretArgs }, completedAt: 0 }), /invalid git result/);
});
