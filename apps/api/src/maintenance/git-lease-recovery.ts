import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { Value } from "@sinclair/typebox/value";
import { RepoGitEnvLeaseIdSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../app/errors.js";
import { inspectRepoGitEnvLease, listRepoGitEnvLeaseIds, releaseRepoGitEnvLeaseForMaintenance, type RepoGitEnvLeaseInspection } from "../modules/git-env/git-env.lease.js";
import { assertRepoGitEnvMaintenanceRequest } from "../modules/git-env/git-env.recovery-policy.js";

const HELP = `Git lease maintenance (local filesystem only; never starts API or Workers).
Usage:
  npm run maintenance:git-lease -- [inspect] [--data-dir DIR] [--lease-id ID]
  npm run maintenance:git-lease -- release --data-dir DIR --lease-id ID
    --expected-state unconfirmed|stopped|unreadable --expected-owner JSON_OR_null
    --window known_scope|managed_environment_stopped|reboot_before_services
    --evidence-ref SAFE_RECORD_ID [--known-pids N,N] [--known-pgids N,N]
    --confirm-services-stopped --confirm-startup-disabled
    --confirm-exclusive-window --confirm-coverage

Data directory: explicit --data-dir, otherwise AWB_DATA_DIR, otherwise .data.
No .env, credential database, token or key is read. Use the same physical data
root and OS identity as the deployment. Release requires typing RELEASE <ID>.
All confirmations are operator assertions, NOT facts this helper can discover:
  known_scope: current reliable scope covers ALL target execution and launchers;
    readable metadata and at least one known PID/PGID are required.
  managed_environment_stopped: deployment evidence proves the entire managed
    environment covers ALL execution, including detached groups, and is stopped.
  reboot_before_services: a reboot has completed after disabling automatic start;
    API, Workers and all other launchers have NOT started since that reboot.
Keep the window exclusive and automatic restart disabled until this CLI exits.
Unknown metadata/scope cannot use known_scope. An absent numeric PID/PGID does
not prove identity, completeness, supervisor state or host quiescence. Without
applicable deployment evidence keep the lease held; never use recursive rm.
`;

const VALUE_FLAGS = new Set(["data-dir", "lease-id", "expected-state", "expected-owner", "window", "evidence-ref", "known-pids", "known-pgids"]);
const CONFIRM_FLAGS = new Set(["confirm-services-stopped", "confirm-startup-disabled", "confirm-exclusive-window", "confirm-coverage"]);
type CliIO = { input: Readable; output: Writable; error: Writable };
type Services = {
  list: typeof listRepoGitEnvLeaseIds;
  inspect: typeof inspectRepoGitEnvLease;
  release: typeof releaseRepoGitEnvLeaseForMaintenance;
};
const services: Services = { list: listRepoGitEnvLeaseIds, inspect: inspectRepoGitEnvLease, release: releaseRepoGitEnvLeaseForMaintenance };
function invalid(): never { throw new HttpError(400, "Invalid maintenance arguments; use --help. No lease was released.", "GIT_LEASE_MAINTENANCE_INVALID"); }
function parse(argv: string[]) {
  const values = new Map<string, string | true>();
  let mode = "inspect";
  if (argv[0] && !argv[0].startsWith("--")) mode = argv.shift()!;
  if (mode !== "inspect" && mode !== "release") invalid();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!.startsWith("--") ? argv[i]!.slice(2) : "";
    if (values.has(key)) invalid();
    if (CONFIRM_FLAGS.has(key)) { values.set(key, true); continue; }
    if (!VALUE_FLAGS.has(key) || argv[i + 1] === undefined || argv[i + 1]!.startsWith("--")) invalid();
    values.set(key, argv[++i]!);
  }
  if (mode === "inspect" && [...values.keys()].some((key) => key !== "data-dir" && key !== "lease-id")) invalid();
  return { mode, values };
}
function ids(value: string | true | undefined) {
  if (value === undefined) return [];
  if (typeof value !== "string" || !/^[0-9]+(?:,[0-9]+)*$/.test(value)) invalid();
  return value.split(",").map(Number);
}
function safeInspection(inspection: RepoGitEnvLeaseInspection | null, leaseId: string) {
  const meta = inspection?.meta;
  return {
    leaseId, state: inspection?.state ?? "missing",
    owner: meta ? { workspaceId: meta.workspaceId, sessionId: meta.sessionId, runId: meta.runId, toolExecutionId: meta.toolExecutionId } : null,
    ...(meta ? { repo: meta.repo, createdAt: meta.createdAt, expiresAt: meta.expiresAt } : {}),
    processScope: "Not stored. Reliable scope and maintenance-window evidence must be supplied by the operator.",
  };
}

