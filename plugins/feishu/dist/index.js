// Feishu IM plugin fixture (dist)
// Note: this file is loaded by agent-workbench plugin runtime via dynamic import.
// It intentionally avoids external dependencies besides Node built-ins.

import { setTimeout as sleepTimeout, clearTimeout as clearSleepTimeout } from "node:timers";
import { pathToFileURL } from "node:url";

function toRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}

function safeJsonParse(raw) {
  if (typeof raw !== "string") return null;
  const txt = raw.trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function normalizeText(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}

function formatWorkspaceLabel(item) {
  const title = normalizeText(item.workspaceTitle) || normalizeText(item.workspaceDirName);
  return title || item.workspaceId;
}

function buildConversationKey(accountId, chatId) {
  // Per doc: avoid ':'
  return `feishu_${accountId}_chat_${chatId}`;
}

function buildHelpText() {
  return [
    "命令：",
    "- /ws (/workspace)         列出最近使用的 workspace（最多 10 个）",
    "- /ss (/session)           列出最近会话（跨 workspace）",
    "- /ss (/session) <id|n>    绑定当前飞书会话到 session（保持已选 agent）",
    "- /n (/new) [workspaceId]  新建并切换会话；不传参=当前 workspace，传参=指定 workspace",
    "- /a (/agent)              列出可选 agent",
    "- /a (/agent) <id|n>       选择 agent",
    "- /c (/compact)            压缩当前会话上下文",
    "- /st (/status)            查看状态摘要",
    "- /h (/help)               帮助"
  ].join("\n");
}

const COMMAND_ALIAS_MAP = {
  "/agent": "/a",
  "/session": "/ss",
  "/help": "/h",
  "/status": "/st",
  "/new": "/n",
  "/workspace": "/ws",
  "/compact": "/c"
};

function normalizeCommandAlias(cmd) {
  const key = normalizeText(cmd).toLowerCase();
  return COMMAND_ALIAS_MAP[key] || key;
}

function parseCommand(text) {
  const t = normalizeText(text);
  if (!t.startsWith("/")) return null;
  const parts = t.split(/\s+/g).filter(Boolean);
  const cmd = normalizeCommandAlias(parts[0] || "");
  const arg = parts.length > 1 ? parts.slice(1).join(" ") : "";
  return { cmd, arg };
}

function stripLeadingMentionsForCommand(text) {
  let t = typeof text === "string" ? text : "";
  if (!t) return "";

  while (true) {
    const before = t;

    // 1) <at ...>...</at>
    t = t.replace(/^\s*<at\b[^>]*>[\s\S]*?<\/at>/i, "");

    // 2) @xxx / ＠xxx (until whitespace or common separators)
    t = t.replace(/^\s*[＠@][^\s:：,，]+/, "");

    // 3) separators and spaces between mention and command text
    t = t.replace(/^[\s:：,，]+/, "");

    if (t === before) break;
  }

  return t.replace(/^\s+/, "");
}

function resolveIndexOrId(arg, items) {
  const a = normalizeText(arg);
  if (!a) return null;
  if (/^\d+$/.test(a)) {
    const idx = Number(a);
    if (!Number.isFinite(idx) || idx <= 0) return null;
    return items[idx - 1] ? items[idx - 1].id : null;
  }
  return a;
}

function translateRunStatus(status) {
  const s = normalizeText(status).toLowerCase();
  if (s === "running") return "运行中";
  if (s === "completed") return "已完成";
  if (s === "failed") return "失败";
  if (s === "cancelled" || s === "canceled") return "已取消";
  if (s === "queued" || s === "pending") return "排队中";
  return status || "未知";
}

function formatWithThousands(value) {
  if (!Number.isFinite(value)) return String(value ?? "?");
  return new Intl.NumberFormat("en-US").format(value);
}

function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function buildStatusText(summary) {
  const lines = [];
  lines.push(`session: ${summary.session.title} (${summary.session.id})`);
  const workspaceLabel =
    normalizeText(summary.session.workspaceTitle) ||
    normalizeText(summary.session.workspaceDirName) ||
    summary.session.workspaceId;
  lines.push(`workspace: ${workspaceLabel}`);
  if (summary.agent) {
    lines.push(`agent: ${summary.agent.name || "(未命名)"}`);
  } else {
    lines.push("agent: (未选择)");
  }
  if (summary.runState) {
    const runStatusLabel = translateRunStatus(summary.runState.status);
    lines.push(`run: ${runStatusLabel}${summary.runState.activeRunId ? ` (${summary.runState.activeRunId})` : ""}`);
    if (summary.runState.runNoticeText) lines.push(`notice: ${summary.runState.runNoticeText}`);
    if (typeof summary.elapsedMs === "number") {
      lines.push(`elapsed: ${Math.floor(summary.elapsedMs / 1000)}s`);
    }
    if (typeof summary.contextWindowTokens === "number" && typeof summary.runState.lastResponseTotalTokens === "number") {
      const used = formatWithThousands(summary.runState.lastResponseTotalTokens);
      const total = formatWithThousands(summary.contextWindowTokens);
      const ratio = toFiniteNumber(summary.contextTokenRatio);
      const ratioText = ratio === null ? "" : ` (${Math.round(ratio * 100)}%)`;
      lines.push(`tokens: ${used}/${total}${ratioText}`);
    }
  }
  return lines.join("\n");
}

function createInternalClient(params) {
  const { apiOrigin, internalToken } = params;
  async function get(path, options) {
    const pluginId = String(options?.pluginId || "").trim();
    const res = await fetch(`${apiOrigin}${path}`, {
      method: "GET",
      headers: {
        "x-awb-agent-internal-token": internalToken,
        ...(pluginId ? { "x-awb-plugin-id": pluginId } : {})
      }
    });
    const txt = await res.text();
    let json = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      // ignore
    }
    if (!res.ok) {
      const msg = (json && typeof json.message === "string" && json.message) || txt || `http ${res.status}`;
      const code = (json && typeof json.code === "string" && json.code) || "";
      const err = new Error(`${msg}${code ? ` (${code})` : ""}`);
      err.statusCode = res.status;
      err.code = code;
      throw err;
    }
    return json;
  }

  async function post(path, body) {
    const pluginId = String(body?.pluginId || "").trim();
    const res = await fetch(`${apiOrigin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-awb-agent-internal-token": internalToken,
        ...(pluginId ? { "x-awb-plugin-id": pluginId } : {})
      },
      body: JSON.stringify(body ?? {})
    });
    const txt = await res.text();
    let json = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      // ignore
    }
    if (!res.ok) {
      const msg = (json && typeof json.message === "string" && json.message) || txt || `http ${res.status}`;
      const code = (json && typeof json.code === "string" && json.code) || "";
      const err = new Error(`${msg}${code ? ` (${code})` : ""}`);
      err.statusCode = res.status;
      err.code = code;
      throw err;
    }
    return json;
  }
  return { post, get };
}

// ---------------- gateway (Lark WS protocol, simplified) ----------------

function encodeVarint(n) {
  // n is non-negative integer within 2^53
  let v = BigInt(n);
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

function concatBytes(chunks) {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeKey(fieldNo, wireType) {
  return encodeVarint((fieldNo << 3) | wireType);
}

function encodeBytesField(fieldNo, bytes) {
  return concatBytes([encodeKey(fieldNo, 2), encodeVarint(bytes.length), bytes]);
}

function encodeStringField(fieldNo, str) {
  const bytes = new TextEncoder().encode(str);
  return encodeBytesField(fieldNo, bytes);
}

function encodeInt32Field(fieldNo, v) {
  return concatBytes([encodeKey(fieldNo, 0), encodeVarint(v >>> 0)]);
}

function encodeUint64Field(fieldNo, v) {
  return concatBytes([encodeKey(fieldNo, 0), encodeVarint(v)]);
}

function encodeHeaderMessage(key, value) {
  const parts = [encodeStringField(1, key), encodeStringField(2, value)];
  const msg = concatBytes(parts);
  return msg;
}

function encodeRepeatedHeader(fieldNo, key, value) {
  const msg = encodeHeaderMessage(key, value);
  return concatBytes([encodeKey(fieldNo, 2), encodeVarint(msg.length), msg]);
}

function encodeFrame(frame) {
  // Frame fields per larksuite/node-sdk pbbp2:
  // 1 SeqID(uint64),2 LogID(uint64),3 service(int32),4 method(int32),5 headers(repeated Header),6 payloadEncoding,7 payloadType,8 payload(bytes)
  const chunks = [];
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

function decodeVarint(buf, pos) {
  let shift = 0n;
  let result = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = BigInt(buf[p]);
    result |= (b & 0x7fn) << shift;
    p += 1;
    if ((b & 0x80n) === 0n) break;
    shift += 7n;
  }
  return { value: result, next: p };
}

function decodeKey(buf, pos) {
  const { value, next } = decodeVarint(buf, pos);
  const key = Number(value);
  return { fieldNo: key >>> 3, wireType: key & 7, next };
}

function decodeBytes(buf, pos) {
  const { value: lenV, next } = decodeVarint(buf, pos);
  const len = Number(lenV);
  const end = next + len;
  return { bytes: buf.slice(next, end), next: end };
}

function decodeString(buf, pos) {
  const { bytes, next } = decodeBytes(buf, pos);
  return { str: new TextDecoder().decode(bytes), next };
}

function decodeHeaderMessage(buf) {
  let p = 0;
  let key = "";
  let value = "";
  while (p < buf.length) {
    const k = decodeKey(buf, p);
    p = k.next;
    if (k.wireType !== 2) {
      // skip
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

function decodeFrame(buf) {
  let p = 0;
  const frame = { headers: [] };
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
      if (k.fieldNo === 5) {
        frame.headers.push(decodeHeaderMessage(d.bytes));
      } else if (k.fieldNo === 8) {
        frame.payload = d.bytes;
      } else if (k.fieldNo === 6) {
        frame.payloadEncoding = new TextDecoder().decode(d.bytes);
      } else if (k.fieldNo === 7) {
        frame.payloadType = new TextDecoder().decode(d.bytes);
      }
      continue;
    }
    // unsupported wireType: skip
    break;
  }
  return frame;
}

function headersToMap(headers) {
  const out = {};
  for (const h of headers ?? []) {
    if (h && typeof h.key === "string") out[h.key] = String(h.value ?? "");
  }
  return out;
}

function createGateway(params) {
  const { appId, appSecret, botOpenId, apiOrigin, internalToken, logger, domain } = params;

  function normalizeAllowedDomain(raw) {
    const v = normalizeText(raw);
    if (!v) return "https://open.feishu.cn";
    const d = v.endsWith("/") ? v.slice(0, -1) : v;
    if (d === "https://open.feishu.cn" || d === "https://open.larksuite.com") return d;
    const err = new Error(`feishu domain is not allowed: ${d}`);
    err.code = "FEISHU_DOMAIN_NOT_ALLOWED";
    throw err;
  }

  const baseDomain = normalizeAllowedDomain(domain);
  let ws = null;
  let stopped = false;
  let reconnectTimer = null;
  let pingTimer = null;

  const client = createInternalClient({ apiOrigin, internalToken });

  async function pullConnectConfig() {
    // from larksuite/node-sdk: POST {domain}/callback/ws/endpoint with {AppID,AppSecret}
    const res = await fetch(`${baseDomain}/callback/ws/endpoint`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        locale: "zh"
      },
      body: JSON.stringify({ AppID: appId, AppSecret: appSecret })
    });
    const data = await res.json();
    if (!data || data.code !== 0 || !data.data?.URL) {
      throw new Error(`failed to pull ws endpoint: ${data?.msg || res.status}`);
    }
    const url = data.data.URL;
    const qs = new URL(url);
    const deviceId = qs.searchParams.get("device_id") || "";
    const serviceId = qs.searchParams.get("service_id") || "";
    const cfg = data.data.ClientConfig || {};
    return {
      url,
      deviceId,
      serviceId,
      pingIntervalMs: Number(cfg.PingInterval || 120) * 1000,
      reconnectIntervalMs: Number(cfg.ReconnectInterval || 120) * 1000,
      reconnectNonceMs: Number(cfg.ReconnectNonce || 30) * 1000
    };
  }

  function scheduleReconnect(delayMs, nonceMs) {
    if (reconnectTimer) clearSleepTimeout(reconnectTimer);
    const jitter = Math.max(0, Math.floor(Math.random() * Math.max(0, Number(nonceMs || 0))));
    const finalDelayMs = Math.max(1000, Number(delayMs || 0) + jitter);
    reconnectTimer = sleepTimeout(() => {
      reconnectTimer = null;
      void connectLoop().catch((e) => logger.error(`[feishu] reconnect failed: ${e instanceof Error ? e.message : String(e)}`));
    }, finalDelayMs);
  }

  function startPingLoop(serviceId, intervalMs) {
    if (pingTimer) clearSleepTimeout(pingTimer);
    const tick = () => {
      if (stopped) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const frame = {
          headers: [{ key: "type", value: "ping" }],
          service: Number(serviceId || 0),
          method: 0,
          SeqID: 0,
          LogID: 0
        };
        ws.send(encodeFrame(frame));
      }
      pingTimer = sleepTimeout(tick, intervalMs);
    };
    pingTimer = sleepTimeout(tick, intervalMs);
  }

  async function handleEventPayload(payload) {
    // payload is JSON from Feishu, includes schema/header/event
    const header = toRecord(payload.header) ?? {};
    const event = toRecord(payload.event) ?? {};
    const eventType = normalizeText(header.event_type);
    if (eventType !== "im.message.receive_v1") {
      return null;
    }

    // Parse message.
    const message = toRecord(event.message) ?? {};
    const sender = toRecord(event.sender) ?? {};
    const senderIdObj = toRecord(sender.sender_id) ?? {};

    const messageId = normalizeText(message.message_id) || normalizeText(header.event_id) || `${normalizeText(message.chat_id)}_${Date.now()}`;
    const chatId = normalizeText(message.chat_id);
    const chatTypeRaw = normalizeText(message.chat_type);
    const chatType = chatTypeRaw === "group" ? "group" : "direct";
    const senderId = normalizeText(senderIdObj.open_id) || normalizeText(senderIdObj.user_id) || normalizeText(senderIdObj.union_id);
    const senderName = normalizeText((toRecord(sender.sender_id) ?? {}).open_id) ? "" : "";

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
        const rec = toRecord(m) ?? {};
        const id = toRecord(rec.id) ?? {};
        return normalizeText(id.open_id) === normalizeText(botOpenId);
      });
    }

    if (!chatId || !senderId || !text) {
      return null;
    }

    return {
      messageId,
      chatId,
      chatType,
      sender: { id: senderId, displayName: normalizeText(event.sender?.sender_type) ? undefined : undefined },
      mentionedBot,
      text,
      raw: payload
    };
  }

  async function handleMessageEvent(ctx) {
    const accountId = "default";
    const pluginId = "feishu";
    const channelName = "im";
    const conversationKey = buildConversationKey(accountId, ctx.chatId);

    if (ctx.chatType === "group" && ctx.mentionedBot) {
      const allow = await client.post("/api/internal/agent/channels/allowlist/check", {
        pluginId,
        senderId: ctx.sender.id
      });
      if (!allow?.allowed) {
        void replyText(ctx.chatId, ctx.messageId, `请联系我的主人添加白名单。open_id: ${ctx.sender.id}`);
        return;
      }
    }

    // Ingest every message for dedupe + allowlist enforcement.
    const ingest = await client.post("/api/internal/agent/channels/inbound/ingest", {
      pluginId,
      channelName,
      accountId,
      conversationKey,
      chatType: ctx.chatType,
      chatId: ctx.chatId,
      externalMessageId: ctx.messageId,
      sender: { id: ctx.sender.id },
      mentionedBot: Boolean(ctx.mentionedBot),
      text: ctx.text
    });

    if (!ingest?.ok) {
      // NOT_ALLOWED: ignore in groups, reply in direct
      if (ctx.chatType === "direct") {
        void replyText(ctx.chatId, ctx.messageId, `无权限：${ingest?.message || "NOT_ALLOWED"}`);
      }
      return;
    }

    // Idempotency: if this external message_id was already ingested, do not execute commands / trigger run twice.
    if (ingest?.deduplicated) {
      return;
    }

    let cmdText = ctx.text;
    if (ctx.chatType === "group" && ctx.mentionedBot) {
      const stripped = stripLeadingMentionsForCommand(cmdText);
      cmdText = stripped || cmdText;
    }
    const cmd = parseCommand(cmdText);
    if (cmd) {
      await handleCommand({
        chatId: ctx.chatId,
        messageId: ctx.messageId,
        senderId: ctx.sender.id,
        conversationKey,
        chatType: ctx.chatType,
        cmd
      });
      return;
    }

    // normal message
    if (ctx.chatType === "group" && !ctx.mentionedBot) {
      return;
    }

    const binding = await client.post("/api/internal/agent/channels/conversations/get-binding", {
      pluginId,
      channelName,
      accountId,
      conversationKey
    });

    const hasSession = Boolean(normalizeText(binding?.sessionId));
    const hasAgent = Boolean(normalizeText(binding?.selectedAgentId));

    if (!hasSession && !hasAgent) {
      void replyText(ctx.chatId, ctx.messageId, "请先设置 session 与 agent：先使用 /ss 绑定会话，再使用 /a 选择 agent");
      return;
    }
    if (!hasSession) {
      void replyText(ctx.chatId, ctx.messageId, "请先使用 /ss 绑定会话");
      return;
    }
    if (!hasAgent) {
      void replyText(ctx.chatId, ctx.messageId, "请先使用 /a 选择 agent");
      return;
    }

    let userText = ctx.text;
    if (ctx.chatType === "group") {
      const agg = await client.post("/api/internal/agent/channels/inbound/aggregate", {
        pluginId,
        channelName,
        accountId,
        conversationKey,
        upperBoundExternalMessageId: ctx.messageId
      });
      userText = agg.text;
    }

    const trigger = await client.post("/api/internal/agent/channels/run/trigger", {
      pluginId,
      channelName,
      accountId,
      conversationKey,
      triggerExternalMessageId: ctx.messageId,
      text: userText,
      clientRequestId: `im_${pluginId}_${conversationKey}_${ctx.messageId}`,
      watermarkAdvanceExternalMessageId: ctx.chatType === "group" ? ctx.messageId : undefined
    });

    if (!trigger.ok) {
      if (trigger.errorCode === "SESSION_RUNNING" && trigger.statusSummary) {
        void replyText(ctx.chatId, ctx.messageId, `正在运行中，请稍后再试。\n${buildStatusText(trigger.statusSummary)}`);
        return;
      }
      void replyText(ctx.chatId, ctx.messageId, `触发失败：${trigger.message || trigger.errorCode}`);
      return;
    }

    void replyText(ctx.chatId, ctx.messageId, trigger.deduplicated ? "已收到（重复消息已忽略）" : "已收到，开始处理…");
  }

  async function handleCommand(params) {
    const { chatId, messageId, senderId, conversationKey, chatType, cmd } = params;
    const accountId = "default";
    const pluginId = "feishu";
    const channelName = "im";

    if (cmd.cmd === "/h") {
      void replyText(chatId, messageId, buildHelpText());
      return;
    }

    async function isAgentAvailableInWorkspace(workspaceId, agentId) {
      const wsId = normalizeText(workspaceId);
      const targetAgentId = normalizeText(agentId);
      if (!wsId || !targetAgentId) return false;
      const list = await client.post("/api/internal/agent/agents/list", { workspaceId: wsId, surface: "user" });
      const agents = Array.isArray(list?.agents) ? list.agents : [];
      return agents.some((a) => normalizeText(a?.id) === targetAgentId);
    }

    async function listWorkspaces() {
      const res = await client.get("/api/internal/agent/workspaces/list?limit=10", { pluginId });
      return Array.isArray(res?.items) ? res.items : [];
    }

    function formatWorkspaceOption(item) {
      const id = normalizeText(item?.id);
      const label = normalizeText(item?.title) || normalizeText(item?.dirName) || id;
      return { id, label: label || id };
    }

    async function keepAgentAfterBinding({ binding, previousAgentId }) {
      let keepAgentRejected = false;
      let keptAgentId = normalizeText(binding?.selectedAgentId);
      if (previousAgentId && keptAgentId !== previousAgentId) {
        const canKeep = await isAgentAvailableInWorkspace(binding?.workspaceId, previousAgentId);
        if (canKeep) {
          await client.post("/api/internal/agent/channels/conversations/set-agent", {
            pluginId,
            channelName,
            accountId,
            conversationKey,
            selectedAgentId: previousAgentId
          });
          keptAgentId = previousAgentId;
        } else {
          keepAgentRejected = true;
        }
      }
      return { keptAgentId, keepAgentRejected };
    }

    if (cmd.cmd === "/ws") {
      try {
        const workspaces = await listWorkspaces();
        const top = workspaces.map(formatWorkspaceOption).filter((w) => w.id);
        if (top.length === 0) {
          void replyText(chatId, messageId, "暂无 workspace");
          return;
        }
        void replyText(chatId, messageId, top.map((w, idx) => `${idx + 1}. ${w.label} (${w.id})`).join("\n"));
      } catch (e) {
        logger.error(`[feishu] list workspaces failed: ${e instanceof Error ? e.message : String(e)}`);
        void replyText(chatId, messageId, "获取 workspace 列表失败，请稍后重试");
      }
      return;
    }

    if (cmd.cmd === "/ss") {
      const recent = await client.post("/api/internal/agent/sessions/recent", { limit: 10, kind: "primary" });
      const items = Array.isArray(recent.items) ? recent.items : [];
      if (!cmd.arg) {
        if (items.length === 0) {
          void replyText(chatId, messageId, "暂无会话");
          return;
        }
        const lines = items.map((it, idx) => `${idx + 1}. ${it.sessionTitle} (${it.sessionId}) @ ${formatWorkspaceLabel(it)}`);
        void replyText(chatId, messageId, lines.join("\n"));
        return;
      }

      const id = resolveIndexOrId(cmd.arg, items.map((it) => ({ id: it.sessionId })));
      if (!id) {
        void replyText(chatId, messageId, "参数错误：/ss <sessionId|index>");
        return;
      }

      const before = await client.post("/api/internal/agent/channels/conversations/get-binding", {
        pluginId,
        channelName,
        accountId,
        conversationKey
      });
      const previousAgentId = normalizeText(before?.selectedAgentId);

      const binding = await client.post("/api/internal/agent/channels/conversations/upsert-binding", {
        pluginId,
        channelName,
        accountId,
        conversationKey,
        chatId,
        chatType: chatType === "group" ? "group" : "direct",
        sessionId: id
      });
      if (!binding) {
        void replyText(chatId, messageId, "绑定失败");
        return;
      }

      const { keptAgentId, keepAgentRejected } = await keepAgentAfterBinding({ binding, previousAgentId });

      if (keptAgentId) {
        void replyText(chatId, messageId, `已绑定：${binding.sessionId}，保持当前 agent：${keptAgentId}`);
      } else if (keepAgentRejected) {
        void replyText(chatId, messageId, `已绑定：${binding.sessionId}，原 agent 不适用于当前 workspace/已不可用，请使用 /a 重新选择`);
      } else {
        void replyText(chatId, messageId, `已绑定：${binding.sessionId}，请使用 /a 选择 agent`);
      }
      return;
    }

    if (cmd.cmd === "/n") {
      const before = await client.post("/api/internal/agent/channels/conversations/get-binding", {
        pluginId,
        channelName,
        accountId,
        conversationKey
      });
      const workspaceId = normalizeText(before?.workspaceId);
      const currentSessionId = normalizeText(before?.sessionId);
      const previousAgentId = normalizeText(before?.selectedAgentId);
      if (!workspaceId || !currentSessionId) {
        void replyText(chatId, messageId, "请先使用 /ss 绑定会话");
        return;
      }

      let targetWorkspaceId = workspaceId;
      const rawArg = normalizeText(cmd.arg);
      if (rawArg) {
        const parts = rawArg.split(/\s+/g).filter(Boolean);
        if (parts.length !== 1) {
          void replyText(chatId, messageId, "用法错误：/n [workspaceId]");
          return;
        }
        targetWorkspaceId = normalizeText(parts[0]);
      }

      let created = null;
      try {
        created = await client.post("/api/internal/agent/sessions/create", {
          workspaceId: targetWorkspaceId,
          title: "new session"
        });
      } catch (e) {
        const statusCode = Number(e && typeof e === "object" ? e.statusCode : 0);
        if (statusCode === 404) {
          void replyText(chatId, messageId, "workspace 不存在，请使用 /ws 查看可用列表");
          return;
        }
        logger.error(`[feishu] create session failed: ${e instanceof Error ? e.message : String(e)}`);
        void replyText(chatId, messageId, "新建会话失败，请稍后重试");
        return;
      }
      const newSessionId = normalizeText(created?.id);
      if (!newSessionId) {
        void replyText(chatId, messageId, "新建会话失败");
        return;
      }

      const binding = await client.post("/api/internal/agent/channels/conversations/upsert-binding", {
        pluginId,
        channelName,
        accountId,
        conversationKey,
        chatId,
        chatType: chatType === "group" ? "group" : "direct",
        sessionId: newSessionId
      });
      if (!binding) {
        void replyText(chatId, messageId, "切换新会话失败");
        return;
      }

      const { keptAgentId, keepAgentRejected } = await keepAgentAfterBinding({ binding, previousAgentId });

      if (keptAgentId) {
        void replyText(chatId, messageId, `已新建并切换会话：${newSessionId}，保持当前 agent：${keptAgentId}`);
      } else if (keepAgentRejected) {
        void replyText(chatId, messageId, `已新建并切换会话：${newSessionId}，原 agent 不适用于当前 workspace/已不可用，请使用 /a 重新选择`);
      } else {
        void replyText(chatId, messageId, `已新建并切换会话：${newSessionId}，请使用 /a 选择 agent`);
      }
      return;
    }

    if (cmd.cmd === "/a") {
      const binding = await client.post("/api/internal/agent/channels/conversations/get-binding", {
        pluginId,
        channelName,
        accountId,
        conversationKey
      });
      if (!normalizeText(binding?.sessionId)) {
        void replyText(chatId, messageId, "请先使用 /ss 绑定会话");
        return;
      }

      const list = await client.post("/api/internal/agent/agents/list", { workspaceId: binding.workspaceId, surface: "user" });
      const agents = Array.isArray(list.agents) ? list.agents : [];
      if (!cmd.arg) {
        const lines = agents.map((a, idx) => {
          const current = binding.selectedAgentId === a.id ? " *" : "";
          return `${idx + 1}. ${a.name} (${a.id})${current}`;
        });
        void replyText(chatId, messageId, lines.length ? lines.join("\n") : "无可用 agent");
        return;
      }

      const target = resolveIndexOrId(cmd.arg, agents.map((a) => ({ id: a.id })));
      if (!target) {
        void replyText(chatId, messageId, "参数错误：/a <agentId|index>");
        return;
      }

      await client.post("/api/internal/agent/channels/conversations/set-agent", {
        pluginId,
        channelName,
        accountId,
        conversationKey,
        selectedAgentId: target
      });
      void replyText(chatId, messageId, `已选择 agent：${target}`);
      return;
    }

    if (cmd.cmd === "/c") {
      const binding = await client.post("/api/internal/agent/channels/conversations/get-binding", {
        pluginId,
        channelName,
        accountId,
        conversationKey
      });
      const sessionId = normalizeText(binding?.sessionId);
      const workspaceId = normalizeText(binding?.workspaceId);
      if (!sessionId || !workspaceId) {
        void replyText(chatId, messageId, "请先使用 /ss 绑定会话");
        return;
      }

      try {
        const result = await client.post(`/api/agent/sessions/${encodeURIComponent(sessionId)}/compact`, {
          workspaceId,
          clientRequestId: `im_${pluginId}_${conversationKey}_${messageId}_compact`,
          ...(normalizeText(binding.selectedAgentId) ? { agentId: normalizeText(binding.selectedAgentId) } : {})
        });
        if (result?.scheduled) {
          void replyText(chatId, messageId, "已触发 compact，正在处理…");
          return;
        }
        if (result?.skippedReason === "deduplicated") {
          void replyText(chatId, messageId, "compact 请求已存在，已忽略重复触发");
          return;
        }
        void replyText(chatId, messageId, "compact 已受理");
      } catch (e) {
        const statusCode = Number(e && typeof e === "object" ? e.statusCode : 0);
        const errorCode = normalizeText(e && typeof e === "object" ? e.code : "");
        if (statusCode === 409 || errorCode === "SESSION_RUNNING") {
          void replyText(chatId, messageId, "当前会话正在运行中，请稍后再执行 /c");
          return;
        }
        logger.error(`[feishu] compact failed: ${e instanceof Error ? e.message : String(e)}`);
        void replyText(chatId, messageId, "compact 失败，请稍后重试");
      }
      return;
    }

    if (cmd.cmd === "/st") {
      const binding = await client.post("/api/internal/agent/channels/conversations/get-binding", {
        pluginId,
        channelName,
        accountId,
        conversationKey
      });
      if (!normalizeText(binding?.sessionId)) {
        void replyText(chatId, messageId, "请先使用 /ss 绑定会话");
        return;
      }
      const summary = await client.post("/api/internal/agent/sessions/status-summary", {
        sessionId: binding.sessionId,
        selectedAgentId: binding.selectedAgentId
      });
      void replyText(chatId, messageId, buildStatusText(summary));
      return;
    }

    void replyText(chatId, messageId, buildHelpText());
  }

  async function replyText(chatId, messageId, text) {
    // MVP: no reply dispatcher yet; respond immediately to acknowledge.
    // We use tenant_access_token to call reply message API.
    try {
      const tokenRes = await fetch(`${baseDomain}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret })
      }).then((r) => r.json());
      const token = tokenRes?.tenant_access_token;
      if (!token) {
        logger.warn(`[feishu] missing tenant_access_token: ${tokenRes?.msg || ""}`);
        return;
      }
      await fetch(`${baseDomain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ msg_type: "text", content: JSON.stringify({ text }) })
      });
    } catch (e) {
      logger.error(`[feishu] reply failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
      startPingLoop(cfg.serviceId, cfg.pingIntervalMs || 120000);
    });

    ws.addEventListener("close", () => {
      if (stopped) return;
      logger.warn("[feishu] ws closed; scheduling reconnect");
      scheduleReconnect(cfg.reconnectIntervalMs || 120000, cfg.reconnectNonceMs || 0);
    });

    ws.addEventListener("error", () => {
      if (stopped) return;
      logger.warn("[feishu] ws error; scheduling reconnect");
      scheduleReconnect(cfg.reconnectIntervalMs || 120000, cfg.reconnectNonceMs || 0);
    });

    function withBizRt(headers, bizRtMs) {
      const next = [];
      for (const h of headers || []) {
        if (h && h.key === "biz_rt") continue;
        next.push(h);
      }
      next.push({ key: "biz_rt", value: String(bizRtMs) });
      return next;
    }

    ws.addEventListener("message", async (ev) => {
      const startAt = Date.now();
      let frame = null;
      try {
        const buf = new Uint8Array(ev.data);
        frame = decodeFrame(buf);
        if (frame.method === 0) {
          // control: ignore
          return;
        }
        const headers = headersToMap(frame.headers);
        if (headers.type !== "event") return;
        if (!frame.payload) return;
        const payloadText = new TextDecoder().decode(frame.payload);
        const payload = safeJsonParse(payloadText);
        if (!payload) return;
        const msg = await handleEventPayload(payload);
        const resp = { code: 200 };
        if (msg) await handleMessageEvent(msg);
        // ACK (always)
        const ackFrame = {
          ...frame,
          headers: withBizRt(frame.headers || [], Date.now() - startAt),
          payload: new TextEncoder().encode(JSON.stringify(resp))
        };
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(encodeFrame(ackFrame));
        }
      } catch (e) {
        logger.error(`[feishu] ws message handling failed: ${e instanceof Error ? e.message : String(e)}`);
        // Best-effort ACK to avoid repeated retries on deterministic errors.
        try {
          if (ws && ws.readyState === WebSocket.OPEN && frame) {
            const ackFrame = {
              ...frame,
              headers: withBizRt(frame.headers || [], Date.now() - startAt),
              payload: new TextEncoder().encode(JSON.stringify({ code: 500 }))
            };
            ws.send(encodeFrame(ackFrame));
          }
        } catch {
          // ignore
        }
      }
    });
  }

  return {
    async start() {
      stopped = false;
      await connectLoop();
    },
    async stop() {
      stopped = true;
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
    },
    async replyText(chatId, messageId, text) {
      await replyText(chatId, messageId, text);
    }
  };
}

export default {
  meta: {
    id: "feishu",
    name: "Feishu IM",
    version: "0.1.0",
    description: "飞书 IM 渠道插件（services.gateway + channels.im）MVP"
  },
  capabilities: {
    // tools omitted
  },
  services: {
    gateway: {
      async start(params) {
        const cfg = params.config;
        const gw = createGateway({
          appId: cfg.appId,
          appSecret: cfg.appSecret,
          botOpenId: cfg.botOpenId,
          domain: cfg.domain,
          apiOrigin: params.apiOrigin,
          internalToken: params.internalToken,
          logger: params.logger
        });
        await gw.start();
        return {
          replyText: async ({ chatId, messageId, text }) => {
            await gw.replyText(chatId, messageId, text);
          },
          stop: async () => {
            await gw.stop();
          }
        };
      }
    }
  },
  channels: {
    im: {
      // channel runtime is driven by gateway directly in MVP
    }
  }
};
