import assert from "node:assert/strict";
import test from "node:test";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { createI18n } from "vue-i18n";
import { message } from "ant-design-vue";
import Preview from "./AgentAttachmentPreviewModal.vue";
import zhCN from "@/shared/i18n/locales/zh-CN";

async function settle() {
  await nextTick();
  await flushPromises();
  await nextTick();
}
function mountPreview(overrides: Record<string, unknown> = {}) {
  return mount(Preview, {
    attachTo: document.body,
    props: { open: true, loading: false, error: "", url: "blob:first", index: 0, count: 2, ...overrides },
    global: { plugins: [createI18n({ legacy: false, locale: "zh-CN", messages: { "zh-CN": zhCN } })] },
  });
}
function container(wrapper: ReturnType<typeof mountPreview>) {
  return (wrapper.vm as unknown as { previewContainer: HTMLElement }).previewContainer;
}
function image() {
  const element = document.querySelector<HTMLImageElement>(".ant-image-preview-img");
  assert.ok(element, "Ant 专用预览图片应已挂载");
  return element;
}
function navigation(label: string) {
  const element = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(element);
  return element;
}
function toolbar(icon: string) {
  const element = document.querySelector<HTMLElement>(`.ant-image-preview-operations .anticon-${icon}`)?.closest("li");
  assert.ok(element);
  element.click();
}
function key(target: EventTarget, name: string, keyCode: number, shiftKey = false) {
  const event = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, { key: { value: name }, keyCode: { value: keyCode }, shiftKey: { value: shiftKey } });
  target.dispatchEvent(event);
  return event;
}

test("真实 Ant 预览：单图适配宽高且内置缩放、旋转、关闭有效，不新增可见缩略图", async () => {
  const wrapper = mountPreview({ count: 1 });
  try {
    await settle();
    assert.equal(image().getAttribute("src"), "blob:first");
    assert.equal(document.querySelectorAll(".ant-image-preview-wrap").length, 1);
    assert.equal(document.querySelectorAll(".ant-modal-wrap").length, 0);
    assert.equal(document.querySelectorAll(".attachment-preview-navigation").length, 0);
    assert.equal(container(wrapper).querySelector<HTMLElement>(".ant-image")!.style.display, "none");
    assert.equal(getComputedStyle(image()).maxWidth, "100%");
    assert.equal(getComputedStyle(image()).maxHeight, "100%");
    const initialTransform = image().style.transform;
    toolbar("zoom-in");
    await settle();
    assert.notEqual(image().style.transform, initialTransform);
    toolbar("rotate-right");
    await settle();
    assert.match(image().style.transform, /rotate\(90deg\)/);
    toolbar("close");
    await settle();
    assert.equal(wrapper.emitted("close")?.length, 1);
    await wrapper.setProps({ open: false });
    await settle();
    assert.equal(document.querySelector(".attachment-preview-feedback"), null);
  } finally {
    wrapper.unmount();
    await settle();
  }
});

test("真实 Ant 预览：从选中索引开始，加载与请求失败期间仍能切图和关闭", async () => {
  const wrapper = mountPreview({ index: 1, count: 3, url: "", loading: true });
  try {
    await settle();
    assert.match(image().getAttribute("src")!, /^data:image\/gif/);
    assert.match(document.querySelector('[role="status"]')!.textContent!, /加载中/);
    assert.match(document.querySelector(".attachment-preview-navigation")!.textContent!, /2 \/ 3/);
    navigation("下一张图片").click();
    assert.deepEqual(wrapper.emitted("select")?.at(-1), [2]);
    await wrapper.setProps({ index: 2, loading: false, error: "附件加载失败" });
    await settle();
    assert.equal(document.querySelector('[role="alert"]')!.textContent!.trim(), "附件加载失败");
    assert.equal(navigation("下一张图片").disabled, true);
    navigation("上一张图片").click();
    assert.deepEqual(wrapper.emitted("select")?.at(-1), [1]);
    toolbar("close");
    await settle();
    assert.equal(wrapper.emitted("close")?.length, 1);
  } finally {
    wrapper.unmount();
    await settle();
  }
});

