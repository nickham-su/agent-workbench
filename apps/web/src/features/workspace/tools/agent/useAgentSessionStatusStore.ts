import type { AgentRuntimeSettings, AgentSessionRunState } from "@agent-workbench/shared";
import { LoadingOutlined, QuestionCircleOutlined } from "@ant-design/icons-vue";
import { computed, inject, reactive, readonly, watchEffect, type App, type ComputedRef, type InjectionKey } from "vue";
import { getAgentRunState, getAgentRuntimeSettings } from "@/shared/api";
import agentSessionTerminalSoundUrl from "@/shared/assets/audio/agent-session-terminal.mp3";

const ACTIVE_RUNNING_POLL_MS = 850;
const ACTIVE_WAITING_POLL_MS = 1100;
const BACKGROUND_NON_IDLE_POLL_MS = 2400;
const WARMUP_POLL_MS = 420;
const WARMUP_POLL_COUNT = 4;
const ERROR_RETRY_MS = 1600;
const SETTINGS_RELOAD_MS = 30_000;
const PERSIST_STORAGE_PREFIX = "agent-workbench.workspace.agent.sessionIndicators.v1";

const DEFAULT_RUN_STATE = (sessionId = ""): AgentSessionRunState => ({
  sessionId,
  status: "idle",
  activeRunId: null,
  activeAssistantItemId: null,
  waitingToolItemId: null,
  lastResponseTotalTokens: null,
  runNoticeText: "",
  nonTerminalItemIds: [],
  updatedAt: 0,
  appliedItemId: 0
});

export type SessionIndicatorIcon = "running" | "waiting_permission" | null;

type SessionStatusEntry = {
  sessionId: string;
  runState: AgentSessionRunState;
  fetchedAt: number;
  inFlight: boolean;
  nextPollAt: number;
  errorRetryAt: number | null;
  warmupRemaining: number;
  lastTerminalAt: number | null;
  lastSeenTerminalAt: number | null;
  prevRunStatus: AgentSessionRunState["status"] | null;
  lastSoundPlayedAt: number | null;
  lastSoundPlayFailedAt: number | null;
  indicatorIcon: SessionIndicatorIcon;
};

type PersistedSessionIndicator = {
  lastTerminalAt: number | null;
  lastSeenTerminalAt: number | null;
};

type PersistedIndicators = Record<string, PersistedSessionIndicator>;

type RuntimeSettingsState = {
  sessionTerminalSoundEnabled: boolean;
  loadedAt: number;
  loading: boolean;
};

export type AgentSessionStatusStore = ReturnType<typeof createAgentSessionStatusStore>;

export const agentSessionStatusStoreKey: InjectionKey<AgentSessionStatusStore> = Symbol("agent-session-status-store");

function storageKey(workspaceId: string) {
  const id = String(workspaceId || "").trim();
  return `${PERSIST_STORAGE_PREFIX}.${id || "default"}`;
}

function nowMs() {
  return Date.now();
}

function isNonIdle(status: AgentSessionRunState["status"]) {
  return status === "running" || status === "waiting_permission";
}

function indicatorIconOf(status: AgentSessionRunState["status"]): SessionIndicatorIcon {
  if (status === "running") return "running";
  if (status === "waiting_permission") return "waiting_permission";
  return null;
}

function shouldShowDot(entry: SessionStatusEntry, activeSessionId: string | null) {
  if (entry.runState.status !== "idle") return false;
  if (activeSessionId && activeSessionId === entry.sessionId) return false;
  if (entry.lastTerminalAt == null) return false;
  return entry.lastSeenTerminalAt == null || entry.lastTerminalAt > entry.lastSeenTerminalAt;
}

