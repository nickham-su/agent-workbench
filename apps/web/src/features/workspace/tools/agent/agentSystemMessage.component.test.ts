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
