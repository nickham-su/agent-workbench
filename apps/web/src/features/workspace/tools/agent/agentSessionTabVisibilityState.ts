import type {
  UpdateWorkspaceAgentSessionTabVisibilityRequest,
  WorkspaceAgentSessionTabVisibilityMutation,
  WorkspaceAgentTabState
} from "@agent-workbench/shared";

export type AgentSessionTabKind = "primary" | "subtask";

/** A persisted Agent Session whose visibility can be synchronized to the Workspace. */
export type AgentSessionTabVisibilitySession = {
  id: string;
  kind: AgentSessionTabKind;
};

export type AgentSessionTabVisibilityContext = {
  workspaceId: string;
  workspaceGeneration: number;
};

export type SessionWriteIntent = {
  visible: boolean;
  intentSeq: number;
};

/**
 * Per-persisted-Session write state. Do not infer server state from a failed
 * request: a timeout may happen after the server committed the mutation.
 */
export type SessionWriteState = {
  confirmed?: boolean;
  nextIntentSeq: number;
  desired?: SessionWriteIntent;
  inFlight?: SessionWriteIntent;
};

export type AgentSessionTabVisibilityRequest = (
  workspaceId: string,
  sessionId: string,
  body: UpdateWorkspaceAgentSessionTabVisibilityRequest
) => Promise<WorkspaceAgentSessionTabVisibilityMutation>;

export type AgentSessionTabVisibilityControllerOptions = {
  request: AgentSessionTabVisibilityRequest;
  /** Must reject a switched Workspace and a disposed component. */
  isContextCurrent: (context: AgentSessionTabVisibilityContext) => boolean;
  /** Called only for the final, unconfirmed intent of one Session. */
  onMutationError: (sessionId: string, error: unknown) => void;
  /** Lets a framework adapter refresh its derived visibility immediately. */
  onStateChange?: () => void;
  /** An optional caller-owned object, useful when a Vue adapter needs reactivity. */
  writeStates?: Record<string, SessionWriteState>;
};

export function defaultAgentSessionTabVisibility(kind: AgentSessionTabKind) {
  return kind === "primary";
}

function responseMatchesRequest(
  response: WorkspaceAgentSessionTabVisibilityMutation,
  context: AgentSessionTabVisibilityContext,
  sessionId: string,
  request: SessionWriteIntent
) {
  return response.workspaceId === context.workspaceId && response.sessionId === sessionId && response.visible === request.visible;
}

/**
 * A framework-neutral single-flight visibility writer.
 *
 * The controller stores only state derived from persisted Sessions. Drafts
 * never enter its queue; use transferDraftVisibility once a draft gets a real
 * server Session ID.
 */
export class AgentSessionTabVisibilityController {
  readonly writeStates: Record<string, SessionWriteState>;

  private readonly sessions = new Map<string, AgentSessionTabVisibilitySession>();

  constructor(private readonly options: AgentSessionTabVisibilityControllerOptions) {
    this.writeStates = options.writeStates ?? {};
  }

  getState(sessionId: string) {
    return this.writeStates[sessionId];
  }

  getEffectiveVisibility(session: AgentSessionTabVisibilitySession) {
    const state = this.writeStates[session.id];
    return state?.desired?.visible ?? state?.confirmed ?? defaultAgentSessionTabVisibility(session.kind);
  }

  /**
   * Installs an atomically acquired Session-list/Tab-state snapshot. Pending
   * writes are intentionally kept: a slower initialization response must not
   * overwrite an optimistic mutation or its confirmation bookkeeping.
   */
  applyInitializationSnapshot(
    sessions: readonly AgentSessionTabVisibilitySession[],
    tabState: WorkspaceAgentTabState
  ) {
    this.sessions.clear();
    const closed = new Set(tabState.closedSessionIds);
    const openedSubtasks = new Set(tabState.openedSubtaskSessionIds);

    for (const session of sessions) {
      this.sessions.set(session.id, session);
      const state = this.ensureState(session.id);
      if (state.desired || state.inFlight) continue;

      state.confirmed = session.kind === "primary"
        ? !closed.has(session.id)
        : openedSubtasks.has(session.id);
    }
    this.notify();
  }