/** Dependency seam is for CLI tests, not a remote or configurable service surface. */
export async function runGitLeaseRecoveryCli(argv: string[], options: {
  io?: CliIO; env?: Pick<NodeJS.ProcessEnv, "AWB_DATA_DIR">; services?: Services;
} = {}): Promise<number> {
  const io = options.io ?? { input: process.stdin, output: process.stdout, error: process.stderr };
  const local = options.services ?? services;
  try {
    if (argv.length === 1 && argv[0] === "--help") { io.output.write(HELP); return 0; }
    const { mode, values } = parse([...argv]);
    const selected = values.get("data-dir") ?? (options.env ?? process.env).AWB_DATA_DIR?.trim() ?? ".data";
    if (typeof selected !== "string" || !selected || selected.includes("\0")) invalid();
    const dataDir = path.resolve(selected);
    // A configured physical root is authority; do not follow a disguised ancestor.
    if (await fs.realpath(dataDir) !== dataDir) throw new HttpError(409, "Use the trusted physical data root, not a symbolic link.", "GIT_LEASE_STATE_UNAVAILABLE");
    const leaseId = values.get("lease-id");
    if (leaseId !== undefined && !Value.Check(RepoGitEnvLeaseIdSchema, leaseId)) invalid();
    if (mode === "inspect") {
      const targets = leaseId === undefined ? await local.list(dataDir) : [leaseId as string];
      for (const id of targets) io.output.write(`${JSON.stringify(safeInspection(await local.inspect({ dataDir, leaseId: id }), id))}\n`);
      if (targets.length === 0) io.output.write("No v2 Git leases. Process scope is not inferred from this result.\n");
      return 0;
    }
    let expectedOwner: unknown;
    try { expectedOwner = JSON.parse(String(values.get("expected-owner"))); } catch { invalid(); }
    const request = {
      leaseId, expectedState: values.get("expected-state"), expectedOwner,
      window: values.get("window"), evidenceRef: values.get("evidence-ref"),
      servicesStopped: values.get("confirm-services-stopped") === true,
      startupDisabled: values.get("confirm-startup-disabled") === true,
      exclusiveWindow: values.get("confirm-exclusive-window") === true,
      coverageVerified: values.get("confirm-coverage") === true,
      knownPids: ids(values.get("known-pids")), knownPgids: ids(values.get("known-pgids")),
      confirmedLeaseId: leaseId,
    };
    // Reject incomplete evidence before asking for an interactive confirmation.
    assertRepoGitEnvMaintenanceRequest(request);
    io.output.write(`${JSON.stringify(safeInspection(await local.inspect({ dataDir, leaseId: request.leaseId }), request.leaseId))}\n`);
    io.output.write(`Window ${request.window}; evidence ${request.evidenceRef}. Operator confirms coverage, services stopped, automatic start disabled and exclusive window. The helper cannot prove these facts.\nType RELEASE ${request.leaseId} to release only this lease: `);
    const lines = createInterface({ input: io.input, terminal: false });
    try {
      const answer = await lines[Symbol.asyncIterator]().next();
      if (answer.done || answer.value !== `RELEASE ${request.leaseId}`) {
        throw new HttpError(409, "Exact interactive lease confirmation is required; keep the lease protected.", "GIT_LEASE_MAINTENANCE_CONFIRMATION_REQUIRED");
      }
    } finally { lines.close(); }
    const result = await local.release({ dataDir, request });
    io.output.write(`${JSON.stringify({ ...result, leaseId: request.leaseId, window: request.window, evidenceRef: request.evidenceRef, completedAt: new Date().toISOString(), operatorAssertionsOnly: true })}\n`);
    return 0;
  } catch (error) {
    // Never print Error.message/cause from the filesystem, JSON or arbitrary I/O.
    io.error.write(`${error instanceof HttpError ? error.code : "GIT_LEASE_STATE_UNAVAILABLE"}: maintenance refused or incomplete; keep remaining leases protected and consult --help.\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runGitLeaseRecoveryCli(process.argv.slice(2));
}