function nextPollDelayOf(params: {
  activeSessionId: string | null;
  visibleSessionIds: Set<string>;
  entry: SessionStatusEntry;
}) {
  const { activeSessionId, visibleSessionIds, entry } = params;
  if (entry.runState.status === "running") {
    return activeSessionId === entry.sessionId ? ACTIVE_RUNNING_POLL_MS : BACKGROUND_NON_IDLE_POLL_MS;
  }
  if (entry.runState.status === "waiting_permission") {
    return activeSessionId === entry.sessionId ? ACTIVE_WAITING_POLL_MS : BACKGROUND_NON_IDLE_POLL_MS;
  }
  if (entry.warmupRemaining > 0) {
    return WARMUP_POLL_MS;
  }
  if (visibleSessionIds.has(entry.sessionId) && entry.errorRetryAt != null) {
    return ERROR_RETRY_MS;
  }
  return Number.POSITIVE_INFINITY;
}

export function createAgentSessionStatusStore() {
  const state = reactive({
    workspaceId: "",
    activeSessionId: null as string | null,
    visibleSessionIds: new Set<string>(),
    registeredSessionIds: new Set<string>(),
    entries: {} as Record<string, SessionStatusEntry>,
    runtimeSettings: {
      sessionTerminalSoundEnabled: true,
      loadedAt: 0,
      loading: false
    } as RuntimeSettingsState
  });

  let timer: number | null = null;
  let disposed = false;
  let settingsTimer: number | null = null;
  let persisted: PersistedIndicators = {};
  let audioEl: HTMLAudioElement | null = null;
  let registeredSessionsReady = false;
  const indicatorCache = new Map<string, ComputedRef<{ icon: SessionIndicatorIcon; showDot: boolean; iconComponent: any; iconClass: string; spin: boolean }>>();

  function ensureAudio() {
    if (typeof window === "undefined") return null;
    if (!audioEl) {
      audioEl = new Audio(agentSessionTerminalSoundUrl);
      audioEl.preload = "auto";
    }
    return audioEl;
  }

  function resetAudio() {
    if (!audioEl) return;
    try {
      audioEl.pause();
      audioEl.currentTime = 0;
    } catch {
      // ignore
    }
    audioEl = null;
  }

  function persistIndicators() {
    const workspaceId = String(state.workspaceId || "").trim();
    if (!registeredSessionsReady) return;
    if (!workspaceId) return;
    const payload: PersistedIndicators = {};
    for (const sessionId of Object.keys(state.entries)) {
      if (!state.registeredSessionIds.has(sessionId)) continue;
      const entry = state.entries[sessionId];
      payload[sessionId] = {
        lastTerminalAt: entry.lastTerminalAt,
        lastSeenTerminalAt: entry.lastSeenTerminalAt
      };
    }
    persisted = payload;
    try {
      localStorage.setItem(storageKey(workspaceId), JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  function restoreIndicators() {
    persisted = {};
    registeredSessionsReady = false;
    const workspaceId = String(state.workspaceId || "").trim();
    if (!workspaceId) return;
    try {
      const raw = localStorage.getItem(storageKey(workspaceId));
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedIndicators;
      if (!parsed || typeof parsed !== "object") return;
      persisted = parsed;
    } catch {
      persisted = {};
    }
  }

  function applyPersistedIndicator(entry: SessionStatusEntry) {
    const saved = persisted[entry.sessionId];
    if (!saved) return;
    entry.lastTerminalAt = typeof saved.lastTerminalAt === "number" ? saved.lastTerminalAt : null;
    entry.lastSeenTerminalAt = typeof saved.lastSeenTerminalAt === "number" ? saved.lastSeenTerminalAt : null;
  }

  function ensureEntry(sessionId: string) {
    const id = String(sessionId || "").trim();
    if (!id) return null;
    let entry = state.entries[id];
    if (!entry) {
      entry = reactive({
        sessionId: id,
        runState: DEFAULT_RUN_STATE(id),
        fetchedAt: 0,
        inFlight: false,
        nextPollAt: 0,
        errorRetryAt: null,
        warmupRemaining: 0,
        lastTerminalAt: null,
        lastSeenTerminalAt: null,
        prevRunStatus: null,
        lastSoundPlayedAt: null,
        lastSoundPlayFailedAt: null,
        indicatorIcon: null
      }) as SessionStatusEntry;
      applyPersistedIndicator(entry);
      state.entries[id] = entry;
    }
    return entry;
  }

  function clearTimer() {
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
  }

  function clearSettingsTimer() {
    if (settingsTimer != null) {
      window.clearTimeout(settingsTimer);
      settingsTimer = null;
    }
  }

  function pruneEntries() {
    const keep = new Set<string>([...state.visibleSessionIds, ...state.registeredSessionIds]);
    for (const sessionId of Object.keys(state.entries)) {
      if (keep.has(sessionId)) continue;
      indicatorCache.delete(sessionId);
      delete state.entries[sessionId];
    }
    const nextPersisted: PersistedIndicators = {};
    for (const sessionId of state.registeredSessionIds) {
      const entry = state.entries[sessionId];
      if (!entry) continue;
      nextPersisted[sessionId] = {
        lastTerminalAt: entry.lastTerminalAt,
        lastSeenTerminalAt: entry.lastSeenTerminalAt
      };
    }
    if (registeredSessionsReady) {
      persisted = nextPersisted;
      persistIndicators();
    }
  }

  function updateEntryIndicator(entry: SessionStatusEntry) {
    entry.indicatorIcon = indicatorIconOf(entry.runState.status);
  }

  function markSessionSeen(sessionId: string) {
    const entry = ensureEntry(sessionId);
    if (!entry) return;
    const stamp = entry.lastTerminalAt ?? nowMs();
    entry.lastSeenTerminalAt = stamp;
    persistIndicators();
  }

  function playTerminalSound(entry: SessionStatusEntry, terminalAt: number) {
    if (!state.runtimeSettings.sessionTerminalSoundEnabled) return;
    if (entry.lastSoundPlayedAt != null && terminalAt <= entry.lastSoundPlayedAt) return;
    const audio = ensureAudio();
    if (!audio) return;
    entry.lastSoundPlayedAt = terminalAt;
    try {
      audio.currentTime = 0;
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          entry.lastSoundPlayFailedAt = nowMs();
        });
      }
    } catch {
      entry.lastSoundPlayFailedAt = nowMs();
    }
  }

  function onRunStateTransition(entry: SessionStatusEntry, next: AgentSessionRunState) {
    const prev = entry.prevRunStatus ?? entry.runState.status;
    const nextStatus = next.status;
    updateEntryIndicator(entry);
    if (prev !== "idle" && nextStatus === "idle") {
      const terminalAt = typeof next.updatedAt === "number" && next.updatedAt > 0 ? next.updatedAt : nowMs();
      entry.lastTerminalAt = terminalAt;
      if (state.activeSessionId === entry.sessionId) {
        entry.lastSeenTerminalAt = terminalAt;
      }
      playTerminalSound(entry, terminalAt);
      persistIndicators();
    } else if (prev === "idle" && isNonIdle(nextStatus)) {
      if (entry.lastTerminalAt != null) {
        entry.lastSeenTerminalAt = entry.lastTerminalAt;
        persistIndicators();
      }
    }
    entry.prevRunStatus = nextStatus;
  }

  async function refreshRuntimeSettings(force = false) {
    if (disposed) return;
    if (state.runtimeSettings.loading) return;
    const age = nowMs() - state.runtimeSettings.loadedAt;
    if (!force && state.runtimeSettings.loadedAt > 0 && age < SETTINGS_RELOAD_MS) return;
    state.runtimeSettings.loading = true;
    try {
      const settings = await getAgentRuntimeSettings();
      state.runtimeSettings.sessionTerminalSoundEnabled = settings.sessionTerminalSoundEnabled !== false;
      state.runtimeSettings.loadedAt = nowMs();
    } catch {
      if (state.runtimeSettings.loadedAt === 0) {
        state.runtimeSettings.sessionTerminalSoundEnabled = true;
      }
    } finally {
      state.runtimeSettings.loading = false;
      scheduleSettingsRefresh();
    }
  }

  function scheduleSettingsRefresh() {
    clearSettingsTimer();
    if (disposed || !state.workspaceId) return;
    settingsTimer = window.setTimeout(() => {
      settingsTimer = null;
      void refreshRuntimeSettings();
    }, SETTINGS_RELOAD_MS);
  }

  async function refreshSessionNow(sessionId: string) {
    const entry = ensureEntry(sessionId);
    if (!entry || entry.inFlight) return;
    if (!state.registeredSessionIds.has(sessionId)) return;
    entry.inFlight = true;
    try {
      const next = await getAgentRunState(sessionId);
      entry.errorRetryAt = null;
      entry.fetchedAt = nowMs();
      entry.runState = next;
      onRunStateTransition(entry, next);
      if (entry.warmupRemaining > 0 && next.status === "idle") {
        entry.warmupRemaining -= 1;
      } else if (next.status !== "idle") {
        entry.warmupRemaining = 0;
      }
      const delay = nextPollDelayOf({
        activeSessionId: state.activeSessionId,
        visibleSessionIds: state.visibleSessionIds,
        entry
      });
      entry.nextPollAt = Number.isFinite(delay) ? nowMs() + delay : Number.POSITIVE_INFINITY;
    } catch {
      entry.errorRetryAt = nowMs();
      entry.nextPollAt = nowMs() + ERROR_RETRY_MS;
    } finally {
      entry.inFlight = false;
      schedule();
    }
  }

  async function refreshVisibleSessionsNow() {
    const ids = [...state.visibleSessionIds].filter((id) => state.registeredSessionIds.has(id));
    await Promise.all(ids.map((id) => refreshSessionNow(id)));
  }

  function bumpPollHint(sessionId: string, opts?: { warmup?: boolean; immediate?: boolean }) {
    const entry = ensureEntry(sessionId);
    if (!entry) return;
    if (opts?.warmup) {
      entry.warmupRemaining = Math.max(entry.warmupRemaining, WARMUP_POLL_COUNT);
    }
    entry.nextPollAt = opts?.immediate === false ? nowMs() + WARMUP_POLL_MS : 0;
    schedule();
  }

  function getDueSessionIds() {
    const now = nowMs();
    const ids: string[] = [];
    for (const sessionId of Object.keys(state.entries)) {
      const entry = state.entries[sessionId];
      if (!state.registeredSessionIds.has(sessionId)) continue;
      if (!state.visibleSessionIds.has(sessionId) && state.activeSessionId !== sessionId) continue;
      if (entry.inFlight) continue;
      if (entry.nextPollAt <= now) ids.push(sessionId);
    }
    return ids;
  }

  function schedule() {
    clearTimer();
    if (disposed) return;
    const now = nowMs();
    let nextAt = Number.POSITIVE_INFINITY;
    for (const sessionId of Object.keys(state.entries)) {
      const entry = state.entries[sessionId];
      if (!state.registeredSessionIds.has(sessionId)) continue;
      if (!state.visibleSessionIds.has(sessionId) && state.activeSessionId !== sessionId) continue;
      if (entry.inFlight) continue;
      if (entry.nextPollAt < nextAt) nextAt = entry.nextPollAt;
    }
    if (!Number.isFinite(nextAt)) return;
    const delay = Math.max(0, nextAt - now);
    timer = window.setTimeout(() => {
      timer = null;
      const dueIds = getDueSessionIds();
      if (dueIds.length === 0) {
        schedule();
        return;
      }
      void Promise.all(dueIds.map((id) => refreshSessionNow(id)));
    }, delay);
  }

  function bindWorkspace(workspaceId: string) {
    const next = String(workspaceId || "").trim();
    if (state.workspaceId === next) return;
    clearTimer();
    clearSettingsTimer();
    resetAudio();
    state.workspaceId = next;
    state.activeSessionId = null;
    state.visibleSessionIds = new Set();
    state.registeredSessionIds = new Set();
    state.entries = {} as Record<string, SessionStatusEntry>;
    indicatorCache.clear();
    state.runtimeSettings.sessionTerminalSoundEnabled = true;
    state.runtimeSettings.loadedAt = 0;
    restoreIndicators();
    if (next) {
      void refreshRuntimeSettings(true);
    }
  }

  function syncSessions(params: { visibleSessionIds: string[]; activeSessionId: string | null; registeredSessionIds?: string[] }) {
    state.visibleSessionIds = new Set(params.visibleSessionIds.map((id) => String(id || "").trim()).filter(Boolean));
    if (Array.isArray(params.registeredSessionIds)) {
      state.registeredSessionIds = new Set(params.registeredSessionIds.map((id) => String(id || "").trim()).filter(Boolean));
      registeredSessionsReady = true;
    }
    state.activeSessionId = String(params.activeSessionId || "").trim() || null;
    for (const sessionId of state.visibleSessionIds) {
      ensureEntry(sessionId);
    }
    for (const sessionId of state.registeredSessionIds) {
      const entry = ensureEntry(sessionId);
      if (!entry) continue;
      if (entry.fetchedAt === 0) {
        entry.nextPollAt = 0;
      }
    }
    if (state.activeSessionId) {
      markSessionSeen(state.activeSessionId);
    }
    if (registeredSessionsReady) {
      pruneEntries();
    }
    schedule();
  }

  function getEntry(sessionId: string) {
    return ensureEntry(sessionId) ?? ({
      sessionId,
      runState: DEFAULT_RUN_STATE(sessionId),
      fetchedAt: 0,
      inFlight: false,
      nextPollAt: Number.POSITIVE_INFINITY,
      errorRetryAt: null,
      warmupRemaining: 0,
      lastTerminalAt: null,
      lastSeenTerminalAt: null,
      prevRunStatus: null,
      lastSoundPlayedAt: null,
      lastSoundPlayFailedAt: null,
      indicatorIcon: null
    } as SessionStatusEntry);
  }

  function getRunState(sessionId: string): ComputedRef<AgentSessionRunState> {
    return computed(() => getEntry(sessionId).runState);
  }

  function getIndicator(sessionId: string): ComputedRef<{
    icon: SessionIndicatorIcon;
    showDot: boolean;
    iconComponent: any;
    iconClass: string;
    spin: boolean;
  }> {
    const cached = indicatorCache.get(sessionId);
    if (cached) return cached;
    const created = computed(() => {
      const entry = getEntry(sessionId);
      const icon = entry.indicatorIcon;
      return {
        icon,
        showDot: shouldShowDot(entry, state.activeSessionId),
        iconComponent: icon === "running" ? LoadingOutlined : (icon === "waiting_permission" ? QuestionCircleOutlined : null),
        iconClass: icon === "running" ? "text-blue-500" : (icon === "waiting_permission" ? "text-amber-500" : ""),
        spin: icon === "running"
      };
    });
    indicatorCache.set(sessionId, created);
    return created;
  }

  function runStateOf(sessionId: string): AgentSessionRunState {
    return getEntry(sessionId).runState;
  }

  function indicatorOf(sessionId: string) {
    return getIndicator(sessionId).value;
  }

  function iconComponentOf(sessionId: string) {
    return indicatorOf(sessionId).iconComponent;
  }

  function dispose() {
    disposed = true;
    clearTimer();
    clearSettingsTimer();
    resetAudio();
    indicatorCache.clear();
    if (typeof window !== "undefined") {
      window.removeEventListener("awb:agent-runtime-settings-updated", onRuntimeSettingsUpdated);
    }
  }

  watchEffect(() => {
    if (state.activeSessionId) {
      markSessionSeen(state.activeSessionId);
    }
  });

  if (typeof window !== "undefined") {
    window.addEventListener("awb:agent-runtime-settings-updated", onRuntimeSettingsUpdated);
  }

  function onRuntimeSettingsUpdated() {
    void refreshRuntimeSettings(true);
  }

  return {
    state: readonly(state),
    bindWorkspace,
    syncSessions,
    markSessionSeen,
    bumpPollHint,
    refreshSessionNow,
    refreshVisibleSessionsNow,
    refreshRuntimeSettings,
    getEntry,
    getRunState,
    runStateOf,
    getIndicator,
    indicatorOf,
    iconComponentOf,
    dispose
  };
}

export function useAgentSessionStatusStore() {
  const store = inject(agentSessionStatusStoreKey, null);
  if (!store) {
    throw new Error("AgentSessionStatusStore 未提供：请确认组件处于 AgentToolView 作用域内");
  }
  return store;
}

export function installAgentSessionStatusStore(app: App, store: AgentSessionStatusStore) {
  app.provide(agentSessionStatusStoreKey, store);
}
