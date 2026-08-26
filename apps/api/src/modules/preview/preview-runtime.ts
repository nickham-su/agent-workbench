import crypto from "node:crypto";

export const PREVIEW_BOOTSTRAP_TTL_MS = 60_000;
export const PREVIEW_RUNTIME_CLEANUP_INTERVAL_MS = 60_000;
export const PREVIEW_BOOTSTRAP_CAPACITY = 1_024;
export const PREVIEW_SESSION_CAPACITY = 256;

export type PreviewBootstrapRecord = Readonly<{
  code: string;
  workspaceId: string;
  entryPath: string;
  createdAt: number;
  expiresAt: number;
}>;

export type PreviewSessionRecord = Readonly<{
  sessionId: string;
  cookieSecret: string;
  cookieName: string;
  workspaceId: string;
  entryPath: string;
  createdAt: number;
  expiresAt: number;
}>;

export type CreatedPreviewSession = Readonly<{
  sessionId: string;
  cookieName: string;
  cookieSecret: string;
  cookiePath: string;
  redirectPath: string;
  expiresAt: number;
}>;

export type PreviewSessionState = "active" | "expired" | "missing";

type RuntimeTimer = { unref?: () => void };

type PreviewRuntimeOptions = {
  publicOrigin: string;
  sessionTtlMs: number;
  nowMs?: () => number;
  randomToken?: () => string;
  maxBootstraps?: number;
  maxSessions?: number;
  cleanupIntervalMs?: number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => RuntimeTimer;
  clearIntervalFn?: (timer: RuntimeTimer) => void;
};

export type PreviewRuntime = {
  readonly enabled: true;
  readonly publicOrigin: string;
  issueBootstrap(input: { workspaceId: string; entryPath: string }): PreviewBootstrapRecord;
  consumeBootstrap(code: string): PreviewBootstrapRecord | null;
  createSession(input: { workspaceId: string; entryPath: string }): CreatedPreviewSession;
  authenticateSession(input: { sessionId: string; cookieSecret: string | null }): PreviewSessionRecord | null;
  getSessionState(sessionId: string): PreviewSessionState;
  revokeSession(sessionId: string): void;
  cleanupExpired(now?: number): void;
  close(): void;
};

function defaultRandomToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function constantTimeEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function oldestKey<T extends { createdAt: number }>(records: Map<string, T>) {
  let key: string | null = null;
  let createdAt = Number.POSITIVE_INFINITY;
  for (const [candidateKey, record] of records) {
    if (record.createdAt < createdAt) {
      key = candidateKey;
      createdAt = record.createdAt;
    }
  }
  return key;
}

function evictToCapacity<T extends { createdAt: number }>(records: Map<string, T>, capacity: number) {
  while (records.size >= capacity) {
    const key = oldestKey(records);
    if (!key) return;
    records.delete(key);
  }
}

export function getPreviewCookieName(sessionId: string) {
  return `awb_preview_${sessionId}`;
}

export function getPreviewCookiePath(sessionId: string) {
  return `/s/${sessionId}/`;
}

function getPreviewRedirectPath(sessionId: string, entryPath: string) {
  return `${getPreviewCookiePath(sessionId)}${entryPath}`;
}

/**
 * Creates the process-local preview capability store. It deliberately has no
 * HTTP, Fastify, database, or filesystem dependency.
 */
