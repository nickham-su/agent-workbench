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
  confirmationEpoch: number;
  uncertainCommit: boolean;
  desired?: SessionWriteIntent;
  inFlight?: SessionWriteIntent;
};

export type VisibilityIntentOutcome =
  | { status: "confirmed"; sessionId: string; intentSeq: number }
  | { status: "failed"; sessionId: string; intentSeq: number; error: unknown }
  | { status: "superseded" | "contextInvalidated" | "uiTimeout" | "cancelled"; sessionId: string; intentSeq: number };
export type VisibilityIntentReceipt = {
  intentSeq: number;
  previousEffectiveVisibility: boolean;
  result: Promise<VisibilityIntentOutcome>;
  cancel(): void;
};
export type VisibilitySnapshot = Map<string, { intentSeq: number; confirmationEpoch: number; wasPending: boolean }>;
type Subscription = { intentSeq: number; settle(outcome: VisibilityIntentOutcome): void };

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

  private readonly subscriptions = new Map<string, Subscription>();
  private readonly sessions = new Map<string, AgentSessionTabVisibilitySession>();
  private contextEpoch = 0;

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
    tabState: WorkspaceAgentTabState,
    snapshot?: VisibilitySnapshot
  ) {
    const closed = new Set(tabState.closedSessionIds);
    const openedSubtasks = new Set(tabState.openedSubtaskSessionIds);

    const known = new Map(sessions.map((session) => [session.id, session]));
    for (const id of closed) if (!known.has(id)) known.set(id, { id, kind: "primary" });
    for (const id of openedSubtasks) if (!known.has(id)) known.set(id, { id, kind: "subtask" });
    for (const session of known.values()) {
      this.sessions.set(session.id, session);
      const state = this.ensureState(session.id);
      if (state.desired || state.inFlight || (snapshot && this.isSnapshotProtected(session.id, snapshot))) continue;
      state.uncertainCommit = false;

      state.confirmed = session.kind === "primary"
        ? !closed.has(session.id)
        : openedSubtasks.has(session.id);
    }
    this.notify();
  }

  /** A partial snapshot is never evidence that an absent Session was deleted. */
  isSnapshotProtected(sessionId: string, snapshot: VisibilitySnapshot): boolean {
    const state = this.writeStates[sessionId];
    const captured = snapshot.get(sessionId);
    return !!(captured?.wasPending || state?.desired || state?.inFlight
      || (state?.nextIntentSeq ?? 0) !== (captured?.intentSeq ?? 0)
      || (state?.confirmationEpoch ?? 0) !== (captured?.confirmationEpoch ?? 0));
  }

  captureSnapshot(): VisibilitySnapshot {
    return new Map(Object.entries(this.writeStates).map(([id, state]) => [id, {
      intentSeq: state.nextIntentSeq,
      confirmationEpoch: state.confirmationEpoch,
      wasPending: !!(state.desired || state.inFlight),
    }]));
  }

  /** Records a real user intent and begins (or joins) the existing queue. */
  requestVisibility(session: AgentSessionTabVisibilitySession, visible: boolean, context: AgentSessionTabVisibilityContext) {
    if (!this.options.isContextCurrent(context)) return false;
    this.register(session, visible, context);
    return true;
  }

  requestVisibilityWithResult(session: AgentSessionTabVisibilitySession, visible: boolean, context: AgentSessionTabVisibilityContext): VisibilityIntentReceipt {
    const previousEffectiveVisibility = this.getEffectiveVisibility(session);
    if (!this.options.isContextCurrent(context)) {
      return { intentSeq: 0, previousEffectiveVisibility, result: Promise.resolve({ status: "contextInvalidated", sessionId: session.id, intentSeq: 0 }), cancel() {} };
    }
    let settle!: (outcome: VisibilityIntentOutcome) => void;
    const result = new Promise<VisibilityIntentOutcome>((resolve) => {
      let settled = false;
      const deadline = performance.now() + 30000;
      const timer = setTimeout(() => settle({ status: "uiTimeout", sessionId: session.id, intentSeq }), 30000);
      // Register before notify/pump, including the synchronous no-op case.
      settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.subscriptions.get(session.id)?.settle === settle) this.subscriptions.delete(session.id);
        resolve(outcome.status === "confirmed" && performance.now() >= deadline ? { ...outcome, status: "uiTimeout" } : outcome);
      };
    });
    const intentSeq = this.ensureState(session.id).nextIntentSeq + 1;
    this.register(session, visible, context, { intentSeq, settle });
    return { intentSeq, previousEffectiveVisibility, result, cancel: () => settle({ status: "cancelled", sessionId: session.id, intentSeq }) };
  }

  /** End a Workspace lifecycle, not an initialization retry within that lifecycle. */
  invalidateContext() {
    this.contextEpoch += 1;
    for (const [sessionId, receipt] of this.subscriptions) receipt.settle({ status: "contextInvalidated", sessionId, intentSeq: receipt.intentSeq });
    this.subscriptions.clear();
    this.sessions.clear();
    for (const id of Object.keys(this.writeStates)) delete this.writeStates[id];
  }

  private register(session: AgentSessionTabVisibilitySession, visible: boolean, context: AgentSessionTabVisibilityContext, receipt?: Subscription) {
    this.sessions.set(session.id, session);
    const state = this.ensureState(session.id);
    const old = this.subscriptions.get(session.id);
    old?.settle({ status: "superseded", sessionId: session.id, intentSeq: old.intentSeq });
    const intentSeq = ++state.nextIntentSeq;
    if (receipt) this.subscriptions.set(session.id, receipt);
    const noOp = receipt && !state.desired && !state.inFlight && !state.uncertainCommit
      && state.confirmed === visible;
    if (noOp) {
      receipt.settle({ status: "confirmed", sessionId: session.id, intentSeq });
      this.notify();
      return;
    }
    state.desired = { visible, intentSeq };
    this.notify();
    void this.pump(session.id, context);
  }

  private settle(sessionId: string, request: SessionWriteIntent, outcome: "confirmed" | "failed", error?: unknown) {
    const receipt = this.subscriptions.get(sessionId);
    if (receipt?.intentSeq !== request.intentSeq) return;
    receipt.settle(outcome === "confirmed" ? { status: outcome, sessionId, intentSeq: request.intentSeq }
      : { status: outcome, sessionId, intentSeq: request.intentSeq, error });
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
      if (this.options.isContextCurrent(context)) {
        this.sessions.set(session.id, session);
        const state = this.ensureState(session.id);
        state.confirmed = defaultAgentSessionTabVisibility(session.kind);
        state.confirmationEpoch += 1;
      }
      return false;
    }
    return this.requestVisibility(session, draftVisible, context);
  }

  private ensureState(sessionId: string) {
    return (this.writeStates[sessionId] ??= { nextIntentSeq: 0, confirmationEpoch: 0, uncertainCommit: false });
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

    const epoch = this.contextEpoch;
    const isCurrent = () => epoch === this.contextEpoch && this.writeStates[sessionId] === state
      && this.isCurrentSession(context, sessionId);
    const request = { ...state.desired };
    state.inFlight = request;
    this.notify();

    let confirmed = false;
    let failure: unknown = new Error("Agent tab visibility update did not complete");
    try {
      const response = await this.options.request(context.workspaceId, sessionId, { visible: request.visible });
      if (!isCurrent()) return;
      if (!responseMatchesRequest(response, context, sessionId, request)) {
        failure = new Error("Agent tab visibility response does not match the requested Session, Workspace, or visibility");
        return;
      }
      confirmed = true;
      state.confirmed = response.visible;
      state.uncertainCommit = false;
      state.confirmationEpoch += 1;
      this.notify();
    } catch (error) {
      failure = error;
    } finally {
      // Do not let old Workspace or disposed-component callbacks mutate UI
      // state, show errors, or enqueue compensation requests.
      if (!isCurrent()) return;

      const latest = this.writeStates[sessionId];
      if (!latest || latest.inFlight?.intentSeq !== request.intentSeq) return;

      delete latest.inFlight;
      if (!confirmed) {
        latest.uncertainCommit = true;
        latest.confirmationEpoch += 1;
      }
      const newerIntentExists = latest.desired?.intentSeq !== undefined && latest.desired.intentSeq > request.intentSeq;
      if (newerIntentExists) {
        this.notify();
        void this.pump(sessionId, context);
        return;
      }

      if (confirmed) {
        if (latest.desired?.intentSeq === request.intentSeq) delete latest.desired;
        this.settle(sessionId, request, "confirmed");
        this.notify();
        return;
      }

      if (latest.desired?.intentSeq === request.intentSeq) delete latest.desired;
      this.notify();
      this.settle(sessionId, request, "failed", failure);
      this.options.onMutationError(sessionId, failure);
    }
  }
}

export function createAgentSessionTabVisibilityController(options: AgentSessionTabVisibilityControllerOptions) {
  return new AgentSessionTabVisibilityController(options);
}
