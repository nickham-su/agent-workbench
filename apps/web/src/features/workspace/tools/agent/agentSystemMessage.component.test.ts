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

test("AgentSystemMessage 可展示压缩摘要标签", () => {
  const wrapper = mount(component.default, {
    props: {
      messageId: "compaction-a",
      text: "保留当前任务与关键约束。",
      label: "上下文已压缩",
    },
  });
  assert.match(wrapper.text(), /上下文已压缩/);
  assert.match(wrapper.text(), /保留当前任务与关键约束/);
  wrapper.unmount();
});