  /**
   * Drops settled state for Sessions that no longer appear in the current
   * server list. Pending entries are retained so their callback can safely
   * observe its own state without accidentally affecting a newer Session.
   */
  pruneSettledStates(sessions: readonly AgentSessionTabVisibilitySession[]) {
    const ids = new Set(sessions.map((session) => session.id));
    for (const sessionId of Object.keys(this.writeStates)) {
      const state = this.writeStates[sessionId];
      if (!ids.has(sessionId) && !state.desired && !state.inFlight) delete this.writeStates[sessionId];
    }
    this.notify();
  }

  /** Records a real user intent and begins (or joins) that Session's queue. */
  requestVisibility(
    session: AgentSessionTabVisibilitySession,
    visible: boolean,
    context: AgentSessionTabVisibilityContext
  ) {
    if (!this.options.isContextCurrent(context)) return false;

    this.sessions.set(session.id, session);
    const state = this.ensureState(session.id);
    const intentSeq = state.nextIntentSeq + 1;
    state.nextIntentSeq = intentSeq;
    state.desired = { visible, intentSeq };
    this.notify();
    void this.pump(session.id, context);
    return true;
  }

  /**
   * Drafts themselves have no persisted identity and must not call the API.
   * Once creation returns a real Session, transfer only a non-default draft
   * visibility intent into the normal single-flight queue.
   */
  transferDraftVisibility(
    session: AgentSessionTabVisibilitySession,
    draftVisible: boolean,
    context: AgentSessionTabVisibilityContext
  ) {
    if (draftVisible === defaultAgentSessionTabVisibility(session.kind)) {
      if (this.options.isContextCurrent(context)) this.sessions.set(session.id, session);
      return false;
    }
    return this.requestVisibility(session, draftVisible, context);
  }

  private ensureState(sessionId: string) {
    return (this.writeStates[sessionId] ??= { nextIntentSeq: 0 });
  }

  private isCurrentSession(context: AgentSessionTabVisibilityContext, sessionId: string) {
    return this.options.isContextCurrent(context) && this.sessions.has(sessionId);
  }

  private notify() {
    this.options.onStateChange?.();
  }

  private async pump(sessionId: string, context: AgentSessionTabVisibilityContext): Promise<void> {
    const state = this.writeStates[sessionId];
    if (!state || state.inFlight || !state.desired || !this.isCurrentSession(context, sessionId)) return;

    const request = { ...state.desired };
    state.inFlight = request;
    this.notify();

    let confirmed = false;
    let failure: unknown = new Error("Agent tab visibility update did not complete");
    try {
      const response = await this.options.request(context.workspaceId, sessionId, { visible: request.visible });
      if (!this.isCurrentSession(context, sessionId)) return;
      if (!responseMatchesRequest(response, context, sessionId, request)) {
        failure = new Error("Agent tab visibility response does not match the requested Session, Workspace, or visibility");
        return;
      }
      confirmed = true;
      state.confirmed = response.visible;
      this.notify();
    } catch (error) {
      failure = error;
    } finally {
      // Do not let old Workspace or disposed-component callbacks mutate UI
      // state, show errors, or enqueue compensation requests.
      if (!this.isCurrentSession(context, sessionId)) return;

      const latest = this.writeStates[sessionId];
      if (!latest || latest.inFlight?.intentSeq !== request.intentSeq) return;

      delete latest.inFlight;
      const newerIntentExists = latest.desired?.intentSeq !== undefined && latest.desired.intentSeq > request.intentSeq;
      if (newerIntentExists) {
        this.notify();
        void this.pump(sessionId, context);
        return;
      }

      if (confirmed) {
        if (latest.desired?.intentSeq === request.intentSeq) delete latest.desired;
        this.notify();
        return;
      }

      if (latest.desired?.intentSeq === request.intentSeq) delete latest.desired;
      this.notify();
      this.options.onMutationError(sessionId, failure);
    }
  }
}

export function createAgentSessionTabVisibilityController(options: AgentSessionTabVisibilityControllerOptions) {
  return new AgentSessionTabVisibilityController(options);
}
