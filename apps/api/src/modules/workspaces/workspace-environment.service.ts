import { Value } from "@sinclair/typebox/value";
import {
  CreateWorkspaceEnvironmentVariableRequestSchema, UpdateWorkspaceEnvironmentVariableRequestSchema,
  WorkspaceEnvironmentVariableSchema, validateWorkspaceEnvironmentCollection, validateWorkspaceEnvironmentInput,
  type CreateWorkspaceEnvironmentVariableRequest, type UpdateWorkspaceEnvironmentVariableRequest,
  type WorkspaceEnvironmentVariable, type WorkspaceEnvironmentPolicyIssue
} from "@agent-workbench/shared";
import type { AppContext } from "../../app/context.js";
import { HttpError } from "../../app/errors.js";
import type { Db } from "../../infra/db/db.js";
import { encryptUtf8, decryptToUtf8 } from "../../infra/crypto/secretBox.js";
import { workspaceLifecycleCoordinator } from "../../infra/locks/workspace-lifecycle-coordinator.js";
import { workspaceDeletingFence } from "../agent/lifecycle/workspace-deleting-fence.js";
import { newId } from "../../utils/ids.js";
import { WorkspaceEnvironmentStore, type WorkspaceEnvironmentRow } from "./workspace-environment.store.js";

type Environment = Readonly<Record<string, string>>;
type CryptoOperations = { encrypt: typeof encryptUtf8; decrypt: typeof decryptToUtf8 };
const defaultCrypto: CryptoOperations = { encrypt: encryptUtf8, decrypt: decryptToUtf8 };
const policyMessages = {
  WORKSPACE_ENV_INVALID_INPUT: "Invalid Workspace environment variable input.",
  WORKSPACE_ENV_RESERVED_NAME: "Workspace environment variable name is reserved.",
  WORKSPACE_ENV_LIMIT_EXCEEDED: "Workspace environment variable limit exceeded."
};
function inputError(issue?: WorkspaceEnvironmentPolicyIssue): HttpError {
  const code = issue?.code ?? "WORKSPACE_ENV_INVALID_INPUT";
  return new HttpError(400, policyMessages[code], code);
}
function invalidConfig(): HttpError {
  return new HttpError(500, "Workspace environment configuration is invalid.", "WORKSPACE_ENV_INVALID_CONFIG");
}

/** Application-owned service: no global environment or process-wide configuration cache. */
export class WorkspaceEnvironmentService {
  private readonly cache = new Map<string, Environment>();
  private readonly store: WorkspaceEnvironmentStore;

  constructor(private readonly db: Db, private readonly masterKey: Buffer, private readonly crypto: CryptoOperations = defaultCrypto) {
    this.store = new WorkspaceEnvironmentStore(db);
  }

  invalidate(workspaceId: string): void { this.cache.delete(workspaceId); }

