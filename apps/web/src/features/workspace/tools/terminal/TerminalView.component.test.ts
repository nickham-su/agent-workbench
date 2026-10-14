import assert from "node:assert/strict";
import test, { after, type TestContext } from "node:test";
import { mount, flushPromises } from "@vue/test-utils";
import { computed, nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { Button, Modal } from "ant-design-vue";
import { apiClient } from "@/shared/api/api";
import { workspaceHostKey } from "@/features/workspace/host";
import { workspaceContextKey } from "@/features/workspace/context";
import { terminalFontSize } from "@/shared/settings/uiFontSizes";
import zhCN from "@/shared/i18n/locales/zh-CN";

// xterm's UMD addons expect the browser global before module initialization.
const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
Object.defineProperty(globalThis, "self", { configurable: true, writable: true, value: window });
after(() => {
  if (originalSelf) Object.defineProperty(globalThis, "self", originalSelf);
  else Reflect.deleteProperty(globalThis, "self");
});
type Terminal = import("@xterm/xterm").Terminal;
const { Terminal } = await import("@xterm/xterm");
const { FitAddon } = await import("@xterm/addon-fit");
const { default: TerminalView } = await import("./TerminalView.vue");

async function settle() {
  await nextTick();
  await flushPromises();
  await nextTick();
}

function replaceGlobal(t: TestContext, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  });
}

function setup(t: TestContext) {
  const sockets: FakeWebSocket[] = [];
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    closed = false;
    onopen: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(readonly url: string) { sockets.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.closed = true; this.readyState = 3; }
    open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    output(data: string) { this.onmessage?.({ data: JSON.stringify({ type: "output", data }) }); }
    end(code: number) {
      this.readyState = 3;
      this.onclose?.({ code, reason: "", wasClean: true });
    }
  }
  replaceGlobal(t, "WebSocket", FakeWebSocket);
  const observer = { disconnected: false, callback: () => {}, element: null as Element | null };
  replaceGlobal(t, "ResizeObserver", class {
    constructor(callback: () => void) { observer.callback = callback; }
    observe(element: Element) { observer.element = element; }
    disconnect() { observer.disconnected = true; }
  });

  // Control component timers without waiting for fit bursts or real reconnect delays.
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  t.mock.method(window, "setTimeout", (callback: () => void, delay = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  });
  t.mock.method(window, "clearTimeout", (id: number) => { timers.delete(id); });

  let terminal!: Terminal;
  let container!: HTMLElement;
  let onKey!: (event: KeyboardEvent) => boolean;
  // Use xterm's actual parser/buffer, but avoid its browser renderer/canvas in happy-dom.
  t.mock.method(Terminal.prototype, "open", function (this: Terminal, element: HTMLElement) {
    terminal = this;
    terminal.options.allowProposedApi = true;
    container = element;
    Object.defineProperties(element, { clientWidth: { value: 800 }, clientHeight: { value: 400 } });
  });
  const focus = t.mock.method(Terminal.prototype, "focus", () => {});
  const fit = t.mock.method(FitAddon.prototype, "fit", () => {});
  const links = t.mock.method(Terminal.prototype, "registerLinkProvider", () => ({ dispose() {} }));
  t.mock.method(Terminal.prototype, "attachCustomKeyEventHandler", (listener: (event: KeyboardEvent) => boolean) => { onKey = listener; });

  const requests: string[] = [];
  const originalAdapter = apiClient.defaults.adapter;
  apiClient.defaults.adapter = async (config) => {
    requests.push(config.url ?? "");
    throw new Error("Terminal must not probe files");
  };
  const originalFont = terminalFontSize.value;
  t.after(() => { apiClient.defaults.adapter = originalAdapter; terminalFontSize.value = originalFont; });
  const editorCalls = t.mock.fn();
  const wrapper = mount(TerminalView, {
    attachTo: document.body,
    props: { active: true, terminal: { id: "terminal-a", workspaceId: "workspace-a", sessionName: "session-a", status: "active", createdAt: 1, updatedAt: 1 } },
    global: {
      plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })],
      components: { "a-button": Button },
      provide: {
        [workspaceHostKey as symbol]: { callFrom: editorCalls },
        [workspaceContextKey as symbol]: { repos: computed(() => []), currentTarget: computed(() => null) },
      },
    },
  });
  t.after(async () => { wrapper.unmount(); await settle(); });
  return {
    wrapper, terminal, container, sockets, observer, timers, links, focus, fit, requests, editorCalls,
    input: (data: string) => terminal.input(data, true),
    key: (event: KeyboardEvent) => onKey(event),
    fireTimer(delay: number) {
      const timer = [...timers.entries()].find(([, entry]) => entry.delay === delay);
      assert.ok(timer, `Expected pending timer with delay ${delay}`);
      timers.delete(timer[0]);
      timer[1].callback();
    },
    drain: () => new Promise<void>((resolve) => terminal.write("", resolve)),
  };
}