export function createPreviewRuntime(options: PreviewRuntimeOptions): PreviewRuntime {
  if (!options.publicOrigin) throw new Error("Preview public origin is required");
  if (!Number.isSafeInteger(options.sessionTtlMs) || options.sessionTtlMs <= 0) {
    throw new Error("Preview session TTL must be a positive integer");
  }

  const nowMs = options.nowMs ?? (() => Date.now());
  const randomToken = options.randomToken ?? defaultRandomToken;
  const maxBootstraps = options.maxBootstraps ?? PREVIEW_BOOTSTRAP_CAPACITY;
  const maxSessions = options.maxSessions ?? PREVIEW_SESSION_CAPACITY;
  if (!Number.isSafeInteger(maxBootstraps) || maxBootstraps < 1) throw new Error("Preview bootstrap capacity must be positive");
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new Error("Preview session capacity must be positive");

  const bootstraps = new Map<string, PreviewBootstrapRecord>();
  const sessions = new Map<string, PreviewSessionRecord>();
  const expiredSessionIds = new Map<string, number>();
  let closed = false;

  const rememberExpiredSession = (sessionId: string, now: number) => {
    expiredSessionIds.delete(sessionId);
    expiredSessionIds.set(sessionId, now);
    while (expiredSessionIds.size > maxSessions) {
      const oldestSessionId = expiredSessionIds.keys().next().value;
      if (oldestSessionId === undefined) break;
      expiredSessionIds.delete(oldestSessionId);
    }
  };

  const cleanup = (now = nowMs()) => {
    for (const [code, record] of bootstraps) {
      if (record.expiresAt <= now) bootstraps.delete(code);
    }
    for (const [sessionId, record] of sessions) {
      if (record.expiresAt <= now) {
        sessions.delete(sessionId);
        rememberExpiredSession(sessionId, now);
      }
    }
  };

  const setIntervalFn = options.setIntervalFn ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearIntervalFn = options.clearIntervalFn ?? ((timer) => clearInterval(timer as NodeJS.Timeout));
  const timer = setIntervalFn(() => cleanup(), options.cleanupIntervalMs ?? PREVIEW_RUNTIME_CLEANUP_INTERVAL_MS);
  timer.unref?.();

  const assertOpen = () => {
    if (closed) throw new Error("Preview runtime is closed");
  };
  const uniqueToken = (records: Map<string, unknown>, forbidden?: Map<string, unknown>) => {
    let token = randomToken();
    while (!token || records.has(token) || forbidden?.has(token)) token = randomToken();
    return token;
  };

  return {
    enabled: true,
    publicOrigin: options.publicOrigin,
    issueBootstrap(input) {
      assertOpen();
      const createdAt = nowMs();
      cleanup(createdAt);
      evictToCapacity(bootstraps, maxBootstraps);
      const code = uniqueToken(bootstraps);
      const record: PreviewBootstrapRecord = {
        code,
        workspaceId: input.workspaceId,
        entryPath: input.entryPath,
        createdAt,
        expiresAt: createdAt + PREVIEW_BOOTSTRAP_TTL_MS
      };
      bootstraps.set(code, record);
      return record;
    },
    consumeBootstrap(code) {
      assertOpen();
      const record = bootstraps.get(code);
      if (!record) return null;

      // Deletion precedes any future asynchronous caller revalidation.
      bootstraps.delete(code);
      if (record.expiresAt <= nowMs()) return null;
      return record;
    },
    createSession(input) {
      assertOpen();
      const createdAt = nowMs();
      cleanup(createdAt);
      evictToCapacity(sessions, maxSessions);
      const sessionId = uniqueToken(sessions, expiredSessionIds);
      const cookieSecret = randomToken();
      if (!cookieSecret) throw new Error("Preview random token must not be empty");
      const cookieName = getPreviewCookieName(sessionId);
      const cookiePath = getPreviewCookiePath(sessionId);
      const expiresAt = createdAt + options.sessionTtlMs;
      const record: PreviewSessionRecord = {
        sessionId,
        cookieSecret,
        cookieName,
        workspaceId: input.workspaceId,
        entryPath: input.entryPath,
        createdAt,
        expiresAt
      };
      sessions.set(sessionId, record);
      return { sessionId, cookieName, cookieSecret, cookiePath, redirectPath: getPreviewRedirectPath(sessionId, input.entryPath), expiresAt };
    },
    authenticateSession(input) {
      assertOpen();
      const record = sessions.get(input.sessionId);
      if (!record) return null;
      if (record.expiresAt <= nowMs()) {
        sessions.delete(input.sessionId);
        rememberExpiredSession(input.sessionId, nowMs());
        return null;
      }
      if (!input.cookieSecret || !constantTimeEqual(input.cookieSecret, record.cookieSecret)) return null;
      return record;
    },
    getSessionState(sessionId) {
      assertOpen();
      const record = sessions.get(sessionId);
      if (!record) return expiredSessionIds.has(sessionId) ? "expired" : "missing";
      if (record.expiresAt <= nowMs()) return "expired";
      return "active";
    },
    revokeSession(sessionId) {
      sessions.delete(sessionId);
      expiredSessionIds.delete(sessionId);
    },
    cleanupExpired(now) {
      cleanup(now);
    },
    close() {
      if (closed) return;
      closed = true;
      clearIntervalFn(timer);
      bootstraps.clear();
      sessions.clear();
      expiredSessionIds.clear();
    }
  };
}

export function previewSecretsEqual(actual: string, expected: string) {
  return constantTimeEqual(actual, expected);
}
