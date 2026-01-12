import type { WsClientMessage, WsServerMessage } from "./protocol";

export type TerminalWsState = "idle" | "connecting" | "connected" | "blocked" | "disconnected" | "errored";

function wsOriginFromHttpTarget(target: string) {
  const u = new URL(target);
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host = window.location.hostname || u.hostname;
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const hostPort = port ? `${host}:${port}` : host;
  return `${protocol}://${hostPort}`;
}

export function terminalWsUrl(terminalId: string, force: boolean) {
  const origin =
    import.meta.env.DEV && typeof __DEV_API_TARGET__ === "string" && __DEV_API_TARGET__.startsWith("http")
      ? wsOriginFromHttpTarget(__DEV_API_TARGET__)
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
  const base = `${origin}/api/terminals/${terminalId}/ws`;
  return force ? `${base}?force=1` : base;
}

export function sendWs(ws: WebSocket, msg: WsClientMessage) {
  ws.send(JSON.stringify(msg));
}

export function parseWsMessage(raw: MessageEvent): WsServerMessage | null {
  try {
    return JSON.parse(String(raw.data)) as WsServerMessage;
  } catch {
    return null;
  }
}
