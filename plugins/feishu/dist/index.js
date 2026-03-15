import { clearTimeout as clearSleepTimeout, setTimeout as sleepTimeout } from "node:timers";
import { createInternalClient } from "./internal-client.js";
import { policyLabel } from "./policy.js";
import { shouldBroadcastToChat } from "./run-events.js";
import { createFeishuStore } from "./store.js";
function toRecord(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return null;
    return raw;
}
function safeJsonParse(raw) {
    if (typeof raw !== "string")
        return null;
    const txt = raw.trim();
    if (!txt)
        return null;
    try {
        return JSON.parse(txt);
    }
    catch {
        return null;
    }
}
function normalizeText(raw) {
    return typeof raw === "string" ? raw.trim() : "";
}
function buildChatKey(chatId) {
    return `feishu_default_chat_${chatId}`;
}
function resolveIndexOrId(arg, items) {
    const a = normalizeText(arg);
    if (!a)
        return "";
    if (/^\d+$/.test(a)) {
        const idx = Number(a);
        if (!Number.isFinite(idx) || idx <= 0)
            return "";
        return items[idx - 1]?.id ?? "";
    }
    return a;
}
function parseCommand(text) {
    const t = normalizeText(text);
    if (!t.startsWith("/"))
        return null;
    const parts = t.split(/\s+/g).filter(Boolean);
    const cmdRaw = normalizeText(parts[0]).toLowerCase();
    const alias = {
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
function stripLeadingMentionsForCommand(text) {
    let t = typeof text === "string" ? text : "";
    while (t) {
        const before = t;
        t = t.replace(/^\s*<at\b[^>]*>[\s\S]*?<\/at>/i, "");
        t = t.replace(/^\s*[＠@][^\s:：,，]+/, "");
        t = t.replace(/^[\s:：,，]+/, "");
        if (t === before)
            break;
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
        "- /c               触发 compact",
        "- /h               帮助"
    ].join("\n");
}
function translateCurrentStatus(status) {
    const s = normalizeText(status).toLowerCase();
    if (s === "running")
        return "运行中";
    return "空闲";
}
function translateTerminalStatus(status) {
    const s = normalizeText(status).toLowerCase();
    if (s === "failed")
        return "失败";
    if (s === "completed")
        return "已完成";
    if (s === "cancelled" || s === "canceled")
        return "已取消";
    return "无";
}
function formatDurationMs(ms) {
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
function buildStatusText(summary, policy) {
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
        `接收消息策略：${policyLabel(policy)}`
    ];
    if (currentStatus === "运行中") {
        if (elapsedMs !== null) {
            lines.push(`本次运行时长：${formatDurationMs(elapsedMs)}`);
        }
    }
    else if (lastRun && typeof lastRun === "object") {
        if (lastRunDurationMs !== null) {
            lines.push(`上次运行时长：${formatDurationMs(lastRunDurationMs)}`);
        }
    }
    return lines.join("\n");
}
// ---------------- gateway (Lark WS protocol, simplified) ----------------
function encodeVarint(n) {
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
    return encodeBytesField(fieldNo, new TextEncoder().encode(str));
}
function encodeInt32Field(fieldNo, v) {
    return concatBytes([encodeKey(fieldNo, 0), encodeVarint(v >>> 0)]);
}
function encodeUint64Field(fieldNo, v) {
    return concatBytes([encodeKey(fieldNo, 0), encodeVarint(v)]);
}
function encodeHeaderMessage(key, value) {
    return concatBytes([encodeStringField(1, key), encodeStringField(2, value)]);
}
function encodeRepeatedHeader(fieldNo, key, value) {
    const msg = encodeHeaderMessage(key, value);
    return concatBytes([encodeKey(fieldNo, 2), encodeVarint(msg.length), msg]);
}
function encodeFrame(frame) {
    const chunks = [];
    chunks.push(encodeUint64Field(1, frame.SeqID ?? 0));
    chunks.push(encodeUint64Field(2, frame.LogID ?? 0));
    chunks.push(encodeInt32Field(3, frame.service ?? 0));
    chunks.push(encodeInt32Field(4, frame.method ?? 0));
    for (const h of frame.headers ?? []) {
        chunks.push(encodeRepeatedHeader(5, h.key, h.value));
    }
    if (frame.payloadEncoding)
        chunks.push(encodeStringField(6, frame.payloadEncoding));
    if (frame.payloadType)
        chunks.push(encodeStringField(7, frame.payloadType));
    if (frame.payload)
        chunks.push(encodeBytesField(8, frame.payload));
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
        if ((b & 0x80n) === 0n)
            break;
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
            const sk = decodeVarint(buf, p);
            p = sk.next;
            continue;
        }
        if (k.fieldNo === 1) {
            const d = decodeString(buf, p);
            key = d.str;
            p = d.next;
        }
        else if (k.fieldNo === 2) {
            const d = decodeString(buf, p);
            value = d.str;
            p = d.next;
        }
        else {
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
            if (k.fieldNo === 1)
                frame.SeqID = num;
            else if (k.fieldNo === 2)
                frame.LogID = num;
            else if (k.fieldNo === 3)
                frame.service = num;
            else if (k.fieldNo === 4)
                frame.method = num;
            continue;
        }
        if (k.wireType === 2) {
            const d = decodeBytes(buf, p);
            p = d.next;
            if (k.fieldNo === 5)
                frame.headers.push(decodeHeaderMessage(d.bytes));
            else if (k.fieldNo === 8)
                frame.payload = d.bytes;
            continue;
        }
        break;
    }
    return frame;
}
function headersToMap(headers) {
    const out = {};
    for (const h of headers ?? []) {
        if (h && typeof h.key === "string")
            out[h.key] = String(h.value ?? "");
    }
    return out;
}
function createGateway(params) {
    const { appId, appSecret, botOpenId, apiOrigin, internalToken, logger, domain, dataDir } = {
        ...params.config,
        apiOrigin: params.apiOrigin,
        internalToken: params.internalToken,
        logger: params.logger,
        dataDir: params.dataDir
    };
    const INCOMING_TEXT_SUFFIX = "\n---\n本消息来自飞书，不支持markdown";
    function formatIncomingText(text) {
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
    let ws = null;
    let stopped = false;
    let reconnectTimer = null;
    let pingTimer = null;
    let sseAbort = null;
    let tokenCache = null;
    let sseLoopTask = null;
    let storeClosed = false;
    async function requestFeishuJson(action, input, init) {
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
            throw new Error(`[feishu] ${action} failed: code=${String(record.code)} msg=${normalizeText(record.msg) || "unknown"}`);
        }
        return record;
    }
    async function getTenantAccessToken() {
        const now = Date.now();
        if (tokenCache && tokenCache.expiresAt > now + 10_000)
            return tokenCache.token;
        const res = await requestFeishuJson("get tenant access token", `${baseDomain}/open-apis/auth/v3/tenant_access_token/internal`, {
            method: "POST",
            headers: { "content-type": "application/json; charset=utf-8" },
            body: JSON.stringify({ app_id: appId, app_secret: appSecret })
        });
        const token = normalizeText(res.tenant_access_token);
        if (!token)
            throw new Error(`[feishu] get tenant access token failed: missing tenant_access_token`);
        const expiresIn = Number(res.expire ?? 7200);
        tokenCache = { token, expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000 };
        return token;
    }
    async function replyText(chatId, messageId, text) {
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
    async function sendText(chatId, text) {
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
    async function checkSenderRole(senderId) {
        try {
            const allow = await client.post("/api/internal/agent/channels/allowlist/check", { pluginId: "feishu", senderId });
            const role = normalizeText(allow?.role).toLowerCase();
            return {
                role: role === "admin" ? "admin" : role === "user" ? "user" : "none",
                allowed: Boolean(allow?.allowed)
            };
        }
        catch {
            return { role: "none", allowed: false };
        }
    }
    async function fetchContextItemsTail(sessionId, tailLimit) {
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
        return items.filter((it) => {
            const kind = normalizeText(it?.kind).toLowerCase();
            return kind !== "subtask";
        });
    }
    async function listAgents(workspaceId) {
        const res = await client.post("/api/internal/agent/agents/list", { workspaceId, surface: "user" });
        return Array.isArray(res?.agents) ? res.agents : [];
    }
    async function queryFinalText(runId) {
        const res = await client.get(`/api/internal/agent/runs/${encodeURIComponent(runId)}/final-text`);
        return { found: Boolean(res?.found), text: normalizeText(res?.text) };
    }
    async function handleRunCompleted(event) {
        if (event.finalStatus !== "completed")
            return;
        const runMap = store.getRunMap(event.runId);
        if (runMap) {
            const binding = store.getBinding(runMap.chatKey);
            if (!binding)
                return;
            if (store.hasSent(event.eventId, runMap.chatKey))
                return;
            const finalText = await queryFinalText(event.runId);
            if (!finalText.found)
                return;
            await replyText(binding.chatId, runMap.messageId, finalText.text || "(empty)");
            store.saveSent(event.eventId, runMap.chatKey, event.runId);
            store.deleteRunMap(event.runId);
            return;
        }
        const bindings = store.listBindingsBySession(event.sessionId);
        if (bindings.length === 0)
            return;
        const finalText = await queryFinalText(event.runId);
        if (!finalText.found)
            return;
        for (const binding of bindings) {
            const policy = store.getPolicy(binding.chatKey);
            if (!shouldBroadcastToChat({ policy, hasRunMap: false }))
                continue;
            if (store.hasSent(event.eventId, binding.chatKey))
                continue;
            await sendText(binding.chatId, finalText.text || "(empty)");
            store.saveSent(event.eventId, binding.chatKey, event.runId);
        }
    }
    function parseSseEventBlock(block) {
        const lines = block.split(/\r?\n/g);
        let event = "";
        const dataLines = [];
        for (const line of lines) {
            if (!line || line.startsWith(":"))
                continue;
            if (line.startsWith("event:"))
                event = line.slice(6).trim();
            else if (line.startsWith("data:"))
                dataLines.push(line.slice(5).trimStart());
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
                if (!res.ok || !res.body)
                    throw new Error(`sse connect failed: ${res.status}`);
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while (!stopped) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buffer += decoder.decode(value, { stream: true });
                    let idx = buffer.indexOf("\n\n");
                    while (idx >= 0) {
                        const block = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 2);
                        const parsed = parseSseEventBlock(block);
                        if (parsed.event === "agent.run.completed.v1" && parsed.data) {
                            const event = safeJsonParse(parsed.data);
                            if (event && event.eventType === "agent.run.completed.v1") {
                                try {
                                    await handleRunCompleted(event);
                                }
                                catch (err) {
                                    logger.warn(`[feishu] handle run.completed failed: ${err instanceof Error ? err.message : String(err)}`);
                                }
                            }
                        }
                        idx = buffer.indexOf("\n\n");
                    }
                }
            }
            catch (e) {
                if (!stopped) {
                    logger.warn(`[feishu] sse loop error: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (!stopped) {
                await new Promise((r) => sleepTimeout(r, 3000));
            }
        }
    }
    async function handleCommand(ctx, binding, cmd) {
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
                .map((w, i) => `${i + 1}. ${normalizeText(w.title) || normalizeText(w.dirName) || normalizeText(w.id)} (${normalizeText(w.id)})`)
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
                    .map((it, i) => `${i + 1}. ${normalizeText(it.sessionTitle) || "(untitled)"} (${it.sessionId}) @ ${normalizeText(it.workspaceTitle) || normalizeText(it.workspaceId)}`);
                await replyText(ctx.chatId, ctx.messageId, lines.join("\n"));
                return;
            }
            const items = await listRecentSessions();
            const target = resolveIndexOrId(cmd.arg, items.map((s) => ({ id: String(s.sessionId) })));
            const selected = items.find((s) => String(s.sessionId) === target);
            if (!selected) {
                await replyText(ctx.chatId, ctx.messageId, "参数错误：/ss <sessionId|index>");
                return;
            }
            const current = binding ?? store.upsertBinding({ chatKey: buildChatKey(ctx.chatId), chatId: ctx.chatId, chatType: ctx.chatType });
            let nextAgentId = normalizeText(current?.agentId);
            if (nextAgentId) {
                const agents = await listAgents(String(selected.workspaceId));
                const canKeep = agents.some((a) => normalizeText(a.id) === nextAgentId);
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
            await replyText(ctx.chatId, ctx.messageId, nextAgentId
                ? `已绑定会话：${normalizeText(selected.sessionTitle) || "(untitled)"} (${selected.sessionId})，保持 agent: ${nextAgentId}`
                : `已绑定会话：${normalizeText(selected.sessionTitle) || "(untitled)"} (${selected.sessionId})，请使用 /a 选择 agent`);
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
                if (!agents.some((a) => normalizeText(a.id) === nextAgentId)) {
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
            await replyText(ctx.chatId, ctx.messageId, nextAgentId
                ? `已新建并切换会话：${normalizeText(created?.title) || "(untitled)"} (${normalizeText(created?.id)})，保持 agent: ${nextAgentId}`
                : `已新建并切换会话：${normalizeText(created?.title) || "(untitled)"} (${normalizeText(created?.id)})，请使用 /a 选择 agent`);
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
                const lines = agents.map((a, i) => `${i + 1}. ${normalizeText(a.name) || "(unknown)"} (${normalizeText(a.id)})`);
                await replyText(ctx.chatId, ctx.messageId, lines.length > 0 ? lines.join("\n") : "无可用 agent");
                return;
            }
            const target = resolveIndexOrId(cmd.arg, agents.map((a) => ({ id: String(a.id) })));
            if (!target || !agents.some((a) => normalizeText(a.id) === target)) {
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
            const result = await client.post(`/api/agent/sessions/${encodeURIComponent(sessionId)}/compact`, {
                workspaceId,
                clientRequestId: `im_feishu_${buildChatKey(ctx.chatId)}_${ctx.messageId}_compact`,
                ...(normalizeText(binding?.agentId) ? { agentId: normalizeText(binding?.agentId) } : {})
            });
            if (result?.scheduled) {
                await replyText(ctx.chatId, ctx.messageId, "已触发 compact，正在处理…");
            }
            else {
                await replyText(ctx.chatId, ctx.messageId, "compact 已受理");
            }
            return;
        }
        if (cmd.cmd === "/l") {
            const sessionId = normalizeText(binding?.sessionId);
            if (!sessionId) {
                await replyText(ctx.chatId, ctx.messageId, "请先使用 /ss 绑定会话");
                return;
            }
            const summary = await client.post("/api/internal/agent/sessions/status-summary", {
                sessionId,
                selectedAgentId: normalizeText(binding?.agentId) || undefined
            });
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
        if (cmd.cmd === "/st") {
            const sessionId = normalizeText(binding?.sessionId);
            if (!sessionId) {
                await replyText(ctx.chatId, ctx.messageId, `状态：未绑定会话\n请先使用 /ss 绑定会话\n当前策略：${policyLabel(store.getPolicy(buildChatKey(ctx.chatId)))}`);
                return;
            }
            const summary = await client.post("/api/internal/agent/sessions/status-summary", {
                sessionId,
                selectedAgentId: normalizeText(binding?.agentId) || undefined
            });
            const policy = store.getPolicy(buildChatKey(ctx.chatId));
            await replyText(ctx.chatId, ctx.messageId, buildStatusText(summary, policy));
            return;
        }
        await replyText(ctx.chatId, ctx.messageId, buildHelpText());
    }
    async function triggerRunFromMessage(ctx, binding) {
        const workspaceId = normalizeText(binding.workspaceId);
        const sessionId = normalizeText(binding.sessionId);
        const agentId = normalizeText(binding.agentId);
        if (!workspaceId || !sessionId || !agentId) {
            await replyText(ctx.chatId, ctx.messageId, "请先设置 session 与 agent：先使用 /ss 绑定会话，再使用 /a 选择 agent");
            return;
        }
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
    }
    async function handleMessageEvent(ctx) {
        const chatKey = buildChatKey(ctx.chatId);
        const existing = store.getBinding(chatKey) ?? store.upsertBinding({ chatKey, chatId: ctx.chatId, chatType: ctx.chatType });
        const sender = await checkSenderRole(ctx.sender.id);
        let commandText = ctx.text;
        if (ctx.chatType === "group" && ctx.mentionedBot) {
            const stripped = stripLeadingMentionsForCommand(commandText);
            if (stripped)
                commandText = stripped;
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
        if (!sender.allowed)
            return;
        if (ctx.chatType === "group") {
            if (!ctx.mentionedBot)
                return;
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
    function scheduleReconnect(delayMs, nonceMs) {
        if (reconnectTimer)
            clearSleepTimeout(reconnectTimer);
        const jitter = Math.max(0, Math.floor(Math.random() * Math.max(0, nonceMs || 0)));
        const finalDelayMs = Math.max(1000, (delayMs || 0) + jitter);
        reconnectTimer = sleepTimeout(() => {
            reconnectTimer = null;
            void connectLoop().catch((e) => logger.error(`[feishu] reconnect failed: ${e instanceof Error ? e.message : String(e)}`));
        }, finalDelayMs);
    }
    function startPingLoop(serviceId, intervalMs) {
        if (pingTimer)
            clearSleepTimeout(pingTimer);
        const tick = () => {
            if (stopped)
                return;
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(encodeFrame({
                    headers: [{ key: "type", value: "ping" }],
                    service: Number(serviceId || 0),
                    method: 0,
                    SeqID: 0,
                    LogID: 0
                }));
            }
            pingTimer = sleepTimeout(tick, intervalMs);
        };
        pingTimer = sleepTimeout(tick, intervalMs);
    }
    async function parseMessagePayload(payload) {
        const header = toRecord(payload?.header) ?? {};
        const event = toRecord(payload?.event) ?? {};
        const eventType = normalizeText(header.event_type);
        if (eventType !== "im.message.receive_v1")
            return null;
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
        if (!chatId || !senderId || !text)
            return null;
        return { messageId, chatId, chatType, sender: { id: senderId }, mentionedBot, text };
    }
    async function connectLoop() {
        if (stopped)
            return;
        const cfg = await pullConnectConfig();
        if (stopped)
            return;
        if (ws) {
            try {
                ws.close();
            }
            catch {
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
            if (stopped)
                return;
            logger.warn("[feishu] ws closed; scheduling reconnect");
            scheduleReconnect(cfg.reconnectIntervalMs || 120_000, cfg.reconnectNonceMs || 0);
        });
        ws.addEventListener("error", () => {
            if (stopped)
                return;
            logger.warn("[feishu] ws error; scheduling reconnect");
            scheduleReconnect(cfg.reconnectIntervalMs || 120_000, cfg.reconnectNonceMs || 0);
        });
        ws.addEventListener("message", async (ev) => {
            let frame = null;
            const startAt = Date.now();
            try {
                frame = decodeFrame(new Uint8Array(ev.data));
                if (frame.method === 0)
                    return;
                const headers = headersToMap(frame.headers);
                if (headers.type !== "event")
                    return;
                if (!frame.payload)
                    return;
                const payloadText = new TextDecoder().decode(frame.payload);
                const payload = safeJsonParse(payloadText);
                if (!payload)
                    return;
                const msg = await parseMessagePayload(payload);
                if (msg)
                    await handleMessageEvent(msg);
                const ackFrame = {
                    ...frame,
                    headers: [...(frame.headers || []), { key: "biz_rt", value: String(Date.now() - startAt) }],
                    payload: new TextEncoder().encode(JSON.stringify({ code: 200 }))
                };
                if (ws && ws.readyState === WebSocket.OPEN)
                    ws.send(encodeFrame(ackFrame));
            }
            catch (e) {
                logger.error(`[feishu] ws message handling failed: ${e instanceof Error ? e.message : String(e)}`);
                try {
                    if (ws && ws.readyState === WebSocket.OPEN && frame) {
                        ws.send(encodeFrame({
                            ...frame,
                            headers: [...(frame.headers || []), { key: "biz_rt", value: String(Date.now() - startAt) }],
                            payload: new TextEncoder().encode(JSON.stringify({ code: 500 }))
                        }));
                    }
                }
                catch {
                    // ignore
                }
            }
        });
    }
    const gateway = {
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
                }
                catch {
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
                }
                catch {
                    // ignore
                }
                ws = null;
            }
            const runningSse = sseLoopTask;
            sseLoopTask = null;
            if (runningSse) {
                try {
                    await runningSse;
                }
                catch {
                    // ignore
                }
            }
            if (!storeClosed) {
                store.close();
                storeClosed = true;
            }
        },
        async replyText(chatId, messageId, text) {
            await replyText(chatId, messageId, text);
        },
        async sendText(chatId, text) {
            await sendText(chatId, text);
        }
    };
    gateway.start = async () => {
        if (storeClosed)
            throw new Error("[feishu] gateway already stopped");
        stopped = false;
        try {
            sseLoopTask = startSseLoop();
            await connectLoop();
        }
        catch (err) {
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
            async start(params) {
                const gw = createGateway(params);
                await gw.start();
                return {
                    replyText: async ({ chatId, messageId, text }) => {
                        await gw.replyText(chatId, messageId, text);
                    },
                    sendText: async ({ chatId, text }) => {
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
