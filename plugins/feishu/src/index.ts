import { clearTimeout as clearSleepTimeout, setTimeout as sleepTimeout } from "node:timers";
import { createInternalClient } from "./internal-client.js";
import { policyLabel } from "./policy.js";
import type { RunCompletedEvent } from "./run-events.js";
import { shouldBroadcastToChat } from "./run-events.js";
import { createFeishuStore, type ChatBinding } from "./store.js";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

type GatewayConfig = {
  appId: string;
  appSecret: string;
  botOpenId?: string;
  domain?: string;
};

type GatewayStartParams = {
  config: GatewayConfig;
  apiOrigin: string;
  internalToken: string;
  dataDir: string;
  logger: Logger;
};

type MessageEventContext = {
  messageId: string;
  chatId: string;
  chatType: "direct" | "group";
  sender: { id: string };
  mentionedBot: boolean;
  text: string;
};

type FeishuGateway = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  replyText: (chatId: string, messageId: string, text: string) => Promise<void>;
  sendText: (chatId: string, text: string) => Promise<void>;
};

function toRecord(raw: unknown): Record<string, any> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, any>;
}

function safeJsonParse(raw: unknown): any {
  if (typeof raw !== "string") return null;
  const txt = raw.trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function normalizeText(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function buildChatKey(chatId: string) {
  return `feishu_default_chat_${chatId}`;
}

function resolveIndexOrId(arg: string, items: Array<{ id: string }>) {
  const a = normalizeText(arg);
  if (!a) return "";
  if (/^\d+$/.test(a)) {
    const idx = Number(a);
    if (!Number.isFinite(idx) || idx <= 0) return "";
    return items[idx - 1]?.id ?? "";
  }
  return a;
}

function parseCommand(text: string): { cmd: string; arg: string } | null {
  const t = normalizeText(text);
  if (!t.startsWith("/")) return null;
  const parts = t.split(/\s+/g).filter(Boolean);
  const cmdRaw = normalizeText(parts[0]).toLowerCase();
  const alias: Record<string, string> = {
    "/todo": "/t",
    "/help": "/h",
    "/status": "/st",
    "/session": "/ss",
    "/new": "/n",
    "/agent": "/a",
    "/compact": "/c",
    "/last": "/l",
    "/policy": "/p",
    "/workspace": "/ws"
  };
  const cmd = alias[cmdRaw] ?? cmdRaw;
  const arg = parts.length > 1 ? parts.slice(1).join(" ") : "";
  return { cmd, arg };
}

/**
 * todolist 状态到符号的映射。
 * - completed: ●
 * - pending: ○
 * - in_progress: ▶
 * - cancelled: ×（需求未指定，这里选用 × 并在 /t help 中说明）
 */
const TODOLIST_STATUS_SYMBOL: Record<string, string> = {
  completed: "●",
  pending: "○",
  in_progress: "▶",
  cancelled: "×",
  canceled: "×"
};

function todolistStatusSymbol(status: unknown) {
  const s = normalizeText(status).toLowerCase().replace(/[-\s]/g, "_");
  return TODOLIST_STATUS_SYMBOL[s] ?? TODOLIST_STATUS_SYMBOL.pending;
}

export function formatTodolistResult(result: any): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const goal = normalizeText((result as any).goal);
  const todosRaw = (result as any).todos;
  if (!Array.isArray(todosRaw)) return null;

  const lines: string[] = [];
  if (goal) lines.push(`目标：${goal}`);
  if (todosRaw.length === 0) {
    lines.push("(无任务)");
    return lines.join("\n");
  }
  for (const t of todosRaw) {
    const content = normalizeText((t as any)?.content) || "(empty)";
    lines.push(`${todolistStatusSymbol((t as any)?.status)} ${content}`);
  }
  return lines.join("\n");
}

export function formatTodolistToolOutput(toolOutput: any): string {
  const formatted = formatTodolistResult(toolOutput?.result);
  if (formatted) return formatted;
  const text = normalizeText(toolOutput?.text);
  if (text) return text;
  return "(empty)";
}

export function findLatestTodolistToolItem(items: any[]): any | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i];
    // 兼容：若 kind 存在，则必须是 tool
    const kind = normalizeText(it?.kind).toLowerCase();
    if (kind && kind !== "tool") continue;

    const out = it?.output;
    if (!out || typeof out !== "object") continue;
    if (normalizeText(out.type).toLowerCase() !== "tool") continue;
    if (normalizeText(out.toolName).toLowerCase() !== "todolist") continue;
    return it;
  }
  return null;
}

function stripLeadingMentionsForCommand(text: string) {
  let t = typeof text === "string" ? text : "";
  while (t) {
    const before = t;
    t = t.replace(/^\s*<at\b[^>]*>[\s\S]*?<\/at>/i, "");
    t = t.replace(/^\s*[＠@][^\s:：,，]+/, "");
    t = t.replace(/^[\s:：,，]+/, "");
    if (t === before) break;
  }
  return t.trim();
}

function buildHelpText() {
  return [
    "命令：",
    "- /ss              列出最近会话",
    "- /ss <id|n>       绑定当前对话到会话",
    "- /n [workspaceId] 新建会话并绑定",
    "- /a               列出可选 agent",
    "- /a <id|n>        选择 agent",
    "- /p               切换 policy(self_only/session_all)",
    "- /st              查看状态（含 policy）",
    "- /l               查看最后一条 assistant 消息",
    "- /t               查看最近一条 todolist（别名 /todo；完成● 等待○ 进行中▶ 取消×）",
    "- /c               触发 compact",
    "- /h               帮助"
  ].join("\n");
}

function translateCurrentStatus(status: unknown) {
  const s = normalizeText(status).toLowerCase();
  if (s === "running") return "运行中";
  return "空闲";
}

function translateTerminalStatus(status: unknown) {
  const s = normalizeText(status).toLowerCase();
  if (s === "failed") return "失败";
  if (s === "completed") return "已完成";
  if (s === "cancelled" || s === "canceled") return "已取消";
  return "无";
}

