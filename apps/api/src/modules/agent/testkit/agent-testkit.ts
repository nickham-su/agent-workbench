import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { RepoRecord, WorkspaceRecord } from "@agent-workbench/shared";
import { createApp as createDefaultApp } from "../../../app/createApp.js";
import type { AppContext } from "../../../app/context.js";
import { openDb, type Db } from "../../../infra/db/db.js";
import { ensureDir, rmrf } from "../../../infra/fs/fs.js";
import { repoMirrorPath, workspaceRepoDirPath, workspaceRoot } from "../../../infra/fs/paths.js";
import { newSortableId } from "../../../utils/ids.js";
import { insertRepo } from "../../repos/repo.store.js";
import { insertWorkspace, insertWorkspaceRepo, type WorkspaceRepoRecord } from "../../workspaces/workspace.store.js";
import type { AgentRuntimePort, AgentRuntimeRun } from "../agent.runtime-port.js";

const DEFAULT_INTERNAL_TOKEN = "test-internal-token";

export type AgentTestFixture = {
  dataDir: string;
  db: Db;
  ctx: AppContext;
  app: FastifyInstance | null;
  repoRoot: string;
  internalToken: string;
  dispose(): Promise<void>;
};

export type CreateAgentTestFixtureOptions = {
  /**
   * Repository root. When omitted, the helper expects to run from `apps/api`,
   * matching the existing API integration-test cwd convention.
   */
  repoRoot?: string;
  /** Prefix for the directory created below `<repoRoot>/.tmp-tests`. */
  dataDirPrefix?: string;
  /** Create and ready a real Fastify application. Defaults to false. */
  withApp?: boolean;
  /**
   * Testkit self-test hook for fixture-construction failure coverage. It is
   * consulted only with `withApp: true`; ordinary API tests use real createApp.
   */
  appFactory?: (ctx: AppContext) => Promise<FastifyInstance>;
  /** Enables real cookie auth before the app registers its global auth guard. */
  authToken?: string | null;
  /** Explicitly controls the otherwise fixed local-runtime concurrency default (2). */
  agentWorkerConcurrency?: number;
};

export type CreateTestWorkspaceOptions = {
  id?: string;
  dirName?: string;
  title?: string;
  path?: string;
  terminalCredentialId?: string | null;
  createdAt?: number;
  updatedAt?: number;
};

export type TestRepository = {
  repo: RepoRecord;
  workspaceRepo: WorkspaceRepoRecord;
};

export type CreateTestRepositoryOptions = {
  workspace: WorkspaceRecord;
  id?: string;
  dirName?: string;
  path?: string;
  url?: string;
  defaultBranch?: string | null;
  createdAt?: number;
  updatedAt?: number;
};

export type InjectJsonOptions = {
  method: string;
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  /** Always explicit: this helper never obtains a token from a fixture. */
  internalToken: string;
};

export type FakeAgentRuntimeOptions = {
  enqueueRunError?: unknown | (() => unknown);
  cancelSessionError?: unknown | (() => unknown);
  onEnqueueRun?: (run: AgentRuntimeRun) => void | Promise<void>;
  onCancelSession?: (sessionId: string) => void | Promise<void>;
};

export type FakeAgentRuntime = AgentRuntimePort & {
  enqueueRunCalls: AgentRuntimeRun[];
  cancelSessionCalls: string[];
};