test("真实 Ant 预览：坏图片解码错误展示反馈与占位，换图后不会回退或保留错误", async () => {
  const wrapper = mountPreview();
  try {
    await settle();
    image().dispatchEvent(new Event("error"));
    await settle();
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /图片加载失败/);
    assert.match(image().getAttribute("src")!, /^data:image\/gif/);
    assert.equal(document.querySelectorAll(".ant-image-preview-wrap").length, 1);
    navigation("下一张图片").click();
    assert.deepEqual(wrapper.emitted("select")?.at(-1), [1]);
    await wrapper.setProps({ index: 1, loading: true, url: "" });
    await settle();
    assert.equal(document.querySelector('[role="alert"]'), null);
    await wrapper.setProps({ loading: false, url: "blob:second" });
    await settle();
    assert.equal(image().getAttribute("src"), "blob:second");
    assert.equal(document.querySelector('[role="alert"]'), null);
    // 隐藏的 a-image 同样要处理解码失败，不让失败项被过滤后留下空组。
    container(wrapper).querySelector(".ant-image-img")!.dispatchEvent(new Event("error"));
    await settle();
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /图片加载失败/);
    assert.match(image().getAttribute("src")!, /^data:image\/gif/);
  } finally {
    wrapper.unmount();
    await settle();
  }
});

test("真实 Ant 预览：方向键与边界对齐附件，原生 Escape 和导航焦点 Escape 均可关闭", async () => {
  const wrapper = mountPreview();
  try {
    await settle();
    const dialog = container(wrapper).querySelector(".ant-image-preview-wrap")!;
    key(dialog, "ArrowLeft", 37);
    assert.equal(wrapper.emitted("select"), undefined);
    key(dialog, "ArrowRight", 39);
    assert.deepEqual(wrapper.emitted("select"), [[1]]);
    await wrapper.setProps({ index: 1, url: "blob:second" });
    await settle();
    key(dialog, "ArrowRight", 39);
    assert.deepEqual(wrapper.emitted("select"), [[1]]);
    key(dialog, "Escape", 27);
    await settle();
    assert.equal(wrapper.emitted("close")?.length, 1);
    key(navigation("上一张图片"), "Escape", 27);
    assert.equal(wrapper.emitted("close")?.length, 2);
    await wrapper.setProps({ open: false });
    key(window, "ArrowLeft", 37);
    assert.deepEqual(wrapper.emitted("select"), [[1]]);
  } finally {
    wrapper.unmount();
    await settle();
  }
});


function dialogParts(wrapper: ReturnType<typeof mountPreview>) {
  const root = container(wrapper).querySelector<HTMLElement>(".ant-image-preview-wrap")!;
  const sentinels = root.querySelectorAll<HTMLElement>('[tabindex="0"]');
  assert.equal(sentinels.length, 2);
  return { root, start: sentinels[0]!, end: sentinels[1]! };
}
// Happy DOM 不执行浏览器默认 Tab 移焦：先派发真实 keydown（运行 Ant sentinel
// 处理），再按实际 DOM 次序模拟默认移焦，验证导航处于同一个焦点闭环。
function tab(root: HTMLElement, backwards = false) {
  const event = key(document.activeElement!, "Tab", 9, backwards);
  assert.equal(event.defaultPrevented, false, "应用不应覆盖 Ant 的默认 Tab 处理");
  const stops = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'));
  const index = stops.indexOf(document.activeElement as HTMLElement);
  assert.ok(index >= 0);
  stops[(index + (backwards ? -1 : 1) + stops.length) % stops.length]!.focus();
  return document.activeElement;
}

test("真实 Ant 预览：导航在 sentinel 内，Tab/Shift+Tab 焦点路径包含导航并保持循环", async () => {
  const wrapper = mountPreview({ index: 1, count: 3 });
  try {
    await settle();
    const { root, start, end } = dialogParts(wrapper);
    const previous = navigation("上一张图片");
    const next = navigation("下一张图片");
    assert.ok(start.contains(previous));
    assert.ok(start.contains(next));
    assert.ok(root.contains(container(wrapper).querySelector(".attachment-preview-feedback")));
    start.focus();
    assert.equal(tab(root), previous);
    assert.equal(tab(root), next);
    assert.equal(tab(root), end);
    assert.equal(tab(root), previous, "末端 sentinel 经 Ant 处理后回到导航");
    assert.equal(tab(root, true), start);
    assert.equal(tab(root, true), next, "起点 sentinel 经 Ant 处理后反向回到导航");
    assert.equal(tab(root, true), previous);
    key(start, "ArrowRight", 39);
    assert.deepEqual(wrapper.emitted("select"), [[2]], "焦点位于原生 sentinel 时仍能切图");
  } finally {
    wrapper.unmount();
    await settle();
  }
});

