<template>
  <div class="h-full flex flex-col min-h-0">
    <div
      v-if="showOccupiedUi"
      class="flex items-center justify-between gap-2 p-2 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)]"
    >
      <div class="text-xs text-[color:var(--text-secondary)]">{{ t("terminal.occupied.status") }}</div>
      <a-button size="small" type="primary" @click="confirmTakeover" :disabled="connecting">{{ t("terminal.occupied.takeover") }}</a-button>
    </div>

    <div class="flex-1 px-1 min-h-0 rounded-none overflow-hidden bg-[#0b0f14] text-[#e5e7eb]">
      <div
          ref="containerEl"
          class="w-full h-full"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { Modal, message } from "ant-design-vue";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TerminalRecord } from "@agent-workbench/shared";
import { parseWsMessage, sendWs, terminalWsUrl, type TerminalWsState } from "./ws";
import { getTerminalLinkStatStore } from "./terminalLinkStatStore";
import { terminalFontSize } from "@/shared/settings/uiFontSizes";
import { emitUnauthorized } from "@/features/auth/unauthorized";
import { useWorkspaceHost } from "@/features/workspace/host";
import { useWorkspaceContext } from "@/features/workspace/context";

const props = defineProps<{ terminal: TerminalRecord; active?: boolean }>();
const emit = defineEmits<{
  exited: [{ terminalId: string; exitCode: number }];
}>();
const { t } = useI18n();
const host = useWorkspaceHost();
const workspaceCtx = useWorkspaceContext();

type BufferLine = {
  length: number;
  getCell: (x: number) => { getChars: () => string; getWidth: () => number } | undefined;
};

const wsState = ref<TerminalWsState>("idle");
const connecting = computed(() => wsState.value === "connecting");
const occupied = ref(false);
const showOccupiedUi = computed(() => wsState.value === "blocked" && occupied.value);
const isActive = computed(() => props.active !== false);
let ws: WebSocket | null = null;
let term: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let lastSize: { cols: number; rows: number } | null = null;
const containerEl = ref<HTMLElement | null>(null);
let resizeObserver: ResizeObserver | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempts = 0;
let closingByUs = false;
let fitBurstTimers: number[] = [];
let didResizeNudge = false;
let removeElListeners: (() => void) | null = null;
let stopWatchFontSize: (() => void) | null = null;
let linkProviderDisposable: { dispose: () => void } | null = null;

function focusIfActive() {
  if (!term) return;
  if (!isActive.value) return;
  term.focus();
}

function focusIfActiveSoon() {
  void nextTick().then(() => {
    focusIfActive();
    requestAnimationFrame(() => focusIfActive());
  });
}

async function copyTextToClipboard(text: string) {
  const content = String(text ?? "");
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
    return;
  } catch {
    // ignore
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = content;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    message.error(t("terminal.copyFailed", { reason }));
  }
}

function writeHint(lines: string[]) {
  if (!term) return;
  term.write("\r\n");
  for (const line of lines) {
    term.write(`${line}\r\n`);
  }
  term.write("\r\n");
}

function cleanupWs() {
  if (!ws) return;
  closingByUs = true;
  ws.close();
  ws = null;
  wsState.value = "idle";
}

function closeWsKeepState() {
  if (!ws) return;
  closingByUs = true;
  ws.close();
  ws = null;
}

function cleanupTerm() {
  if (term) {
    term.dispose();
  }
  linkProviderDisposable?.dispose();
  linkProviderDisposable = null;
  term = null;
  fitAddon = null;
  lastSize = null;
  didResizeNudge = false;
}

function clearFitBurst() {
  for (const t of fitBurstTimers) window.clearTimeout(t);
  fitBurstTimers = [];
}

function runFitBurst() {
  // 初始渲染/布局切换时，容器尺寸与字体度量会经历多个阶段（尤其是 Tabs/布局网格变化）；
  // 用短促的“fit 冲刺”来保证 tmux 最终拿到正确的 cols/rows，避免提前换行或黑屏需手动 resize 才恢复。
  clearFitBurst();
  const delays = [0, 50, 120, 240, 450, 800, 1400];
  fitBurstTimers = delays.map((ms) =>
    window.setTimeout(() => {
      tryFitAndResize();
    }, ms)
  );
}

function tryFitAndResize() {
  if (!term || !fitAddon || !containerEl.value) return;
  const el = containerEl.value;
  if (el.clientWidth <= 0 || el.clientHeight <= 0) return;

  fitAddon.fit();
  const cols = term.cols;
  const rows = term.rows;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!lastSize || lastSize.cols !== cols || lastSize.rows !== rows) {
    lastSize = { cols, rows };
    sendWs(ws, { type: "resize", cols, rows });
  }
}

