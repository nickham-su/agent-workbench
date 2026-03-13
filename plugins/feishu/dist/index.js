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
    "- /l (/last)               查看最后一条 assistant 消息（运行中不可用）",
    "- /h (/help)               帮助"
  ].join("\n");
}

const COMMAND_ALIAS_MAP = {
  "/a": "/a",
  "/last": "/l",
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
  const sessionTitle = normalizeText(summary.session.title) || "(untitled)";
  const sessionId = normalizeText(summary.session.id) || "";
  const workspaceId = normalizeText(summary.session.workspaceId) || "";
  const workspaceLabel =
    normalizeText(summary.session.workspaceTitle) ||
    normalizeText(summary.session.workspaceDirName) ||
    workspaceId;

  const lines = [];
  lines.push(`session: ${sessionTitle}`);
  lines.push(`session_id: ${sessionId}`);
  lines.push(`workspace: ${workspaceLabel}`);
  lines.push(`workspace_id: ${workspaceId}`);
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
  const roleCache = new Map();
  const ROLE_CACHE_TTL_MS = 60 * 1000;

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

  function normalizeSenderRole(raw) {
    const role = normalizeText(raw).toLowerCase();
    if (role === "admin") return "admin";
    if (role === "user") return "user";
    return "none";
  }

  async function getSenderRole(pluginId, accountId, senderId) {
    const pid = normalizeText(pluginId);
    const aid = normalizeText(accountId);
    const sid = normalizeText(senderId);
    if (!sid) return { role: "none", allowed: false, reason: "sender.id is required" };
    const now = Date.now();
    const cached = roleCache.get(`${pid}\0${aid}\0${sid}`);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const allow = await client.post("/api/internal/agent/channels/allowlist/check", {
      pluginId,
      senderId: sid
    });
    const normalizedRole = allow?.allowed ? normalizeSenderRole(allow?.role) : "none";
    const value = {
      role: normalizedRole,
      allowed: normalizedRole === "admin" || normalizedRole === "user",
      reason: normalizeText(allow?.reason)
    };
    roleCache.set(`${pid}\0${aid}\0${sid}`, { value, expiresAt: now + ROLE_CACHE_TTL_MS });
    return value;
  }

  async function ingestNonCommandMessage(params) {
    const { accountId, pluginId, channelName, conversationKey, ctx } = params;
    return client.post("/api/internal/agent/channels/inbound/ingest", {
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
  }

  async function handleDirectNormalMessage(params) {
    const { ctx, accountId, pluginId, channelName, conversationKey } = params;
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
    const trigger = await client.post("/api/internal/agent/channels/run/trigger", {
      pluginId,
      channelName,
      accountId,
      conversationKey,
      triggerExternalMessageId: ctx.messageId,
      text: ctx.text,
      clientRequestId: `im_${pluginId}_${conversationKey}_${ctx.messageId}`
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

  async function handleGroupNormalMessage(params) {
    const { ctx, accountId, pluginId, channelName, conversationKey, senderRole } = params;
    const binding = await client.post("/api/internal/agent/channels/conversations/get-binding", {
      pluginId,
      channelName,
      accountId,
      conversationKey
    });
    const senderAllowed = senderRole === "admin" || senderRole === "user";
    if (!ctx.mentionedBot) return;
    if (!senderAllowed) return;
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

    const agg = await client.post("/api/internal/agent/channels/inbound/aggregate", {
      pluginId,
      channelName,
      accountId,
      conversationKey,
      upperBoundExternalMessageId: ctx.messageId
    });
    const userText = agg.text;
    const trigger = await client.post("/api/internal/agent/channels/run/trigger", {
      pluginId,
      channelName,
      accountId,
      conversationKey,
      triggerExternalMessageId: ctx.messageId,
      text: userText,
      clientRequestId: `im_${pluginId}_${conversationKey}_${ctx.messageId}`,
      watermarkAdvanceExternalMessageId: ctx.messageId
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

  async function handleMessageEvent(ctx) {
    const accountId = "default";
    const pluginId = "feishu";
    const channelName = "im";
    const conversationKey = buildConversationKey(accountId, ctx.chatId);
    const senderAccess = await getSenderRole(pluginId, accountId, ctx.sender.id);

    let cmdText = ctx.text;
    if (ctx.chatType === "group" && ctx.mentionedBot) {
      const stripped = stripLeadingMentionsForCommand(cmdText);
      cmdText = stripped || cmdText;
    }
    const cmd = parseCommand(cmdText);
    if (cmd) {
      if (senderAccess.role !== "admin") {
        if (senderAccess.role === "none") {
          void replyText(ctx.chatId, ctx.messageId, `请联系我的主人添加白名单。open_id: ${ctx.sender.id}`);
        } else {
          void replyText(ctx.chatId, ctx.messageId, "无权限：仅管理员可执行命令，请联系管理员。");
        }
        return;
      }
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

    if (ctx.chatType === "group" && ctx.mentionedBot && senderAccess.role === "none") {
      void replyText(ctx.chatId, ctx.messageId, `请联系我的主人添加白名单。open_id: ${ctx.sender.id}`);
      return;
    }

    const ingest = await ingestNonCommandMessage({ accountId, pluginId, channelName, conversationKey, ctx });
    if (!ingest?.ok) {
      if (ctx.chatType === "direct") {
        void replyText(ctx.chatId, ctx.messageId, `请联系我的主人添加白名单。open_id: ${ctx.sender.id}`);
      }
      return;
    }

    if (ingest?.deduplicated) {
      return;
    }

    if (ctx.chatType === "group") {
      await handleGroupNormalMessage({
        ctx,
        accountId,
        pluginId,
        channelName,
        conversationKey,
        senderRole: senderAccess.role
      });
      return;
    }

    if (senderAccess.role === "none") {
      if (ctx.chatType === "direct") {
        void replyText(ctx.chatId, ctx.messageId, `请联系我的主人添加白名单。open_id: ${ctx.sender.id}`);
      }
      return;
    }

    await handleDirectNormalMessage({ ctx, accountId, pluginId, channelName, conversationKey });
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

    function formatSessionDisplay(sessionId, sessionTitle) {
      const id = normalizeText(sessionId);
      const title = normalizeText(sessionTitle) || "(untitled)";
      return id ? `${title} (${id})` : title;
    }

    function formatAgentDisplay(agentId, agentName) {
      const id = normalizeText(agentId);
      const name = normalizeText(agentName) || "(unknown agent)";
      return id ? `${name} (${id})` : name;
    }

    function resolveAgentNameFromSummary(summary, agentId) {
      const targetId = normalizeText(agentId);
      if (!targetId) return "";
      const summaryAgentId = normalizeText(summary?.agent?.id);
      if (!summaryAgentId || summaryAgentId !== targetId) return "";
      return normalizeText(summary?.agent?.name);
    }

    async function loadStatusSummary(sessionId, workspaceId) {
      const sid = normalizeText(sessionId);
      const wid = normalizeText(workspaceId);
      if (!sid || !wid) return null;
      try {
        return await client.post("/api/internal/agent/sessions/status-summary", {
          sessionId: sid,
          workspaceId: wid,
          accountId,
          pluginId
        });
      } catch (e) {
        logger.warn(`[feishu] load status summary failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }

    async function fetchContextItemsTail(sessionId, tailLimit) {
      const sid = normalizeText(sessionId);
      if (!sid) return [];
      const res = await client.post("/api/internal/agent/sessions/context-items-tail", {
        pluginId,
        sessionId: sid,
        tailLimit: Number.isFinite(tailLimit) ? Number(tailLimit) : void 0
      });
      return Array.isArray(res?.items) ? res.items : [];
    }

    function extractOutputText(item) {
      const output = item && typeof item === "object" ? item.output : null;
      if (!output || typeof output !== "object") return "";
      const text = normalizeText(output.text);
      if (text) return text;
      return "";
    }

    function findLatestTodolistItem(items) {
      if (!Array.isArray(items)) return null;
      for (let idx = items.length - 1; idx >= 0; idx -= 1) {
        const item = items[idx];
        const output = item && typeof item === "object" ? item.output : null;
        if (!output || typeof output !== "object") continue;
        if (normalizeText(output.type) !== "tool") continue;
        if (normalizeText(output.toolName) !== "todolist") continue;
        return item;
      }
      return null;
    }

    function formatTodolistAppend(item, limit = 20) {
      if (!item || typeof item !== "object") return "";
      const output = item.output && typeof item.output === "object" ? item.output : null;
      if (!output) return "";
      const result = output.result && typeof output.result === "object" ? output.result : null;
      const goal = normalizeText(result?.goal);
      const todos = Array.isArray(result?.todos) ? result.todos : [];
      const lines = [];
      lines.push("\n---\n最近 todolist:");
      if (goal) {
        lines.push(`goal: ${goal}`);
      }
      if (todos.length === 0) {
        const fallback = normalizeText(output.text);
        if (fallback) {
          lines.push(fallback.length > 1200 ? `${fallback.slice(0, 1200)}...` : fallback);
        } else {
          lines.push("(无任务)");
        }
        return lines.join("\n");
      }
      const shown = todos.slice(0, Math.max(1, limit));
      for (const todo of shown) {
        const content = normalizeText(todo?.content) || "(empty)";
        const status = normalizeText(todo?.status) || "pending";
        lines.push(`- [${status}] ${content}`);
      }
      if (todos.length > shown.length) {
        lines.push(`... +${todos.length - shown.length} more`);
      }
      return lines.join("\n");
    }

    function formatLastAssistantMessage(item) {
      const kind = normalizeText(item?.kind);
      const output = item && typeof item === "object" ? item.output : null;
      const outputType = normalizeText(output?.type);
      const text = normalizeText(output?.text);
      if (kind === "assistant" && outputType === "assistant_text" && text) {
        const maxChars = 3000;
        return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
      }
      return `最后一条消息不是 assistant 消息（kind=${kind || "unknown"}, type=${outputType || "unknown"}）`;
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
        const lines = items.map((it, idx) => {
          const sessionTitle = normalizeText(it?.sessionTitle) || "(untitled)";
          const sessionId = normalizeText(it?.sessionId);
          return `${idx + 1}. ${sessionTitle} (${sessionId}) @ ${formatWorkspaceLabel(it)}`;
        });
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

      const currentSessionId = normalizeText(binding.sessionId) || id;
      const summary = await loadStatusSummary(currentSessionId, binding?.workspaceId);
      const sessionDisplay = formatSessionDisplay(currentSessionId, summary?.session?.title);

      if (keptAgentId) {
        const keptAgentDisplay = formatAgentDisplay(keptAgentId, resolveAgentNameFromSummary(summary, keptAgentId));
        void replyText(chatId, messageId, `已绑定会话：${sessionDisplay}，保持当前 agent：${keptAgentDisplay}`);
      } else if (keepAgentRejected) {
        const previousAgentDisplay = formatAgentDisplay(previousAgentId, resolveAgentNameFromSummary(summary, previousAgentId));
        void replyText(
          chatId,
          messageId,
          `已绑定会话：${sessionDisplay}，原 agent 不适用于当前 workspace/已不可用：${previousAgentDisplay}，请使用 /a 重新选择 agent`
        );
      } else {
        void replyText(
          chatId,
          messageId,
          `已绑定会话：${sessionDisplay}，当前 agent：${formatAgentDisplay("", "(unknown agent)")}，请使用 /a 选择 agent`
        );
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
      const previousAgentId = normalizeText(before?.selectedAgentId);

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

      if (!targetWorkspaceId) {
        void replyText(chatId, messageId, "请先指定 workspace：/n <workspaceId>（可先用 /ws 查看列表）");
        return;
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

      const currentSessionId = normalizeText(binding.sessionId) || newSessionId;
      const summary = await loadStatusSummary(currentSessionId, binding?.workspaceId);
      const sessionDisplay = formatSessionDisplay(currentSessionId, summary?.session?.title || created?.title);

      if (keptAgentId) {
        const keptAgentDisplay = formatAgentDisplay(keptAgentId, resolveAgentNameFromSummary(summary, keptAgentId));
        void replyText(chatId, messageId, `已新建并切换会话：${sessionDisplay}，保持当前 agent：${keptAgentDisplay}`);
      } else if (keepAgentRejected) {
        const previousAgentDisplay = formatAgentDisplay(previousAgentId, resolveAgentNameFromSummary(summary, previousAgentId));
        void replyText(
          chatId,
          messageId,
          `已新建并切换会话：${sessionDisplay}，原 agent 不适用于当前 workspace/已不可用：${previousAgentDisplay}，请使用 /a 重新选择 agent`
        );
      } else {
        void replyText(
          chatId,
          messageId,
          `已新建并切换会话：${sessionDisplay}，当前 agent：${formatAgentDisplay("", "(unknown agent)")}，请使用 /a 选择 agent`
        );
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
          const agentName = normalizeText(a?.name) || "(unknown agent)";
          return `${idx + 1}. ${agentName} (${a.id})${current}`;
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
      const targetAgentName = normalizeText(agents.find((a) => normalizeText(a?.id) === target)?.name);
      void replyText(chatId, messageId, `已选择 agent：${formatAgentDisplay(target, targetAgentName)}`);
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

    if (cmd.cmd === "/l") {
      try {
        const binding = await client.post("/api/internal/agent/channels/conversations/get-binding", {
          pluginId,
          channelName,
          accountId,
          conversationKey
        });
        const sessionId = normalizeText(binding?.sessionId);
        if (!sessionId) {
          void replyText(chatId, messageId, "请先使用 /ss 绑定会话");
          return;
        }

        const summary = await client.post("/api/internal/agent/sessions/status-summary", {
          sessionId,
          selectedAgentId: binding.selectedAgentId
        });
        if (normalizeText(summary?.runState?.status).toLowerCase() === "running") {
          void replyText(chatId, messageId, "正在运行中，请稍后再试");
          return;
        }

        const items = await fetchContextItemsTail(sessionId, 1);
        if (items.length === 0) {
          void replyText(chatId, messageId, "当前会话暂无消息");
          return;
        }
        void replyText(chatId, messageId, formatLastAssistantMessage(items[items.length - 1]));
      } catch (e) {
        logger.error(`[feishu] /l failed: ${e instanceof Error ? e.message : String(e)}`);
        void replyText(chatId, messageId, "查询状态失败，请稍后重试");
      }
      return;
    }

    if (cmd.cmd === "/st") {
      try {
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
        let text = buildStatusText(summary);
        if (normalizeText(summary?.runState?.status).toLowerCase() === "running") {
          let items = await fetchContextItemsTail(binding.sessionId, 50);
          let latestTodo = findLatestTodolistItem(items);
          if (!latestTodo) {
            items = await fetchContextItemsTail(binding.sessionId, 200);
            latestTodo = findLatestTodolistItem(items);
          }
          const appendix = formatTodolistAppend(latestTodo, 20);
          if (appendix) {
            text += appendix;
          }
        }
        const maxReplyChars = 5000;
        if (text.length > maxReplyChars) {
          text = `${text.slice(0, maxReplyChars)}...`;
        }
        void replyText(chatId, messageId, text);
      } catch (e) {
        logger.error(`[feishu] /st failed: ${e instanceof Error ? e.message : String(e)}`);
        void replyText(chatId, messageId, "查询状态失败，请稍后重试");
      }
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
