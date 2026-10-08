import assert from "node:assert/strict";
import test from "node:test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const [{ mount }, component, { computed, defineComponent, h, nextTick }, { createAgentMessageMutationState }, { runAgentSessionMessageMutation }] = await Promise.all([
  import("@vue/test-utils"),
  import("./AgentMessageActions.vue"),
  import("vue"),
  import("./agentMessageMutationState"),
  import("./agentMessageMutationAction"),
]);

test("真实 AgentMessageActions：点击 Fork 后同 Session DOM disabled，异步完成后恢复", async () => {
  const state = createAgentMessageMutationState();
  const completion = deferred<void>();
  let mutations = 0;
  const parent = defineComponent({
    setup() {
      const disabled = computed(() => state.isPending("session-a"));
      async function fork() {
        await runAgentSessionMessageMutation({
          state,
          sessionId: "session-a",
          mutate: async () => {
            mutations += 1;
            await completion.promise;
          },
          onError: () => assert.fail("本测试不应进入错误分支"),
        });
      }
      return () => h(component.default, {
        disabled: disabled.value,
        forkLabel: "fork",
        revertLabel: "revert",
        onFork: fork,
      });
    },
  });
  const wrapper = mount(parent, {
    attachTo: document.body,
  });
  const buttons = wrapper.findAll("button");
  assert.equal(buttons.length, 2);
  assert.equal((buttons[0].element as HTMLButtonElement).disabled, false);
  await buttons[0].trigger("click");
  await nextTick();
  assert.equal(mutations, 1);
  assert.equal((buttons[0].element as HTMLButtonElement).disabled, true);
  assert.equal((buttons[1].element as HTMLButtonElement).disabled, true);
  // disabled 的 Revert 真实 DOM 点击不能发起第二个 mutation。
  await buttons[1].trigger("click");
  assert.equal(mutations, 1);
  completion.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await nextTick();
  assert.equal((buttons[0].element as HTMLButtonElement).disabled, false);
  assert.equal((buttons[1].element as HTMLButtonElement).disabled, false);
  wrapper.unmount();
});

test("真实 AgentMessageActions：独立控制 Fork 与 Revert 按钮组合", async () => {
  const wrapper = mount(component.default, {
    props: {
      disabled: false,
      forkLabel: "fork",
      revertLabel: "revert",
      showFork: true,
      showRevert: false,
    },
  });
  assert.equal(wrapper.findAll("button").length, 1);
  assert.equal(wrapper.get("button").attributes("aria-label"), "fork");
  await wrapper.setProps({ showFork: false, showRevert: true });
  assert.equal(wrapper.findAll("button").length, 1);
  assert.equal(wrapper.get("button").attributes("aria-label"), "revert");
  await wrapper.setProps({ showFork: true, showRevert: true });
  assert.deepEqual(wrapper.findAll("button").map((button) => button.attributes("aria-label")), ["fork", "revert"]);
  await wrapper.setProps({ showFork: false, showRevert: false });
  assert.equal(wrapper.find('[data-testid="agent-message-actions"]').exists(), false);
  wrapper.unmount();
});

test("真实 AgentMessageActions：在操作按钮左侧展示消息元数据，ID 可点击", async () => {
  const wrapper = mount(component.default, {
    props: {
      disabled: false,
      messageId: "message-123",
      copyMessageIdLabel: "复制消息 ID",
      timeText: "14:32:08",
      toolsText: "bash, read ×2",
      forkLabel: "fork",
      revertLabel: "revert",
      showFork: true,
      showRevert: true,
    },
  });

  const buttons = wrapper.findAll("button");
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0]!.text(), "message-123");
  assert.equal(buttons[0]!.attributes("aria-label"), "复制消息 ID");
  assert.equal(wrapper.get('[data-testid="agent-message-time"]').text(), "14:32:08");
  const tools = wrapper.get('[data-testid="agent-message-tools"]');
  assert.equal(tools.text(), "bash, read ×2");
  assert.ok(buttons[0]!.classes().includes("cursor-pointer"));
  assert.ok(tools.classes().includes("cursor-pointer"));
  assert.equal(wrapper.findAll('span[aria-hidden="true"]').length, 2);
  await buttons[0]!.trigger("click");
  assert.equal(wrapper.emitted("copyMessageId")?.length, 1);
  assert.deepEqual(buttons.slice(1).map((button) => button.attributes("aria-label")), ["fork", "revert"]);
  wrapper.unmount();
});