function nudgeResizeToForceRedraw() {
  if (!term) return;
  if (didResizeNudge) return;
  if (term.cols <= 0 || term.rows <= 0) return;
  didResizeNudge = true;

  const cols = term.cols;
  const rows = term.rows;
  try {
    term.resize(cols + 1, rows);
    term.resize(cols, rows);
  } catch {
    // ignore
  } finally {
    // 确保最终 cols/rows 同步到后端 tmux
    lastSize = null;
    tryFitAndResize();
  }
}

function clearReconnectTimer() {
  if (reconnectTimer === null) return;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (closingByUs) return;
  if (wsState.value === "blocked") return;
  if (reconnectAttempts >= 5) {
    wsState.value = "errored";
    writeHint([
      t("terminal.hint.autoReconnectFailedLine0", { attempts: reconnectAttempts }),
      t("terminal.hint.autoReconnectFailedLine1"),
      t("terminal.hint.autoReconnectFailedLine2")
    ]);
    return;
  }

  reconnectAttempts += 1;
  const delayMs = Math.min(10_000, 500 * Math.pow(2, reconnectAttempts - 1));
  clearReconnectTimer();
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect(false);
  }, delayMs);

  writeHint([t("terminal.hint.autoReconnecting", { attempt: reconnectAttempts, seconds: Math.ceil(delayMs / 1000) })]);
}

function connect(force: boolean) {
  clearReconnectTimer();
  clearFitBurst();
  cleanupWs();
  wsState.value = "connecting";
  closingByUs = false;
  occupied.value = false;
  // 每次重新连接都会在服务端重新 spawn 一个 PTY；必须重新发送一次 resize，否则 tmux 会沿用默认大小导致换行/光标错位
  lastSize = null;

  try {
    ws = new WebSocket(terminalWsUrl(props.terminal.id, force));
  } catch (err) {
    wsState.value = "errored";
    message.error(err instanceof Error ? err.message : String(err));
    writeHint([t("terminal.hint.connectFailedLine0"), t("terminal.hint.connectFailedLine1")]);
    scheduleReconnect();
    return;
  }

  let opened = false;
  ws.onopen = () => {
    const socket = ws;
    if (!socket) return;
    opened = true;
    wsState.value = "connected";
    reconnectAttempts = 0;
    lastSize = null;
    // 连接建立后，立刻做一次 fit+resize，并启动一次 fit 冲刺，确保 tmux cols/rows 最终正确
    tryFitAndResize();
    runFitBurst();
    // 某些场景首次创建终端会出现“黑屏但可交互”，轻微窗口 resize 会恢复；
    // 这里用一次性 resize-nudge 触发 xterm 完整重绘，模拟该恢复路径
    window.setTimeout(() => nudgeResizeToForceRedraw(), 60);
    focusIfActiveSoon();
  };
  ws.onerror = () => {
    if (!opened) scheduleReconnect();
  };
  ws.onclose = (evt) => {
    clearFitBurst();
    if (evt.code === 4401) {
      wsState.value = "errored";
      clearReconnectTimer();
      writeHint([
        t("terminal.hint.unauthorizedLine0"),
        t("terminal.hint.unauthorizedLine1", { code: evt.code, reason: evt.reason || "-", wasClean: String(evt.wasClean) })
      ]);
      emitUnauthorized();
      return;
    }
    if (evt.code === 4409) {
      wsState.value = "blocked";
      occupied.value = true;
      clearReconnectTimer();
      writeHint([
        t("terminal.hint.blockedLine0"),
        t("terminal.hint.blockedLine1", { code: evt.code, reason: evt.reason || "-", wasClean: String(evt.wasClean) }),
        t("terminal.hint.blockedLine2")
      ]);
      return;
    }
    if (wsState.value === "connected") {
      wsState.value = "disconnected";
      writeHint([
        t("terminal.hint.disconnectedLine0"),
        t("terminal.hint.disconnectedLine1", { code: evt.code, reason: evt.reason || "-", wasClean: String(evt.wasClean) }),
        t("terminal.hint.disconnectedLine2")
      ]);
      scheduleReconnect();
    }
    if (!opened) {
      scheduleReconnect();
    }
  };
  ws.onmessage = (evt) => {
    const msg = parseWsMessage(evt);
    if (!msg) return;

    if (msg.type === "output") {
      term?.write(msg.data);
      // 首次输出后也做一次 nudge，进一步覆盖“无终端->新建终端”的首屏渲染异常
      window.setTimeout(() => nudgeResizeToForceRedraw(), 0);
      return;
    }
    if (msg.type === "exit") {
      term?.write(`\r\n${t("terminal.hint.closed", { exitCode: msg.exitCode })}\r\n`);
      wsState.value = "disconnected";
      closeWsKeepState();
      clearReconnectTimer();
      emit("exited", { terminalId: props.terminal.id, exitCode: msg.exitCode });
      return;
    }
    if (msg.type === "error") {
      term?.write(`\r\n${t("terminal.hint.error", { message: msg.message })}\r\n`);
      return;
    }
  };
}

