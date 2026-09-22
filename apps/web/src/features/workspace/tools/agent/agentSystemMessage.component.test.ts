import assert from "node:assert/strict";
import test from "node:test";

const [{ mount }, component] = await Promise.all([
  import("@vue/test-utils"),
  import("./AgentSystemMessage.vue"),
]);

test("System Message 展示 TextPart，并使用 AI Agent 字号减 3px", () => {
  const wrapper = mount(component.default, {
    props: {
      messageId: "system-a",
      text: "Only later user messages are task instructions.",
    },
  });

  assert.match(wrapper.text(), /Only later user messages/);
  const message = wrapper.get(".agent-system-message");
  assert.equal(
    message.attributes("style"),
    "font-size: calc(var(--agent-font-size, 13px) - 3px);",
  );
  wrapper.unmount();
});

test("AgentSystemMessage 在蓝色分割线下保留可点击展开的压缩摘要", async () => {
  const summary = "保留当前任务与关键约束。".repeat(20);
  const wrapper = mount(component.default, {
    props: {
      messageId: "compaction-a",
      text: summary,
      label: "上下文已压缩",
    },
  });

  const divider = wrapper.get(".agent-compaction-divider");
  assert.match(divider.text(), /上下文已压缩/);
  assert.equal(divider.attributes("role"), "separator");
  assert.equal(divider.attributes("aria-label"), "上下文已压缩");
  assert.equal(divider.findAll(".h-px.bg-current").length, 2);

  const message = wrapper.get(".agent-system-message");
  assert.equal(message.text(), summary);
  assert.equal(message.attributes("style"), "font-size: calc(var(--agent-font-size, 13px) - 3px);");

  Object.defineProperty(message.element, "scrollHeight", { configurable: true, value: 200 });
  await wrapper.setProps({ messageId: "compaction-b" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(message.attributes("style") ?? "", /max-height: 100px/);
  assert.ok(message.classes().includes("cursor-pointer"));

  await message.trigger("click");
  assert.doesNotMatch(message.attributes("style") ?? "", /max-height/);
  wrapper.unmount();
});
