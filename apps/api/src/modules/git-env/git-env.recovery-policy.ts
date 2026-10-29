import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { RepoGitEnvLeaseIdSchema, RepoGitEnvLeaseOwnerSchema } from "@agent-workbench/shared/internal-contracts/agent-api";
import { HttpError } from "../../app/errors.js";

const ProcessIdsSchema = Type.Array(Type.Integer({ minimum: 2, maximum: 2_147_483_647 }), { maxItems: 64, uniqueItems: true });
/** Local service input only. Never register this schema on a Worker HTTP route. */
export const RepoGitEnvMaintenanceRequestSchema = Type.Object({
  leaseId: RepoGitEnvLeaseIdSchema,
  expectedState: Type.Union([Type.Literal("unconfirmed"), Type.Literal("stopped"), Type.Literal("unreadable")]),
  expectedOwner: Type.Union([RepoGitEnvLeaseOwnerSchema, Type.Null()]),
  window: Type.Union([Type.Literal("known_scope"), Type.Literal("managed_environment_stopped"), Type.Literal("reboot_before_services")]),
  evidenceRef: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$" }),
  servicesStopped: Type.Literal(true),
  startupDisabled: Type.Literal(true),
  exclusiveWindow: Type.Literal(true),
  coverageVerified: Type.Literal(true),
  knownPids: ProcessIdsSchema,
  knownPgids: ProcessIdsSchema,
  confirmedLeaseId: RepoGitEnvLeaseIdSchema,
}, { additionalProperties: false });
export type RepoGitEnvMaintenanceRequest = Static<typeof RepoGitEnvMaintenanceRequestSchema>;
export type MaintenanceProcessProbe = (pid: number, signal: 0) => unknown;

function refused(code: string, message: string): never { throw new HttpError(409, message, code); }

export function assertRepoGitEnvMaintenanceRequest(value: unknown): asserts value is RepoGitEnvMaintenanceRequest {
  if (!Value.Check(RepoGitEnvMaintenanceRequestSchema, value)) {
    refused("GIT_LEASE_MAINTENANCE_INVALID", "A single lease, exact expectations and all maintenance confirmations are required.");
  }
  if (value.confirmedLeaseId !== value.leaseId
    || (value.expectedState === "unreadable") !== (value.expectedOwner === null)) {
    refused("GIT_LEASE_MAINTENANCE_INVALID", "Lease confirmation and expected owner/state must agree.");
  }
  if (value.window === "known_scope"
    && (value.expectedState === "unreadable" || value.knownPids.length + value.knownPgids.length === 0)) {
    refused("GIT_LEASE_MAINTENANCE_EVIDENCE_REQUIRED", "Unknown metadata or incomplete execution scope requires a verified complete maintenance window.");
  }
}

/** Bounded existence observations only; never kills, enumerates, or proves scope completeness. */
export function assertKnownMaintenanceProcessesAbsent(request: RepoGitEnvMaintenanceRequest, probe: MaintenanceProcessProbe = process.kill) {
  for (const pid of [...request.knownPids, ...request.knownPgids.map((pgid) => -pgid)]) {
    try { probe(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ESRCH") continue;
      refused("GIT_LEASE_MAINTENANCE_PROCESS_UNKNOWN", "A known process cannot be checked; keep the lease protected.");
    }
    refused("GIT_LEASE_MAINTENANCE_PROCESS_PRESENT", "A known process or group still exists; keep the lease protected.");
  }
}