function buildColumnInfoMap(line: BufferLine, lineText: string) {
  const map: Array<{ col: number; width: number }> = [];
  if (!lineText) return map;
  const maxCols = Math.min(line.length, term?.cols ?? line.length);
  let charIndex = 0;
  for (let col = 0; col < maxCols && charIndex < lineText.length; col += 1) {
    const cell = line.getCell(col);
    if (!cell) continue;
    const chars = cell.getChars();
    if (!chars) continue;
    const width = Math.max(1, cell.getWidth());
    for (let i = 0; i < chars.length && charIndex < lineText.length; i += 1) {
      map[charIndex] = { col: col + 1, width };
      charIndex += 1;
    }
  }
  return map;
}

function canonicalizeTerminalLinkPath(params: { rawPath: string; currentDirName: string }) {
  let p = String(params.rawPath || "").trim();
  if (!p) return "";

  // 去掉前导 ./，避免输出为 ./repo/xxx 时无法正确归一化
  while (p.startsWith("./")) p = p.slice(2);

  // 兼容部分工具输出反斜杠分隔符
  p = p.replace(/\\/g, "/");
  // 合并重复的 /
  p = p.replace(/\/{2,}/g, "/");
  // 去掉尾部 /
  while (p.endsWith("/")) p = p.slice(0, -1);

  const dir = String(params.currentDirName || "").trim();
  if (dir) {
    if (p === dir) return "";
    if (p.startsWith(dir + "/")) p = p.slice(dir.length + 1);
  }

  return p;
}

function firstPathSegment(p: string) {
  const s = String(p || "").trim();
  if (!s) return "";
  // canonicalizeTerminalLinkPath 已保证分隔符为 / 且无前导 ./
  return s.split("/")[0] ?? "";
}

function createPathLineLinks(lineText: string, bufferLineNumber: number, line: BufferLine | null) {
  const links: Array<{
    text: string;
    range: { start: { x: number; y: number }; end: { x: number; y: number } };
    activate: (event: MouseEvent, text: string) => void;
  }> = [];
  if (!lineText || !line) return links;

  const target = workspaceCtx.currentTarget.value;
  if (!target) return links;
  const otherRepoDirNames = new Set(
    workspaceCtx.repos.value
      .map((r) => r.dirName)
      .filter((dirName) => dirName && dirName !== target.dirName)
  );
  const statStore = getTerminalLinkStatStore(target.workspaceId);
  const columnInfo = buildColumnInfoMap(line, lineText);
  const re = /(^|[^A-Za-z0-9_./-])([A-Za-z0-9_./-]+):([1-9][0-9]*)/g;
  let match: RegExpExecArray | null = null;
  let count = 0;
  while ((match = re.exec(lineText))) {
    if (count >= 20) break;
    const prefix = match[1] ?? "";
    const path = match[2] ?? "";
    const line = Number(match[3] ?? 0);
    if (!path || !Number.isFinite(line) || line <= 0) continue;
    if (path.startsWith("/")) continue;
    const parts = path.split("/");
    if (parts.some((p) => p === "..")) continue;

    const linkPath = canonicalizeTerminalLinkPath({ rawPath: path, currentDirName: target.dirName });
    if (!linkPath) continue;
    // 若路径第一级命中“其他 repo 的 dirName”，大概率是 AI/CLI 输出带了别的 repo 前缀；
    // 由于 files.openAt 只会在当前 repo 下解析，这里直接不生成链接，避免误触与无效校验请求。
    const firstSeg = firstPathSegment(linkPath);
    if (firstSeg && otherRepoDirNames.has(firstSeg)) continue;

    const startIndex = match.index + prefix.length;
    const text = `${path}:${line}`;
    const endIndex = startIndex + text.length - 1;
    const startInfo = columnInfo[startIndex];
    const endInfo = columnInfo[endIndex];
    const startCol = startInfo?.col ?? startIndex + 1;
    const endBase = endInfo?.col ?? endIndex + 1;
    const endCol = endBase + Math.max(1, endInfo?.width ?? 1) - 1;
    const linkLine = line;

    links.push({
      text,
      range: { start: { x: startCol, y: bufferLineNumber }, end: { x: endCol, y: bufferLineNumber } },
      activate: (event) => {
        // 仅响应鼠标左键点击；按住 Alt/Option 时保留为“强制选择文本”手势
        if (event.button !== 0) return;
        if (event.altKey) return;
        void (async () => {
          const res = await statStore.ensureStat({ target, path: linkPath });
          if (!res || !res.ok) return;
          const finalPath = res.normalizedPath || res.path;
          host.openTool("files");
          host.callFrom("terminal", "files", {
            type: "files.openAt",
            payload: { path: finalPath, line: linkLine, highlight: { kind: "line" } }
          });
        })();
      }
    });
    count += 1;
  }

  return links;
}