  /** Synchronous cache hit/miss and synchronous invalidation intentionally have no await gap. */
  readEnvironment(workspaceId: string): Environment {
    workspaceDeletingFence.assertWritable(workspaceId);
    if (this.cache.has(workspaceId)) {
      const env = this.cache.get(workspaceId)!;
      this.cache.delete(workspaceId);
      this.cache.set(workspaceId, env);
      return env;
    }
    return this.readBoundary(() => {
      this.assertWorkspace(workspaceId);
      const variables = this.decodeCollection(this.store.list(workspaceId));
      const env: Record<string, string> = Object.create(null);
      for (const variable of variables) if (variable.enabled) env[variable.name] = variable.value;
      const snapshot = Object.freeze(env);
      this.cache.set(workspaceId, snapshot);
      if (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
      return snapshot;
    });
  }

  list(workspaceId: string): WorkspaceEnvironmentVariable[] {
    workspaceDeletingFence.assertWritable(workspaceId);
    return this.readBoundary(() => {
      this.assertWorkspace(workspaceId);
      return this.decodeCollection(this.store.list(workspaceId));
    });
  }

  async create(workspaceId: string, request: CreateWorkspaceEnvironmentVariableRequest): Promise<WorkspaceEnvironmentVariable> {
    if (!Value.Check(CreateWorkspaceEnvironmentVariableRequestSchema, request)) throw inputError();
    const input = { ...request, remark: request.remark ?? "", enabled: request.enabled ?? true };
    const issue = validateWorkspaceEnvironmentInput(input);
    if (issue) throw inputError(issue);
    return this.write(workspaceId, () => {
      const previous = this.decodeCollection(this.store.list(workspaceId));
      const now = Date.now();
      const variable: WorkspaceEnvironmentVariable = { id: newId("wev"), workspaceId, ...input, createdAt: now, updatedAt: now };
      this.assertCandidate([...previous, variable]);
      this.store.insert(this.encode(variable));
      return variable;
    });
  }

  async update(workspaceId: string, variableId: string, request: UpdateWorkspaceEnvironmentVariableRequest): Promise<WorkspaceEnvironmentVariable> {
    if (!Value.Check(UpdateWorkspaceEnvironmentVariableRequestSchema, request)) throw inputError();
    return this.write(workspaceId, () => {
      const rows = this.store.list(workspaceId);
      const target = rows.find((row) => row.id === variableId);
      if (!target) throw new HttpError(404, "Workspace environment variable not found.", "WORKSPACE_ENV_VARIABLE_NOT_FOUND");
      // An explicit replacement value can repair damaged target ciphertext. Other rows still must validate.
      const previous = this.decodeCollection(rows.filter((row) => row.id !== variableId));
      const value = Object.hasOwn(request, "value") ? request.value! : this.decrypt(target);
      const variable: WorkspaceEnvironmentVariable = {
        id: target.id, workspaceId: target.workspaceId,
        name: Object.hasOwn(request, "name") ? request.name! : target.name,
        value,
        remark: Object.hasOwn(request, "remark") ? request.remark! : target.remark,
        enabled: Object.hasOwn(request, "enabled") ? request.enabled! : this.decodeEnabled(target.enabled),
        createdAt: target.createdAt, updatedAt: Date.now()
      };
      const issue = validateWorkspaceEnvironmentInput(variable);
      if (issue) {
        // Invalid submitted fields are input errors; invalid untouched persisted fields are configuration errors.
        if (Object.hasOwn(request, issue.field)) throw inputError(issue);
        throw invalidConfig();
      }
      if (!Value.Check(WorkspaceEnvironmentVariableSchema, variable)) throw invalidConfig();
      this.assertCandidate([...previous, variable]);
      const row = Object.hasOwn(request, "value") ? this.encode(variable) : { ...target, name: variable.name, remark: variable.remark, enabled: Number(variable.enabled), updatedAt: variable.updatedAt };
      this.store.update(row);
      return variable;
    });
  }

  async delete(workspaceId: string, variableId: string): Promise<void> {
    return this.write(workspaceId, () => {
      const rows = this.store.list(workspaceId);
      if (!rows.some((row) => row.id === variableId)) throw new HttpError(404, "Workspace environment variable not found.", "WORKSPACE_ENV_VARIABLE_NOT_FOUND");
      this.decodeCollection(rows.filter((row) => row.id !== variableId));
      this.store.delete(workspaceId, variableId);
    });
  }

  private assertWorkspace(workspaceId: string): void {
    if (!this.store.workspaceExists(workspaceId)) throw new HttpError(404, "Workspace not found.", "WORKSPACE_NOT_FOUND");
    if (this.store.workspaceDeleting(workspaceId)) throw new HttpError(409, "Workspace is being deleted.", "WORKSPACE_DELETING");
  }

  private decodeEnabled(enabled: number): boolean {
    if (enabled !== 0 && enabled !== 1) throw invalidConfig();
    return enabled === 1;
  }

  private decrypt(row: WorkspaceEnvironmentRow): string {
    if (typeof row.valueEnc !== "string") throw invalidConfig();
    try { return this.crypto.decrypt({ key: this.masterKey, ciphertext: row.valueEnc }); }
    catch { throw new HttpError(500, "Workspace environment value could not be decrypted.", "WORKSPACE_ENV_DECRYPT_FAILED"); }
  }

  private decodeCollection(rows: WorkspaceEnvironmentRow[]): WorkspaceEnvironmentVariable[] {
    const variables = rows.map((row) => {
      const variable = {
        id: row.id, workspaceId: row.workspaceId, name: row.name, value: this.decrypt(row),
        remark: row.remark, enabled: this.decodeEnabled(row.enabled), createdAt: row.createdAt, updatedAt: row.updatedAt
      };
      if (!Value.Check(WorkspaceEnvironmentVariableSchema, variable)) throw invalidConfig();
      return variable;
    });
    if (validateWorkspaceEnvironmentCollection(variables)) throw invalidConfig();
    return variables;
  }

  private assertCandidate(variables: WorkspaceEnvironmentVariable[]): void {
    const issue = validateWorkspaceEnvironmentCollection(variables);
    if (issue) throw inputError(issue);
    const names = new Set<string>();
    for (const variable of variables) {
      if (names.has(variable.name)) throw new HttpError(409, "Workspace environment variable name already exists.", "WORKSPACE_ENV_NAME_CONFLICT");
      names.add(variable.name);
    }
  }

  private encode(variable: WorkspaceEnvironmentVariable): WorkspaceEnvironmentRow {
    try {
      const { value, ...rest } = variable;
      return { ...rest, enabled: Number(variable.enabled), valueEnc: this.crypto.encrypt({ key: this.masterKey, plaintext: value }) };
    } catch { throw new HttpError(500, "Workspace environment value could not be stored.", "WORKSPACE_ENV_PERSIST_FAILED"); }
  }

  private readBoundary<T>(read: () => T): T {
    try { return read(); }
    catch (error) { throw this.safeError(error, false); }
  }

  private async write<T>(workspaceId: string, mutation: () => T): Promise<T> {
    return workspaceLifecycleCoordinator.withMutation(workspaceId, async () => {
      let callbackFailed = false;
      let callbackError: unknown;
      try {
        const result = this.db.transaction(() => {
          try {
            this.assertWorkspace(workspaceId);
            return mutation();
          } catch (error) {
            callbackFailed = true;
            callbackError = error;
            throw error;
          }
        })();
        this.invalidate(workspaceId);
        return result;
      } catch (error) {
        // Preserve a valid snapshot only when the callback failed and its original
        // error escaped a completed rollback. Entry/commit/rollback failures may
        // have an uncertain outcome; a no-TTL cache must not retain the old value.
        const knownRollback = callbackFailed && error === callbackError && !this.db.inTransaction;
        if (!knownRollback) this.invalidate(workspaceId);
        throw this.safeError(error, true);
      }
    });
  }

  private safeError(error: unknown, writing: boolean): HttpError {
    if (error instanceof HttpError) return error;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "SQLITE_CONSTRAINT_UNIQUE") return new HttpError(409, "Workspace environment variable name already exists.", "WORKSPACE_ENV_NAME_CONFLICT");
    if (!writing || (typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")))) {
      return new HttpError(503, "Workspace environment configuration is unavailable.", "WORKSPACE_ENV_UNAVAILABLE");
    }
    return new HttpError(500, "Workspace environment configuration could not be stored.", "WORKSPACE_ENV_PERSIST_FAILED");
  }
}

/** The context owns its service; distinct app/DB instances never share cached plaintext. */
export function getWorkspaceEnvironmentService(ctx: AppContext): WorkspaceEnvironmentService {
  return ctx.workspaceEnvironment ??= new WorkspaceEnvironmentService(ctx.db, ctx.credentialMasterKey);
}