function formatDurationMs(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}min ${seconds}s`;
  }
  return `${minutes}min ${seconds}s`;
}

function formatTokensK(value: number) {
  const n = Math.max(0, Math.floor(value));
  if (n === 0) return "0k";
  const k = n / 1000;
  if (k < 0.1) return "<0.1k";
  if (k >= 100) return `${Math.round(k)}k`;
  return `${k.toFixed(1).replace(/\.0$/, "")}k`;
}

function formatTokenUsageLine(summary: any) {
  const usedTokens = typeof summary?.runState?.lastResponseTotalTokens === "number" && Number.isFinite(summary.runState.lastResponseTotalTokens)
    ? Math.max(0, Math.floor(summary.runState.lastResponseTotalTokens))
    : null;
  const windowTokens = typeof summary?.contextWindowTokens === "number" && Number.isFinite(summary.contextWindowTokens)
    ? Math.max(1, Math.floor(summary.contextWindowTokens))
    : null;
  const ratio = typeof summary?.contextTokenRatio === "number" && Number.isFinite(summary.contextTokenRatio)
    ? Math.max(0, summary.contextTokenRatio)
    : null;

  if (usedTokens !== null && windowTokens !== null) {
    const pct = ratio !== null ? ratio * 100 : (usedTokens / windowTokens) * 100;
    const pctText = `${Math.round(pct)}%`;
    return `总Tokens：${formatTokensK(usedTokens)} / ${formatTokensK(windowTokens)}（${pctText}）`;
  }
  if (usedTokens !== null) {
    return `总Tokens：${formatTokensK(usedTokens)}`;
  }
  if (windowTokens !== null) {
    return `模型 Token 上限：${formatTokensK(windowTokens)}`;
  }
  return "";
}

function buildStatusText(summary: any, policy: string) {
  const sessionTitle = normalizeText(summary?.session?.title) || "未命名会话";
  const sessionId = normalizeText(summary?.session?.id);
  const workspaceId = normalizeText(summary?.session?.workspaceId);
  const workspaceLabel = normalizeText(summary?.session?.workspaceTitle) || normalizeText(summary?.session?.workspaceDirName) || workspaceId;
  const agentName = normalizeText(summary?.agent?.name);
  const currentStatus = translateCurrentStatus(summary?.runState?.status);
  const terminalStatus = translateTerminalStatus(summary?.runState?.terminalStatus ?? summary?.runState?.lastTerminalStatus);
  const lastRun = summary?.runState?.lastRun;
  const lastRunDurationMs = typeof lastRun?.durationMs === "number" && Number.isFinite(lastRun.durationMs)
    ? Math.max(0, Math.floor(lastRun.durationMs))
    : null;
  const elapsedMs = typeof summary?.elapsedMs === "number" && Number.isFinite(summary.elapsedMs)
    ? Math.max(0, Math.floor(summary.elapsedMs))
    : null;
  const lines = [
    `会话：${sessionTitle}`,
    `会话 ID：${sessionId || "无"}`,
    `工作区：${workspaceLabel || "无"}`,
    `工作区 ID：${workspaceId || "无"}`,
    `智能体：${agentName || "未选择"}`,
    `当前状态：${currentStatus}`,
    `上次结果：${terminalStatus}`,
    `接收消息策略：${policyLabel(policy as any)}`
  ];
  if (currentStatus === "运行中") {
    if (elapsedMs !== null) {
      lines.push(`本次运行时长：${formatDurationMs(elapsedMs)}`);
    }
  } else if (lastRun && typeof lastRun === "object") {
    if (lastRunDurationMs !== null) {
      lines.push(`上次运行时长：${formatDurationMs(lastRunDurationMs)}`);
    }
  }
  const tokenUsageLine = formatTokenUsageLine(summary);
  if (tokenUsageLine) {
    lines.push(tokenUsageLine);
  }
  return lines.join("\n");
}

// ---------------- gateway (Lark WS protocol, simplified) ----------------
function encodeVarint(n: number) {
  let v = BigInt(n);
  const out: number[] = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeKey(fieldNo: number, wireType: number) {
  return encodeVarint((fieldNo << 3) | wireType);
}

function encodeBytesField(fieldNo: number, bytes: Uint8Array) {
  return concatBytes([encodeKey(fieldNo, 2), encodeVarint(bytes.length), bytes]);
}

function encodeStringField(fieldNo: number, str: string) {
  return encodeBytesField(fieldNo, new TextEncoder().encode(str));
}

function encodeInt32Field(fieldNo: number, v: number) {
  return concatBytes([encodeKey(fieldNo, 0), encodeVarint(v >>> 0)]);
}

function encodeUint64Field(fieldNo: number, v: number) {
  return concatBytes([encodeKey(fieldNo, 0), encodeVarint(v)]);
}

function encodeHeaderMessage(key: string, value: string) {
  return concatBytes([encodeStringField(1, key), encodeStringField(2, value)]);
}

function encodeRepeatedHeader(fieldNo: number, key: string, value: string) {
  const msg = encodeHeaderMessage(key, value);
  return concatBytes([encodeKey(fieldNo, 2), encodeVarint(msg.length), msg]);
}

function encodeFrame(frame: any) {
  const chunks: Uint8Array[] = [];
  chunks.push(encodeUint64Field(1, frame.SeqID ?? 0));
  chunks.push(encodeUint64Field(2, frame.LogID ?? 0));
  chunks.push(encodeInt32Field(3, frame.service ?? 0));
  chunks.push(encodeInt32Field(4, frame.method ?? 0));
  for (const h of frame.headers ?? []) {
    chunks.push(encodeRepeatedHeader(5, h.key, h.value));
  }
  if (frame.payloadEncoding) chunks.push(encodeStringField(6, frame.payloadEncoding));
  if (frame.payloadType) chunks.push(encodeStringField(7, frame.payloadType));
  if (frame.payload) chunks.push(encodeBytesField(8, frame.payload));
  return concatBytes(chunks);
}

function decodeVarint(buf: Uint8Array, pos: number) {
  let shift = 0n;
  let result = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = BigInt(buf[p]!);
    result |= (b & 0x7fn) << shift;
    p += 1;
    if ((b & 0x80n) === 0n) break;
    shift += 7n;
  }
  return { value: result, next: p };
}

function decodeKey(buf: Uint8Array, pos: number) {
  const { value, next } = decodeVarint(buf, pos);
  const key = Number(value);
  return { fieldNo: key >>> 3, wireType: key & 7, next };
}

function decodeBytes(buf: Uint8Array, pos: number) {
  const { value: lenV, next } = decodeVarint(buf, pos);
  const len = Number(lenV);
  const end = next + len;
  return { bytes: buf.slice(next, end), next: end };
}

function decodeString(buf: Uint8Array, pos: number) {
  const { bytes, next } = decodeBytes(buf, pos);
  return { str: new TextDecoder().decode(bytes), next };
}

function decodeHeaderMessage(buf: Uint8Array) {
  let p = 0;
  let key = "";
  let value = "";
  while (p < buf.length) {
    const k = decodeKey(buf, p);
    p = k.next;
    if (k.wireType !== 2) {
      const sk = decodeVarint(buf, p);
      p = sk.next;
      continue;
    }
    if (k.fieldNo === 1) {
      const d = decodeString(buf, p);
      key = d.str;
      p = d.next;
    } else if (k.fieldNo === 2) {
      const d = decodeString(buf, p);
      value = d.str;
      p = d.next;
    } else {
      const d = decodeBytes(buf, p);
      p = d.next;
    }
  }
  return { key, value };
}

function decodeFrame(buf: Uint8Array) {
  let p = 0;
  const frame: any = { headers: [] as Array<{ key: string; value: string }> };
  while (p < buf.length) {
    const k = decodeKey(buf, p);
    p = k.next;
    if (k.wireType === 0) {
      const v = decodeVarint(buf, p);
      p = v.next;
      const num = Number(v.value);
      if (k.fieldNo === 1) frame.SeqID = num;
      else if (k.fieldNo === 2) frame.LogID = num;
      else if (k.fieldNo === 3) frame.service = num;
      else if (k.fieldNo === 4) frame.method = num;
      continue;
    }
    if (k.wireType === 2) {
      const d = decodeBytes(buf, p);
      p = d.next;
      if (k.fieldNo === 5) frame.headers.push(decodeHeaderMessage(d.bytes));
      else if (k.fieldNo === 8) frame.payload = d.bytes;
      continue;
    }
    break;
  }
  return frame;
}

function headersToMap(headers: Array<{ key: string; value: string }> | undefined) {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    if (h && typeof h.key === "string") out[h.key] = String(h.value ?? "");
  }
  return out;
}

function createGateway(params: GatewayStartParams): FeishuGateway {
  const { appId, appSecret, botOpenId, apiOrigin, internalToken, logger, domain, dataDir } = {
    ...params.config,
    apiOrigin: params.apiOrigin,
    internalToken: params.internalToken,
    logger: params.logger,
    dataDir: params.dataDir
  };

  const INCOMING_TEXT_SUFFIX = "\n---\n本消息来自飞书，不支持markdown";

  function formatIncomingText(text: string) {
    const normalized = (typeof text === "string" ? text : "").trimEnd();
    const footerHint = "本消息来自飞书，不支持markdown";
    const tailText = normalized.slice(-200);
    if (tailText.includes(footerHint)) {
      return normalized;
    }
    return `${normalized}${INCOMING_TEXT_SUFFIX}`;
  }

  const baseDomain = normalizeText(domain) === "https://open.larksuite.com" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  const store = createFeishuStore({ dataDir });
  const client = createInternalClient({ apiOrigin, internalToken });

  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof sleepTimeout> | null = null;
  let pingTimer: ReturnType<typeof sleepTimeout> | null = null;
  let sseAbort: AbortController | null = null;

  let tokenCache: { token: string; expiresAt: number } | null = null;
  let sseLoopTask: Promise<void> | null = null;
  let storeClosed = false;

  async function requestFeishuJson(action: string, input: RequestInfo | URL, init?: RequestInit): Promise<Record<string, any>> {
    const res = await fetch(input, init);
    const rawText = await res.text();
    const body = safeJsonParse(rawText);
    if (!res.ok) {
      throw new Error(`[feishu] ${action} http ${res.status}: ${rawText.slice(0, 200)}`);
    }
    const record = toRecord(body);
    if (!record) {
      throw new Error(`[feishu] ${action} invalid json body`);
    }
    const code = Number(record.code ?? 0);
    if (!Number.isFinite(code) || code !== 0) {
      throw new Error(
        `[feishu] ${action} failed: code=${String(record.code)} msg=${normalizeText(record.msg) || "unknown"}`
      );
    }
    return record;
  }

  async function getTenantAccessToken() {
    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt > now + 10_000) return tokenCache.token;
    const res = await requestFeishuJson(
      "get tenant access token",
      `${baseDomain}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret })
      }
    );
    const token = normalizeText(res.tenant_access_token);
    if (!token) throw new Error(`[feishu] get tenant access token failed: missing tenant_access_token`);
    const expiresIn = Number(res.expire ?? 7200);
    tokenCache = { token, expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000 };
    return token;
  }

  async function replyText(chatId: string, messageId: string, text: string) {
    const token = await getTenantAccessToken();
    await requestFeishuJson("reply message", `${baseDomain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) })
    });
  }

  async function sendText(chatId: string, text: string) {
    const token = await getTenantAccessToken();
    await requestFeishuJson("send message", `${baseDomain}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text })
      })
    });
  }

  async function checkSenderRole(senderId: string) {
    try {
      const allow = await client.post("/api/internal/agent/channels/allowlist/check", { pluginId: "feishu", senderId });
      const role = normalizeText(allow?.role).toLowerCase();
      return {
        role: role === "admin" ? "admin" : role === "user" ? "user" : "none",
        allowed: Boolean(allow?.allowed)
      };
    } catch {
      return { role: "none", allowed: false };
    }
  }

  async function fetchContextItemsTail(sessionId: string, tailLimit: number) {
    const res = await client.post("/api/internal/agent/sessions/context-items-tail", {
      pluginId: "feishu",
      sessionId,
      tailLimit
    }, { pluginId: "feishu" });
    return Array.isArray(res?.items) ? res.items : [];
  }

  async function listWorkspaces() {
    const res = await client.get("/api/internal/agent/workspaces/list?limit=10");
    return Array.isArray(res?.items) ? res.items : [];
  }

  async function listRecentSessions() {
    const res = await client.post("/api/internal/agent/sessions/recent", { kind: "primary", limit: 10 });
    const items = Array.isArray(res?.items) ? res.items : [];
    return items.filter((it: any) => {
      const kind = normalizeText(it?.kind).toLowerCase();
      return kind !== "subtask";
    });
  }

  async function listAgents(workspaceId: string) {
    const res = await client.post("/api/internal/agent/agents/list", { workspaceId, surface: "user" });
    return Array.isArray(res?.agents) ? res.agents : [];
  }

  async function queryFinalText(runId: string) {
    const res = await client.get(`/api/internal/agent/runs/${encodeURIComponent(runId)}/final-text`);
    return { found: Boolean(res?.found), text: normalizeText(res?.text) };
  }

  async function handleRunCompleted(event: RunCompletedEvent) {
    if (event.finalStatus !== "completed") return;
    const compactPending = store.getCompactPending(event.runId);
    if (compactPending) {
      if (store.hasSent(event.eventId, compactPending.chatKey)) return;
      await replyText(compactPending.chatId, compactPending.messageId, "压缩完成");
      store.saveSent(event.eventId, compactPending.chatKey, event.runId);
      store.deleteCompactPending(event.runId);
      return;
    }

    const runMap = store.getRunMap(event.runId);
    if (runMap) {
      const binding = store.getBinding(runMap.chatKey);
      if (!binding) return;
      if (store.hasSent(event.eventId, runMap.chatKey)) return;
      const finalText = await queryFinalText(event.runId);
      if (!finalText.found) return;
      await replyText(binding.chatId, runMap.messageId, finalText.text || "(empty)");
      store.saveSent(event.eventId, runMap.chatKey, event.runId);
      store.deleteRunMap(event.runId);
      return;
    }

    const bindings = store.listBindingsBySession(event.sessionId);
    if (bindings.length === 0) return;
    const finalText = await queryFinalText(event.runId);
    if (!finalText.found) return;

    for (const binding of bindings) {
      const policy = store.getPolicy(binding.chatKey);
      if (!shouldBroadcastToChat({ policy, hasRunMap: false })) continue;
      if (store.hasSent(event.eventId, binding.chatKey)) continue;
      await sendText(binding.chatId, finalText.text || "(empty)");
      store.saveSent(event.eventId, binding.chatKey, event.runId);
    }
  }

  function parseSseEventBlock(block: string): { event?: string; data?: string } {
    const lines = block.split(/\r?\n/g);
    let event = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    return { event, data: dataLines.join("\n") };
  }

  async function startSseLoop() {
    while (!stopped) {
      try {
        sseAbort = new AbortController();
        const res = await fetch(`${apiOrigin}/api/internal/agent/events/sse`, {
          method: "GET",
          headers: { "x-awb-agent-internal-token": internalToken },
          signal: sseAbort.signal
        });
        if (!res.ok || !res.body) throw new Error(`sse connect failed: ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx = buffer.indexOf("\n\n");
          while (idx >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const parsed = parseSseEventBlock(block);
            if (parsed.event === "agent.run.completed.v1" && parsed.data) {
              const event = safeJsonParse(parsed.data) as RunCompletedEvent | null;
              if (event && event.eventType === "agent.run.completed.v1") {
                try {
                  await handleRunCompleted(event);
                } catch (err) {
                  logger.warn(
                    `[feishu] handle run.completed failed: ${err instanceof Error ? err.message : String(err)}`
                  );
                }
              }
            }
            idx = buffer.indexOf("\n\n");
          }
        }
      } catch (e) {
        if (!stopped) {
          logger.warn(`[feishu] sse loop error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (!stopped) {
        await new Promise((r) => sleepTimeout(r, 3000));
      }
    }
  }

  async function handleCommand(ctx: MessageEventContext, binding: ChatBinding | null, cmd: { cmd: string; arg: string }) {
    if (cmd.cmd === "/h") {
      await replyText(ctx.chatId, ctx.messageId, buildHelpText());
      return;
    }

    if (cmd.cmd === "/p") {
      const next = store.togglePolicy(buildChatKey(ctx.chatId));
      await replyText(ctx.chatId, ctx.messageId, `已切换 policy：${policyLabel(next)}`);
      return;
    }

    if (cmd.cmd === "/ws") {
      const items = await listWorkspaces();
      if (items.length === 0) {
        await replyText(ctx.chatId, ctx.messageId, "暂无 workspace");
        return;
      }
      const text = items
        .slice(0, 10)
        .map((w: any, i: number) => `${i + 1}. ${normalizeText(w.title) || normalizeText(w.dirName) || normalizeText(w.id)} (${normalizeText(w.id)})`)
        .join("\n");
      await replyText(ctx.chatId, ctx.messageId, text);
      return;
    }

    if (cmd.cmd === "/ss") {
      if (!normalizeText(cmd.arg)) {
        const items = await listRecentSessions();
        if (items.length === 0) {
          await replyText(ctx.chatId, ctx.messageId, "暂无会话");
          return;
        }
        const lines = items
          .slice(0, 10)
          .map((it: any, i: number) => `${i + 1}. ${normalizeText(it.sessionTitle) || "(untitled)"} (${it.sessionId}) @ ${normalizeText(it.workspaceTitle) || normalizeText(it.workspaceId)}`);
        await replyText(ctx.chatId, ctx.messageId, lines.join("\n"));
        return;
      }
      const items = await listRecentSessions();
      const target = resolveIndexOrId(cmd.arg, items.map((s: any) => ({ id: String(s.sessionId) })));
      const selected = items.find((s: any) => String(s.sessionId) === target);
      if (!selected) {
        await replyText(ctx.chatId, ctx.messageId, "参数错误：/ss <sessionId|index>");
        return;
      }
      const current = binding ?? store.upsertBinding({ chatKey: buildChatKey(ctx.chatId), chatId: ctx.chatId, chatType: ctx.chatType });
      let nextAgentId = normalizeText(current?.agentId);
      if (nextAgentId) {
        const agents = await listAgents(String(selected.workspaceId));
        const canKeep = agents.some((a: any) => normalizeText(a.id) === nextAgentId);
        if (!canKeep) {
          nextAgentId = "";
        }
      }
      store.upsertBinding({
        chatKey: buildChatKey(ctx.chatId),
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        workspaceId: String(selected.workspaceId),
        sessionId: String(selected.sessionId),
        agentId: nextAgentId || null
      });
      await replyText(
        ctx.chatId,
        ctx.messageId,
        nextAgentId
          ? `已绑定会话：${normalizeText(selected.sessionTitle) || "(untitled)"} (${selected.sessionId})，保持 agent: ${nextAgentId}`
          : `已绑定会话：${normalizeText(selected.sessionTitle) || "(untitled)"} (${selected.sessionId})，请使用 /a 选择 agent`
      );
      return;
    }

    if (cmd.cmd === "/n") {
      const targetWorkspaceId = normalizeText(cmd.arg) || normalizeText(binding?.workspaceId);
      if (!targetWorkspaceId) {
        await replyText(ctx.chatId, ctx.messageId, "请先指定 workspace：/n <workspaceId>");
        return;
      }
      const created = await client.post("/api/internal/agent/sessions/create", { workspaceId: targetWorkspaceId, title: "new session" });
      const current = binding ?? store.upsertBinding({ chatKey: buildChatKey(ctx.chatId), chatId: ctx.chatId, chatType: ctx.chatType });
      let nextAgentId = normalizeText(current?.agentId);
      if (nextAgentId) {
        const agents = await listAgents(targetWorkspaceId);
        if (!agents.some((a: any) => normalizeText(a.id) === nextAgentId)) {
          nextAgentId = "";
        }
      }
      store.upsertBinding({
        chatKey: buildChatKey(ctx.chatId),
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        workspaceId: targetWorkspaceId,
        sessionId: normalizeText(created?.id),
        agentId: nextAgentId || null
      });
      await replyText(
        ctx.chatId,
        ctx.messageId,
        nextAgentId
          ? `已新建并切换会话：${normalizeText(created?.title) || "(untitled)"} (${normalizeText(created?.id)})，保持 agent: ${nextAgentId}`
          : `已新建并切换会话：${normalizeText(created?.title) || "(untitled)"} (${normalizeText(created?.id)})，请使用 /a 选择 agent`
      );
      return;
    }

    if (cmd.cmd === "/a") {
      const workspaceId = normalizeText(binding?.workspaceId);
      if (!workspaceId) {
        await replyText(ctx.chatId, ctx.messageId, "请先使用 /ss 绑定会话");
        return;
      }
      const agents = await listAgents(workspaceId);
      if (!normalizeText(cmd.arg)) {
        const lines = agents.map((a: any, i: number) => `${i + 1}. ${normalizeText(a.name) || "(unknown)"} (${normalizeText(a.id)})`);
        await replyText(
          ctx.chatId,
          ctx.messageId,
          lines.length > 0 ? lines.join("\n") : "当前 workspace 未启用任何可用 agent，请先在 Web 端工作区中启用后再试 /a"
        );
        return;
      }
      const target = resolveIndexOrId(cmd.arg, agents.map((a: any) => ({ id: String(a.id) })));
      if (!target || !agents.some((a: any) => normalizeText(a.id) === target)) {
        await replyText(ctx.chatId, ctx.messageId, "参数错误：/a <agentId|index>");
        return;
      }
      const current = binding ?? store.upsertBinding({ chatKey: buildChatKey(ctx.chatId), chatId: ctx.chatId, chatType: ctx.chatType });
      store.upsertBinding({
        chatKey: buildChatKey(ctx.chatId),
        chatId: ctx.chatId,
        chatType: ctx.chatType,
        workspaceId: current?.workspaceId,
        sessionId: current?.sessionId,
        agentId: target
      });
      await replyText(ctx.chatId, ctx.messageId, `已选择 agent：${target}`);
      return;
    }

    if (cmd.cmd === "/c") {
      const sessionId = normalizeText(binding?.sessionId);
      const workspaceId = normalizeText(binding?.workspaceId);
      if (!sessionId || !workspaceId) {
        await replyText(ctx.chatId, ctx.messageId, "请先使用 /ss 绑定会话");
        return;
      }
      try {
        const result = await client.post(`/api/internal/agent/sessions/${encodeURIComponent(sessionId)}/compact`, {
          workspaceId,
          clientRequestId: `im_feishu_${buildChatKey(ctx.chatId)}_${ctx.messageId}_compact`,
          ...(normalizeText(binding?.agentId) ? { agentId: normalizeText(binding?.agentId) } : {})
        });
        if (result?.scheduled) {
          const runId = normalizeText(result?.runId);
          if (runId) {
            store.mapCompactPending(runId, { chatKey: buildChatKey(ctx.chatId), chatId: ctx.chatId, messageId: ctx.messageId });
          }
          await replyText(ctx.chatId, ctx.messageId, "已触发 compact，正在处理…");
        } else {
          await replyText(ctx.chatId, ctx.messageId, "compact 已受理");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const statusCode = typeof (err as any)?.statusCode === "number" ? Number((err as any).statusCode) : 0;
        logger.warn(`[feishu] compact command failed: ${message}`);
        if (statusCode === 404) {
          await replyText(ctx.chatId, ctx.messageId, "compact 失败：会话或工作区不存在，请重新 /ss 绑定后再试");
        } else if (statusCode === 401) {
          await replyText(ctx.chatId, ctx.messageId, "compact 失败：鉴权失败，请联系管理员检查服务配置");
        } else if (statusCode === 400) {
          const errCode = normalizeText((err as any)?.code).toUpperCase();
          const lower = normalizeText(message).toLowerCase();
          if (errCode === "AGENT_COMPACTION_EMPTY" || errCode === "AGENT_COMPACTION_NOT_NEEDED") {
            await replyText(ctx.chatId, ctx.messageId, "compact 失败：当前会话暂无可压缩上下文");
          } else if (errCode === "AGENT_SUBTASK_READONLY") {
            await replyText(ctx.chatId, ctx.messageId, "compact 失败：子任务会话不支持压缩");
          } else if (lower.includes("workspaceid mismatch")) {
            await replyText(ctx.chatId, ctx.messageId, "compact 失败：会话与工作区不匹配，请重新 /ss 绑定后再试");
          } else if (lower.includes("clientrequestid is required")) {
            await replyText(ctx.chatId, ctx.messageId, "compact 失败：请求参数缺失，请稍后重试");
          } else {
            await replyText(ctx.chatId, ctx.messageId, "compact 失败：当前请求不满足压缩条件");
          }
        } else if (statusCode === 409) {
          await replyText(ctx.chatId, ctx.messageId, "compact 失败：当前会话正在运行，请稍后再试");
        } else if (statusCode === 503) {
          await replyText(ctx.chatId, ctx.messageId, "compact 失败：服务暂不可用，请稍后再试");
        } else {
          await replyText(ctx.chatId, ctx.messageId, `compact 失败：${message || "未知错误"}`);
        }
      }
      return;
    }

    if (cmd.cmd === "/l") {
      const sessionId = normalizeText(binding?.sessionId);
      const workspaceId = normalizeText(binding?.workspaceId);
      if (!sessionId || !workspaceId) {
        await replyText(ctx.chatId, ctx.messageId, "请先使用 /ss 绑定会话");
        return;
      }

      const agents = await listAgents(workspaceId);
      if (agents.length === 0) {
        await replyText(ctx.chatId, ctx.messageId, "当前 workspace 未启用任何可用 agent，请先在 Web 端工作区中启用后再试 /a");
        return;
      }
      const selectedAgentId = normalizeText(binding?.agentId);
      if (selectedAgentId && !agents.some((a: any) => normalizeText(a.id) === selectedAgentId)) {
        await replyText(ctx.chatId, ctx.messageId, "当前 workspace 已禁用已绑定 agent，请重新执行 /a 选择可用 agent");
        return;
      }

      let summary: any;
      try {
        summary = await client.post("/api/internal/agent/sessions/status-summary", {
          sessionId,
          selectedAgentId: selectedAgentId || undefined
        });
      } catch (err) {
        const errCode = normalizeText((err as any)?.code).toUpperCase();
        if (errCode === "AGENT_DISABLED_IN_WORKSPACE") {
          await replyText(ctx.chatId, ctx.messageId, "当前 workspace 已禁用已绑定 agent，请重新执行 /a 选择可用 agent");
          return;
        }
        if (errCode === "AGENT_NO_AVAILABLE_IN_WORKSPACE") {
          await replyText(ctx.chatId, ctx.messageId, "当前 workspace 未启用任何可用 agent，请先在 Web 端工作区中启用后再试 /a");
          return;
        }
        throw err;
      }

      if (normalizeText(summary?.runState?.status).toLowerCase() === "running") {
        await replyText(ctx.chatId, ctx.messageId, "正在运行中，请稍后再试");
        return;
      }
      const items = await fetchContextItemsTail(sessionId, 1);
      const item = items[items.length - 1];
      const text = normalizeText(item?.output?.text);
      await replyText(ctx.chatId, ctx.messageId, text || "当前会话暂无消息");
      return;
    }

    if (cmd.cmd === "/t") {
      const sessionId = normalizeText(binding?.sessionId);
      const workspaceId = normalizeText(binding?.workspaceId);
      if (!sessionId || !workspaceId) {
        await replyText(ctx.chatId, ctx.messageId, "请先使用 /ss 绑定会话");
        return;
      }

      const agents = await listAgents(workspaceId);
      if (agents.length === 0) {
        await replyText(ctx.chatId, ctx.messageId, "当前 workspace 未启用任何可用 agent，请先在 Web 端工作区中启用后再试 /a");
        return;
      }
      const selectedAgentId = normalizeText(binding?.agentId);
      if (selectedAgentId && !agents.some((a: any) => normalizeText(a.id) === selectedAgentId)) {
        await replyText(ctx.chatId, ctx.messageId, "当前 workspace 已禁用已绑定 agent，请重新执行 /a 选择可用 agent");
        return;
      }

      let summary: any;
      try {
        summary = await client.post("/api/internal/agent/sessions/status-summary", {
          sessionId,
          selectedAgentId: selectedAgentId || undefined
        });
      } catch (err) {
        const errCode = normalizeText((err as any)?.code).toUpperCase();
        if (errCode === "AGENT_DISABLED_IN_WORKSPACE") {
          await replyText(ctx.chatId, ctx.messageId, "当前 workspace 已禁用已绑定 agent，请重新执行 /a 选择可用 agent");
          return;
        }
        if (errCode === "AGENT_NO_AVAILABLE_IN_WORKSPACE") {
          await replyText(ctx.chatId, ctx.messageId, "当前 workspace 未启用任何可用 agent，请先在 Web 端工作区中启用后再试 /a");
          return;
        }
        throw err;
      }

      if (normalizeText(summary?.runState?.status).toLowerCase() === "running") {
        await replyText(ctx.chatId, ctx.messageId, "正在运行中，请稍后再试");
        return;
      }

      // 只取尾部一段上下文：优先用较小窗口；找不到再扩大窗口。
      // 经验值：todolist 往往靠近会话尾部，但也可能因长对话而被推远。
      let toolItem: any | null = null;
      for (const tailLimit of [200, 500]) {
        const items = await fetchContextItemsTail(sessionId, tailLimit);
        toolItem = findLatestTodolistToolItem(items);
        if (toolItem) break;
      }
      if (!toolItem) {
        await replyText(ctx.chatId, ctx.messageId, "当前会话未找到 todolist 记录（仅扫描最近 500 条上下文）");
        return;
      }
      const text = formatTodolistToolOutput(toolItem.output);
      await replyText(ctx.chatId, ctx.messageId, text);
      return;
    }

    if (cmd.cmd === "/st") {
      const sessionId = normalizeText(binding?.sessionId);
      if (!sessionId) {
        await replyText(ctx.chatId, ctx.messageId, `状态：未绑定会话\n请先使用 /ss 绑定会话\n当前策略：${policyLabel(store.getPolicy(buildChatKey(ctx.chatId)))}`);
        return;
      }

      const workspaceId = normalizeText(binding?.workspaceId);
      if (!workspaceId) {
        await replyText(ctx.chatId, ctx.messageId, "状态：未绑定工作区\n请先使用 /ss 绑定会话");
        return;
      }
      const agents = await listAgents(workspaceId);
      if (agents.length === 0) {
        await replyText(ctx.chatId, ctx.messageId, "当前 workspace 未启用任何可用 agent，请先在 Web 端工作区中启用后再试 /a");
        return;
      }
      const selectedAgentId = normalizeText(binding?.agentId);
      if (selectedAgentId && !agents.some((a: any) => normalizeText(a.id) === selectedAgentId)) {
        await replyText(ctx.chatId, ctx.messageId, "当前 workspace 已禁用已绑定 agent，请重新执行 /a 选择可用 agent");
        return;
      }

      let summary: any;
      try {
        summary = await client.post("/api/internal/agent/sessions/status-summary", {
          sessionId,
          selectedAgentId: selectedAgentId || undefined
        });
      } catch (err) {
        const errCode = normalizeText((err as any)?.code).toUpperCase();
        if (errCode === "AGENT_DISABLED_IN_WORKSPACE") {
          await replyText(ctx.chatId, ctx.messageId, "当前 workspace 已禁用已绑定 agent，请重新执行 /a 选择可用 agent");
          return;
        }
        if (errCode === "AGENT_NO_AVAILABLE_IN_WORKSPACE") {
          await replyText(ctx.chatId, ctx.messageId, "当前 workspace 未启用任何可用 agent，请先在 Web 端工作区中启用后再试 /a");
          return;
        }
        throw err;
      }

      const policy = store.getPolicy(buildChatKey(ctx.chatId));
      await replyText(ctx.chatId, ctx.messageId, buildStatusText(summary, policy));
      return;
    }

    await replyText(ctx.chatId, ctx.messageId, buildHelpText());
  }

  async function triggerRunFromMessage(ctx: MessageEventContext, binding: ChatBinding) {
    const workspaceId = normalizeText(binding.workspaceId);
    const sessionId = normalizeText(binding.sessionId);
    const agentId = normalizeText(binding.agentId);
    if (!workspaceId || !sessionId || !agentId) {
      await replyText(ctx.chatId, ctx.messageId, "请先设置 session 与 agent：先使用 /ss 绑定会话，再使用 /a 选择 agent");
      return;
    }

    try {
      const trigger = await client.post("/api/internal/agent/runs/trigger", {
        workspaceId,
        sessionId,
        agentId,
        text: formatIncomingText(ctx.text),
        clientRequestId: `im_feishu_${buildChatKey(ctx.chatId)}_${ctx.messageId}`
      });
      if (!trigger?.deduplicated) {
        store.mapRun(String(trigger.runId), buildChatKey(ctx.chatId), ctx.messageId);
      }
      await replyText(ctx.chatId, ctx.messageId, trigger?.deduplicated ? "已收到（重复消息已忽略）" : "已收到，开始处理…");
    } catch (err) {
      const errCode = normalizeText((err as any)?.code).toUpperCase();
      const message = err instanceof Error ? err.message : String(err);
      if (errCode === "AGENT_DISABLED_IN_WORKSPACE") {
        await replyText(ctx.chatId, ctx.messageId, "当前 workspace 已禁用该 agent，请重新执行 /a 选择可用 agent");
        return;
      }
      if (errCode === "AGENT_NO_AVAILABLE_IN_WORKSPACE") {
        await replyText(ctx.chatId, ctx.messageId, "当前 workspace 未启用任何可用 agent，请先在 Web 端工作区中启用后再试 /a");
        return;
      }
      await replyText(ctx.chatId, ctx.messageId, `发送失败：${message || "未知错误"}`);
    }
  }

  async function handleMessageEvent(ctx: MessageEventContext) {
    const chatKey = buildChatKey(ctx.chatId);
    const existing = store.getBinding(chatKey) ?? store.upsertBinding({ chatKey, chatId: ctx.chatId, chatType: ctx.chatType });
    const sender = await checkSenderRole(ctx.sender.id);

    let commandText = ctx.text;
    if (ctx.chatType === "group" && ctx.mentionedBot) {
      const stripped = stripLeadingMentionsForCommand(commandText);
      if (stripped) commandText = stripped;
    }
    const cmd = parseCommand(commandText);
    if (cmd) {
      if (sender.role !== "admin") {
        await replyText(ctx.chatId, ctx.messageId, sender.role === "none" ? `请联系我的主人添加白名单。open_id: ${ctx.sender.id}` : "无权限：仅管理员可执行命令");
        return;
      }
      await handleCommand({ ...ctx, text: commandText }, existing, cmd);
      return;
    }

    if (!sender.allowed) return;
    if (ctx.chatType === "group") {
      if (!ctx.mentionedBot) return;
      await triggerRunFromMessage({ ...ctx, text: stripLeadingMentionsForCommand(ctx.text) || ctx.text }, existing);
      return;
    }
    await triggerRunFromMessage(ctx, existing);
  }

  async function pullConnectConfig() {
    const res = await fetch(`${baseDomain}/callback/ws/endpoint`, {
      method: "POST",
      headers: { "content-type": "application/json", locale: "zh" },
      body: JSON.stringify({ AppID: appId, AppSecret: appSecret })
    });
    const data = await res.json();
    if (!data || data.code !== 0 || !data.data?.URL) {
      throw new Error(`failed to pull ws endpoint: ${normalizeText(data?.msg) || res.status}`);
    }
    const qs = new URL(data.data.URL);
    const serviceId = qs.searchParams.get("service_id") || "0";
    const cfg = data.data.ClientConfig || {};
    return {
      url: String(data.data.URL),
      serviceId,
      pingIntervalMs: Number(cfg.PingInterval || 120) * 1000,
      reconnectIntervalMs: Number(cfg.ReconnectInterval || 120) * 1000,
      reconnectNonceMs: Number(cfg.ReconnectNonce || 30) * 1000
    };
  }

  function scheduleReconnect(delayMs: number, nonceMs: number) {
    if (reconnectTimer) clearSleepTimeout(reconnectTimer);
    const jitter = Math.max(0, Math.floor(Math.random() * Math.max(0, nonceMs || 0)));
    const finalDelayMs = Math.max(1000, (delayMs || 0) + jitter);
    reconnectTimer = sleepTimeout(() => {
      reconnectTimer = null;
      void connectLoop().catch((e) => logger.error(`[feishu] reconnect failed: ${e instanceof Error ? e.message : String(e)}`));
    }, finalDelayMs);
  }

  function startPingLoop(serviceId: string, intervalMs: number) {
    if (pingTimer) clearSleepTimeout(pingTimer);
    const tick = () => {
      if (stopped) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          encodeFrame({
            headers: [{ key: "type", value: "ping" }],
            service: Number(serviceId || 0),
            method: 0,
            SeqID: 0,
            LogID: 0
          })
        );
      }
      pingTimer = sleepTimeout(tick, intervalMs);
    };
    pingTimer = sleepTimeout(tick, intervalMs);
  }

  async function parseMessagePayload(payload: any): Promise<MessageEventContext | null> {
    const header = toRecord(payload?.header) ?? {};
    const event = toRecord(payload?.event) ?? {};
    const eventType = normalizeText(header.event_type);
    if (eventType !== "im.message.receive_v1") return null;

    const message = toRecord(event.message) ?? {};
    const sender = toRecord(event.sender) ?? {};
    const senderIdObj = toRecord(sender.sender_id) ?? {};

    const messageId = normalizeText(message.message_id) || normalizeText(header.event_id) || `${normalizeText(message.chat_id)}_${Date.now()}`;
    const chatId = normalizeText(message.chat_id);
    const chatType = normalizeText(message.chat_type) === "group" ? "group" : "direct";
    const senderId = normalizeText(senderIdObj.open_id) || normalizeText(senderIdObj.user_id) || normalizeText(senderIdObj.union_id);

    const contentType = normalizeText(message.message_type);
    let text = "";
    if (contentType === "text") {
      const parsed = safeJsonParse(message.content);
      text = normalizeText(parsed && typeof parsed.text === "string" ? parsed.text : message.content);
    }

    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    let mentionedBot = mentions.length > 0;
    if (normalizeText(botOpenId)) {
      mentionedBot = mentions.some((m) => {
        const id = toRecord(toRecord(m)?.id) ?? {};
        return normalizeText(id.open_id) === normalizeText(botOpenId);
      });
    }

    if (!chatId || !senderId || !text) return null;
    return { messageId, chatId, chatType, sender: { id: senderId }, mentionedBot, text };
  }

  async function connectLoop() {
    if (stopped) return;
    const cfg = await pullConnectConfig();
    if (stopped) return;

    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }

    ws = new WebSocket(cfg.url);
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      logger.info(`[feishu] ws connected: ${cfg.url}`);
      startPingLoop(cfg.serviceId, cfg.pingIntervalMs || 120_000);
    });

    ws.addEventListener("close", () => {
      if (stopped) return;
      logger.warn("[feishu] ws closed; scheduling reconnect");
      scheduleReconnect(cfg.reconnectIntervalMs || 120_000, cfg.reconnectNonceMs || 0);
    });

    ws.addEventListener("error", () => {
      if (stopped) return;
      logger.warn("[feishu] ws error; scheduling reconnect");
      scheduleReconnect(cfg.reconnectIntervalMs || 120_000, cfg.reconnectNonceMs || 0);
    });

    ws.addEventListener("message", async (ev: MessageEvent) => {
      let frame: any = null;
      const startAt = Date.now();
      try {
        frame = decodeFrame(new Uint8Array(ev.data as ArrayBuffer));
        if (frame.method === 0) return;
        const headers = headersToMap(frame.headers);
        if (headers.type !== "event") return;
        if (!frame.payload) return;

        const payloadText = new TextDecoder().decode(frame.payload);
        const payload = safeJsonParse(payloadText);
        if (!payload) return;
        const msg = await parseMessagePayload(payload);
        if (msg) await handleMessageEvent(msg);

        const ackFrame = {
          ...frame,
          headers: [...(frame.headers || []), { key: "biz_rt", value: String(Date.now() - startAt) }],
          payload: new TextEncoder().encode(JSON.stringify({ code: 200 }))
        };
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeFrame(ackFrame));
      } catch (e) {
        logger.error(`[feishu] ws message handling failed: ${e instanceof Error ? e.message : String(e)}`);
        try {
          if (ws && ws.readyState === WebSocket.OPEN && frame) {
            ws.send(
              encodeFrame({
                ...frame,
                headers: [...(frame.headers || []), { key: "biz_rt", value: String(Date.now() - startAt) }],
                payload: new TextEncoder().encode(JSON.stringify({ code: 500 }))
              })
            );
          }
        } catch {
          // ignore
        }
      }
    });
  }

  const gateway: FeishuGateway = {
    async start() {
      stopped = false;
      void startSseLoop();
      await connectLoop();
    },
    async stop() {
      stopped = true;
      if (sseAbort) {
        try {
          sseAbort.abort();
        } catch {
          // ignore
        }
        sseAbort = null;
      }
      if (reconnectTimer) {
        clearSleepTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pingTimer) {
        clearSleepTimeout(pingTimer);
        pingTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        ws = null;
      }
      const runningSse = sseLoopTask;
      sseLoopTask = null;
      if (runningSse) {
        try {
          await runningSse;
        } catch {
          // ignore
        }
      }
      if (!storeClosed) {
        store.close();
        storeClosed = true;
      }
    },
    async replyText(chatId: string, messageId: string, text: string) {
      await replyText(chatId, messageId, text);
    },
    async sendText(chatId: string, text: string) {
      await sendText(chatId, text);
    }
  };

  gateway.start = async () => {
    if (storeClosed) throw new Error("[feishu] gateway already stopped");
    stopped = false;
    try {
      sseLoopTask = startSseLoop();
      await connectLoop();
    } catch (err) {
      await gateway.stop();
      throw err;
    }
  };

  return gateway;
}

export default {
  meta: {
    id: "feishu",
    name: "Feishu IM",
    version: "0.2.0",
    description: "飞书 IM 渠道插件（TS 重写 + SSE 广播）"
  },
  services: {
    gateway: {
      async start(params: GatewayStartParams) {
        const gw = createGateway(params);
        await gw.start();
        return {
          replyText: async ({ chatId, messageId, text }: { chatId: string; messageId: string; text: string }) => {
            await gw.replyText(chatId, messageId, text);
          },
          sendText: async ({ chatId, text }: { chatId: string; text: string }) => {
            await gw.sendText(chatId, text);
          },
          stop: async () => {
            await gw.stop();
          }
        };
      }
    }
  },
  channels: {
    im: {}
  }
};
