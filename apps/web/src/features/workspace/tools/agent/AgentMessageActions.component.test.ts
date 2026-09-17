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
