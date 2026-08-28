import {
  clearSessionModelOpenIntent,
  markSessionModelOpenIntentReady,
  migrateSessionModelOpenIntent,
  queueSessionModelOpenIntent,
  type SessionModelOpenIntentCache
} from "./agentSessionModelIntent";

/**
 * Parent-side async wiring for a model-modal request. It intentionally owns
 * draft conversion, authoritative state loading and intent readiness, so a
 * Pane can be rebuilt without ever issuing a model request for `draft_*`.
 */
export async function requestSessionModelOpen(params: {
  intents: SessionModelOpenIntentCache;
  sourceSessionId: string;
  agentId: string;
  requestId: number;
  isPrimaryServerSessionId: (sessionId: string) => boolean;
  ensureSessionCreated: (sessionId: string) => Promise<string>;
  loadSessionModelStates: (sessionId: string) => Promise<void>;
}) {
  const { intents, sourceSessionId, agentId, requestId } = params;
  queueSessionModelOpenIntent(intents, sourceSessionId, { agentId, requestId });
  let realSessionId = sourceSessionId;
  try {
    if (!params.isPrimaryServerSessionId(sourceSessionId)) {
      realSessionId = await params.ensureSessionCreated(sourceSessionId);
      migrateSessionModelOpenIntent(intents, sourceSessionId, realSessionId);
    }
    await params.loadSessionModelStates(realSessionId);
    return {
      sessionId: realSessionId,
      ready: markSessionModelOpenIntentReady(intents, realSessionId, requestId)
    };
  } catch (err) {
    clearSessionModelOpenIntent(intents, sourceSessionId, requestId);
    clearSessionModelOpenIntent(intents, realSessionId, requestId);
    throw err;
  }
}