test("真实 Ant 双实例：顶层方向键/按钮与解码错误只影响所属实例，底层不变", async () => {
  // 使用相同 URL，验证隔离依赖事件归属，而非仅靠 URL 不同。
  const lower = mountPreview({ index: 1, count: 3, url: "blob:shared" });
  await settle();
  const upper = mountPreview({ index: 1, count: 3, url: "blob:shared" });
  try {
    await settle();
    const lowerRoot = container(lower);
    const upperRoot = container(upper);
    assert.notEqual(lowerRoot, upperRoot);
    assert.equal(lowerRoot.querySelectorAll(".ant-image-preview-wrap").length, 1);
    assert.equal(upperRoot.querySelectorAll(".ant-image-preview-wrap").length, 1);
    const upperDialog = dialogParts(upper);
    upperDialog.start.focus();
    key(upperDialog.start, "ArrowRight", 39);
    assert.deepEqual(upper.emitted("select"), [[2]]);
    assert.equal(lower.emitted("select"), undefined);
    upperRoot.querySelector<HTMLButtonElement>('button[aria-label="上一张图片"]')!.click();
    assert.deepEqual(upper.emitted("select"), [[2], [0]]);
    assert.equal(lower.emitted("select"), undefined);
    upperRoot.querySelector(".ant-image-preview-img")!.dispatchEvent(new Event("error"));
    await settle();
    assert.ok(upperRoot.querySelector('[role="alert"]'));
    assert.equal(lowerRoot.querySelector('[role="alert"]'), null);
    assert.equal(lowerRoot.querySelector(".ant-image-preview-img")!.getAttribute("src"), "blob:shared");
    await upper.setProps({ open: false });
    const lowerDialog = dialogParts(lower);
    lowerDialog.start.focus();
    key(lowerDialog.start, "ArrowLeft", 37);
    assert.deepEqual(lower.emitted("select"), [[0]]);
    assert.deepEqual(upper.emitted("select"), [[2], [0]]);
    key(window, "ArrowRight", 39);
    assert.deepEqual(lower.emitted("select"), [[0]], "不再依赖 window 捕获监听");
  } finally {
    upper.unmount();
    lower.unmount();
    await settle();
  }
});

test("真实 Ant 预览：首次打开、关闭重开及卸载清理不留下焦点圈外的导航", async (t) => {
  const errors = t.mock.method(message, "error", () => undefined);
  const wrapper = mountPreview({ open: false, index: 1, count: 3 });
  try {
    await settle();
    const host = container(wrapper);
    assert.equal(host.querySelector(".attachment-preview-feedback"), null);
    const opening = wrapper.setProps({ open: true });
    await wrapper.setProps({ open: false });
    await opening;
    await settle();
    assert.equal(host.querySelector(".attachment-preview-feedback"), null);
    await wrapper.setProps({ open: true });
    await settle();
    assert.ok(dialogParts(wrapper).start.contains(host.querySelector(".attachment-preview-navigation")));
    await wrapper.setProps({ open: false });
    await wrapper.setProps({ open: true });
    await settle();
    const { start } = dialogParts(wrapper);
    assert.ok(start.contains(host.querySelector(".attachment-preview-navigation")));
    assert.equal(host.querySelectorAll(".ant-image-preview-wrap").length, 1);
    assert.equal(errors.mock.callCount(), 0);
    wrapper.unmount();
    await settle();
    assert.equal(document.body.contains(host), false);
    key(start, "ArrowRight", 39);
    assert.equal(wrapper.emitted("select"), undefined);
    assert.equal(document.querySelector(".attachment-preview-feedback"), null);
  } finally {
    if (wrapper.exists()) wrapper.unmount();
    await settle();
  }
});

test("真实 Ant 预览：DOM 适配节点缺失时明确反馈并关闭，不把导航退回圈外", async (t) => {
  const diagnostics = t.mock.method(console, "error", () => undefined);
  const errors = t.mock.method(message, "error", () => undefined);
  const wrapper = mountPreview({ open: false });
  try {
    await settle();
    // 模拟升级后的结构不再匹配适配器；实际 Ant Dialog 仍正常挂载。
    t.mock.method(container(wrapper), "querySelector", () => null);
    await wrapper.setProps({ open: true });
    await settle();
    assert.equal(wrapper.emitted("close")?.length, 1);
    assert.equal(errors.mock.callCount(), 1);
    assert.equal(errors.mock.calls[0]!.arguments[0], "无法打开图片预览，请刷新页面后重试。");
    assert.equal(diagnostics.mock.callCount(), 1);
    assert.equal(document.querySelector(".attachment-preview-navigation"), null);
  } finally {
    wrapper.unmount();
    await settle();
  }
});
