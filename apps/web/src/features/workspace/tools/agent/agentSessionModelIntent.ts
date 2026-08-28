/**
 * Parent-owned, one-shot request to open a primary Session's model modal.
 * Keeping this outside a Pane lets a draft Pane be replaced safely after its
 * Session is created, and makes duplicate-click ordering explicit.
 */
export type SessionModelOpenIntent = {
  agentId: string;
  requestId: number;
  ready: boolean;
};

export type SessionModelOpenIntentCache = Record<string, SessionModelOpenIntent>;

export function queueSessionModelOpenIntent(
  cache: SessionModelOpenIntentCache,
  sessionId: string,
  intent: Omit<SessionModelOpenIntent, "ready">
) {
  cache[sessionId] = { ...intent, ready: false };
}

/** Moves a draft intent to its created Session without replacing a newer request. */
export function migrateSessionModelOpenIntent(
  cache: SessionModelOpenIntentCache,
  fromSessionId: string,
  toSessionId: string
) {
  if (fromSessionId === toSessionId) return;
  const intent = cache[fromSessionId];
  if (!intent) return;
  delete cache[fromSessionId];
  const target = cache[toSessionId];
  if (!target || target.requestId <= intent.requestId) cache[toSessionId] = intent;
}

/** Only the latest request for the Session may become consumable. */
export function markSessionModelOpenIntentReady(
  cache: SessionModelOpenIntentCache,
  sessionId: string,
  requestId: number
) {
  const intent = cache[sessionId];
  if (!intent || intent.requestId !== requestId) return false;
  cache[sessionId] = { ...intent, ready: true };
  return true;
}

/** Atomically consumes exactly the ready intent requested by a Pane. */
export function consumeSessionModelOpenIntent(
  cache: SessionModelOpenIntentCache,
  sessionId: string,
  requestId: number
) {
  const intent = cache[sessionId];
  if (!intent || !intent.ready || intent.requestId !== requestId) return null;
  delete cache[sessionId];
  return intent;
}

export function clearSessionModelOpenIntent(cache: SessionModelOpenIntentCache, sessionId: string, requestId: number) {
  const intent = cache[sessionId];
  if (!intent || intent.requestId !== requestId) return false;
  delete cache[sessionId];
  return true;
}