async function cleanupFixtureResources(params: {
  app: FastifyInstance | null;
  db: Db | null;
  dataDir: string;
}) {
  const failures: unknown[] = [];
  if (params.app) {
    try {
      await params.app.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (params.db) {
    try {
      params.db.close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await rmrf(params.dataDir);
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

function rethrowFixtureInitializationFailure(cause: unknown, cleanupFailures: unknown[], dataDir: string): never {
  if (cleanupFailures.length === 0) throw cause;
  throw new AggregateError(
    cleanupFailures,
    `Agent test fixture initialization failed and cleanup also failed at ${dataDir}`,
    { cause }
  );
}

/**
 * Resolves the repository root using the existing API integration-test cwd
 * convention. Callers with another cwd must pass `repoRoot` explicitly.
 */
export async function resolveAgentApiTestRepoRoot(cwd = process.cwd()) {
  const repoRoot = path.resolve(cwd, "../..");
  try {
    await fs.access(path.join(repoRoot, "apps", "api", "package.json"));
  } catch {
    throw new Error(
      `Unable to resolve Agent API repository root from cwd ${cwd}. Run the test from apps/api or pass repoRoot explicitly.`
    );
  }
  return repoRoot;
}

/**
 * Creates a real SQLite-backed fixture. The caller owns the fixture and must
 * call dispose() (normally from afterEach); dispose closes the app, closes the
 * database, and removes dataDir even when an earlier cleanup step fails.
 */
export async function createAgentTestFixture(options: CreateAgentTestFixtureOptions = {}): Promise<AgentTestFixture> {
  const repoRoot = options.repoRoot ?? await resolveAgentApiTestRepoRoot();
  const testsRoot = path.join(repoRoot, ".tmp-tests");
  await ensureDir(testsRoot);
  const dataDir = await fs.mkdtemp(path.join(testsRoot, options.dataDirPrefix ?? "agent-testkit-"));
  let db: Db | null = null;
  let app: FastifyInstance | null = null;

  try {
    db = await openDb(dataDir);
    const fixtureDb = db;
    const internalToken = DEFAULT_INTERNAL_TOKEN;
    const ctx: AppContext = {
      db: fixtureDb,
      repoRoot,
      dataDir,
      fileMaxBytes: 1024 * 1024,
      version: "test",
      logLevel: "error",
      serveWeb: false,
      webDistDir: null,
      preview: { enabled: false, runtime: null },
      credentialMasterKey: Buffer.alloc(32, 7),
      credentialMasterKeySource: "generated",
      credentialMasterKeyId: "testkey",
      credentialMasterKeyCreatedAt: Date.now(),
      authToken: options.authToken ?? null,
      authCookieSecure: false,
      agentWorkerEnabled: false,
      agentWorkerHost: "127.0.0.1",
      agentWorkerPort: 0,
      agentWorkerSocketPath: path.join(dataDir, "agent-worker.sock"),
      agentWorkerConcurrency: options.agentWorkerConcurrency ?? 2,
      agentInternalToken: internalToken,
      agentWorkerResponseValidation: "strict",
      agentApiOrigin: "http://127.0.0.1:0",
      agentStartupRecoveryMode: "recover",
      agentPluginHostEnabled: false,
      agentPluginHostSocketPath: path.join(dataDir, "agent-plugin-host.sock"),
      agentPluginServicesEnabled: false
    };

    if (options.withApp === true) {
      app = await (options.appFactory ?? createDefaultApp)(ctx);
      await app.ready();
    }

    let disposed = false;
    return {
      dataDir,
      db: fixtureDb,
      ctx,
      app,
      repoRoot,
      internalToken,
      async dispose() {
        if (disposed) return;
        disposed = true;
        const failures: unknown[] = [];
        if (app) {
          try {
            await app.close();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          fixtureDb.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await rmrf(dataDir);
        } catch (error) {
          failures.push(error);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, `Failed to dispose Agent test fixture at ${dataDir}`);
        }
      }
    };
  } catch (error) {
    const cleanupFailures = await cleanupFixtureResources({ app, db, dataDir });
    rethrowFixtureInitializationFailure(error, cleanupFailures, dataDir);
  }
}

/** Creates a visible workspace record and its backing directory in the fixture's real SQLite/dataDir. */
export async function createTestWorkspace(
  fixture: Pick<AgentTestFixture, "db" | "dataDir">,
  options: CreateTestWorkspaceOptions = {}
): Promise<WorkspaceRecord> {
  const id = options.id ?? newSortableId("ws");
  const dirName = options.dirName ?? newSortableId("workspace");
  const createdAt = options.createdAt ?? Date.now();
  const workspace: WorkspaceRecord = {
    id,
    dirName,
    title: options.title ?? "test-workspace",
    path: options.path ?? workspaceRoot(fixture.dataDir, dirName),
    terminalCredentialId: options.terminalCredentialId ?? null,
    createdAt,
    updatedAt: options.updatedAt ?? createdAt
  };
  await ensureDir(workspace.path);
  insertWorkspace(fixture.db, workspace);
  return workspace;
}

/** Creates a visible repository and workspace-repository link; it does not initialize a git repository. */
export async function createTestRepository(
  fixture: Pick<AgentTestFixture, "db" | "dataDir">,
  options: CreateTestRepositoryOptions
): Promise<TestRepository> {
  const id = options.id ?? newSortableId("repo");
  const dirName = options.dirName ?? id;
  const createdAt = options.createdAt ?? Date.now();
  const repoPath = options.path ?? workspaceRepoDirPath(fixture.dataDir, options.workspace.dirName, dirName);
  const repo: RepoRecord = {
    id,
    url: options.url ?? `https://example.test/${id}.git`,
    credentialId: null,
    defaultBranch: options.defaultBranch ?? "main",
    mirrorPath: repoMirrorPath(fixture.dataDir, id),
    syncStatus: "idle",
    syncError: null,
    lastSyncAt: null,
    createdAt,
    updatedAt: options.updatedAt ?? createdAt
  };
  const workspaceRepo: WorkspaceRepoRecord = {
    workspaceId: options.workspace.id,
    repoId: id,
    dirName,
    path: repoPath,
    createdAt,
    updatedAt: options.updatedAt ?? createdAt
  };
  await ensureDir(repoPath);
  insertRepo(fixture.db, repo);
  insertWorkspaceRepo(fixture.db, workspaceRepo);
  return { repo, workspaceRepo };
}

/** Performs an explicit JSON request against a real Fastify app without asserting its response. */
export async function injectJson(app: FastifyInstance, options: InjectJsonOptions) {
  return await app.inject({
    method: options.method as any,
    url: options.url,
    headers: {
      "content-type": "application/json",
      "x-awb-agent-internal-token": options.internalToken,
      ...options.headers
    },
    payload: options.payload as any
  });
}

function resolveFakeError(value: unknown | (() => unknown) | undefined) {
  return typeof value === "function" ? value() : value;
}

/**
 * Minimal runtime double for application-composition tests. It observes calls
 * and can fail deterministically, but intentionally models no worker queue.
 */
export function createFakeAgentRuntime(options: FakeAgentRuntimeOptions = {}): FakeAgentRuntime {
  const enqueueRunCalls: AgentRuntimeRun[] = [];
  const cancelSessionCalls: string[] = [];
  return {
    enqueueRunCalls,
    cancelSessionCalls,
    async enqueueRun(run) {
      enqueueRunCalls.push(run);
      await options.onEnqueueRun?.(run);
      const error = resolveFakeError(options.enqueueRunError);
      if (error !== undefined && error !== null) throw error;
    },
    async cancelSession(sessionId) {
      cancelSessionCalls.push(sessionId);
      await options.onCancelSession?.(sessionId);
      const error = resolveFakeError(options.cancelSessionError);
      if (error !== undefined && error !== null) throw error;
    }
  };
}
