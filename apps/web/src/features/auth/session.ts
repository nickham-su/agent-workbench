import type { HealthResponse } from "@agent-workbench/shared";

export type AuthStatus = {
  loaded: boolean;
  authEnabled: boolean;
  authed: boolean;
  version: string;
};

let cached: AuthStatus = { loaded: false, authEnabled: false, authed: false, version: "0.0.0" };
let inFlight: Promise<AuthStatus> | null = null;

export function resetAuthStatus() {
  cached = { loaded: false, authEnabled: false, authed: false, version: cached.version || "0.0.0" };
  inFlight = null;
}

export function setAuthed(authed: boolean) {
  cached = { ...cached, loaded: true, authed };
}

export async function loadAuthStatus(): Promise<AuthStatus> {
  if (cached.loaded) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const res = (await fetch("/api/health", { method: "GET" }).then(async (r) => {
      if (!r.ok) throw new Error(`health request failed: ${r.status}`);
      return (await r.json()) as HealthResponse;
    })) as HealthResponse;
    cached = {
      loaded: true,
      authEnabled: Boolean((res as any).authEnabled),
      authed: Boolean((res as any).authed),
      version: String((res as any).version || "0.0.0")
    };
    return cached;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}