function confirmTakeover() {
  Modal.confirm({
    title: t("terminal.takeover.title"),
    content: t("terminal.takeover.content"),
    okText: t("terminal.takeover.ok"),
    okType: "danger",
    cancelText: t("terminal.takeover.cancel"),
    onOk: () => connect(true)
  });
}

onMounted(() => {
  const el = containerEl.value;
  if (!el) return;

  term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: terminalFontSize.value,
    theme: {
      background: "#0b0f14",
      foreground: "#e5e7eb",
      cursor: "#e5e7eb",
      selectionBackground: "rgba(255,255,255,0.25)"
    },
    // 允许在 tmux 开启 mouse mode 时，按住 Option(⌥) 强制走 xterm 的文本选择（不向后端应用发送鼠标事件）
    macOptionClickForcesSelection: true,
    scrollback: 2000
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(el);
  focusIfActiveSoon();

  linkProviderDisposable = term.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const line = term?.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const lineText = line.translateToString(true);
      const links = createPathLineLinks(lineText, bufferLineNumber, line as BufferLine);
      callback(links.length > 0 ? links : undefined);
    }
  });

  // 初始渲染时容器尺寸/字体度量可能还不稳定，先提前做一次 fit（不依赖 ws）
  void nextTick().then(() => {
    runFitBurst();
    requestAnimationFrame(() => runFitBurst());
  });

  // 字体加载完成后再做一次 fit（部分环境下首屏度量会偏）
  try {
    const fonts = (document as any).fonts;
    if (fonts?.ready?.then) {
      fonts.ready.then(() => {
        lastSize = null;
        runFitBurst();
      });
    }
  } catch {
    // ignore
  }

  term.onData((data) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    sendWs(ws, { type: "input", data });
  });

  const handleMouseDown = () => {
    term?.focus();
    tryFitAndResize();
  };

  const handleCopy = (evt: ClipboardEvent) => {
    if (!term || !term.hasSelection()) return;
    const text = term.getSelection();
    if (!text) return;

    if (evt.clipboardData) {
      evt.clipboardData.setData("text/plain", text);
      evt.preventDefault();
      return;
    }

    evt.preventDefault();
    void copyTextToClipboard(text);
  };

  el.addEventListener("mousedown", handleMouseDown);
  el.addEventListener("copy", handleCopy);
  removeElListeners = () => {
    el.removeEventListener("mousedown", handleMouseDown);
    el.removeEventListener("copy", handleCopy);
  };

  term.attachCustomKeyEventHandler((evt: KeyboardEvent) => {
    if (!term) return true;
    const key = (evt.key || "").toLowerCase();
    const isCopy = (evt.metaKey && key === "c") || (evt.ctrlKey && evt.shiftKey && key === "c");
    if (!isCopy) return true;
    if (!term.hasSelection()) return true;

    evt.preventDefault();
    evt.stopPropagation();
    void copyTextToClipboard(term.getSelection());
    return false;
  });

  window.addEventListener("resize", tryFitAndResize);
  resizeObserver = new ResizeObserver(() => {
    tryFitAndResize();
  });
  resizeObserver.observe(el);

  connect(false);

  stopWatchFontSize = watch(
    () => terminalFontSize.value,
    (next) => {
      if (!term) return;
      term.options.fontSize = next;
      lastSize = null;
      void nextTick().then(() => runFitBurst());
    }
  );
});

watch(
  () => isActive.value,
  (active) => {
    if (!active) return;
    // Tab 切换/激活时，容器宽度经常发生变化；强制重新 fit+resize，避免 tmux cols 过小导致提前换行
    lastSize = null;
    void nextTick().then(() => {
      runFitBurst();
      focusIfActive();
      requestAnimationFrame(() => focusIfActive());
    });
  },
  { immediate: true }
);

onBeforeUnmount(async () => {
  window.removeEventListener("resize", tryFitAndResize);
  resizeObserver?.disconnect();
  resizeObserver = null;
  removeElListeners?.();
  removeElListeners = null;
  stopWatchFontSize?.();
  stopWatchFontSize = null;
  clearReconnectTimer();
  clearFitBurst();
  cleanupWs();
  await nextTick();
  cleanupTerm();
});
</script>