test("终端不注册路径链接、不探测文件或调用编辑器，普通路径输出与 OSC 8 解析保留", async (t) => {
  const f = setup(t);
  await settle();
  assert.equal(f.links.mock.callCount(), 0);
  assert.equal(f.terminal.options.macOptionClickForcesSelection, true);
  assert.equal(f.terminal.options.linkHandler, null, "不覆盖 xterm 的内建 OSC 8 链接处理");
  f.sockets[0]!.open();
  f.sockets[0]!.output("src/a.ts:12\r\n");
  await f.drain();
  assert.equal(f.terminal.buffer.active.getLine(0)?.translateToString(true), "src/a.ts:12");
  f.container.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  f.container.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));

  const osc = t.mock.fn((_data: string) => false);
  const handler = f.terminal.parser.registerOscHandler(8, osc);
  try {
    f.sockets[0]!.output("\u001b]8;;https://example.com/docs\u001b\\查看文档\u001b]8;;\u001b\\");
    await f.drain();
    assert.equal(osc.mock.callCount(), 2);
    assert.equal(osc.mock.calls[0]!.arguments[0], ";https://example.com/docs");
    assert.equal(f.terminal.buffer.active.getLine(1)?.translateToString(true), "查看文档");
  } finally { handler.dispose(); }
  await settle();
  assert.deepEqual(f.requests, []);
  assert.equal(f.editorCalls.mock.callCount(), 0);
  assert.equal(f.links.mock.callCount(), 0);
});

test("终端保留输入、resize、字体更新、选择复制及卸载清理", async (t) => {
  const f = setup(t);
  await settle();
  const socket = f.sockets[0]!;
  socket.open();
  f.input("echo hello\r");
  assert.ok(socket.sent.some((entry) => entry.type === "resize" && entry.cols === 80 && entry.rows === 24));
  assert.ok(socket.sent.some((entry) => entry.type === "input" && entry.data === "echo hello\r"));
  const fits = f.fit.mock.callCount();
  f.observer.callback();
  window.dispatchEvent(new Event("resize"));
  assert.equal(f.fit.mock.callCount(), fits + 2);
  terminalFontSize.value += 1;
  await settle();
  assert.equal(f.terminal.options.fontSize, terminalFontSize.value);

  t.mock.method(f.terminal, "hasSelection", () => true);
  t.mock.method(f.terminal, "getSelection", () => "src/a.ts:12");
  const copied: string[] = [];
  const copy = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(copy, "clipboardData", { value: { setData: (type: string, text: string) => { assert.equal(type, "text/plain"); copied.push(text); } } });
  f.container.dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, true);
  assert.deepEqual(copied, ["src/a.ts:12"]);
  t.mock.method(navigator.clipboard, "writeText", async (text: string) => { copied.push(text); });
  const key = new Event("keydown", { cancelable: true });
  Object.defineProperties(key, { key: { value: "c" }, ctrlKey: { value: true }, shiftKey: { value: true } });
  assert.equal(f.key(key as KeyboardEvent), false);
  await settle();
  assert.deepEqual(copied, ["src/a.ts:12", "src/a.ts:12"]);
  assert.ok(f.focus.mock.callCount() > 0);

  const dispose = t.mock.method(f.terminal, "dispose", f.terminal.dispose.bind(f.terminal));
  f.wrapper.unmount();
  await settle();
  assert.equal(socket.closed, true);
  assert.equal(f.observer.disconnected, true);
  assert.equal(dispose.mock.callCount(), 1);
  const fitsAfterUnmount = f.fit.mock.callCount();
  window.dispatchEvent(new Event("resize"));
  assert.equal(f.fit.mock.callCount(), fitsAfterUnmount);
});

test("终端保留断线重连与占用后确认抢占", async (t) => {
  const f = setup(t);
  await settle();
  f.sockets[0]!.open();
  f.sockets[0]!.end(1006);
  f.fireTimer(500);
  assert.equal(f.sockets.length, 2);
  assert.equal(new URL(f.sockets[1]!.url).search, "");
  f.sockets[1]!.end(4409);
  await settle();
  assert.ok(f.wrapper.text().includes(zhCN.terminal.occupied.status));
  let takeover!: () => void;
  t.mock.method(Modal, "confirm", (options: Parameters<typeof Modal.confirm>[0]) => {
    takeover = options.onOk as () => void;
    return { destroy() {}, update() {} };
  });
  await f.wrapper.get("button").trigger("click");
  assert.equal(f.sockets.length, 2, "确认前不抢占连接");
  takeover();
  assert.equal(f.sockets.length, 3);
  assert.equal(new URL(f.sockets[2]!.url).searchParams.get("force"), "1");
});
