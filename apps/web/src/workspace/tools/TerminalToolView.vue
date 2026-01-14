<template>
  <TerminalTabs
    :workspaceId="workspaceId"
    :terminals="terminals"
    @created="refreshTerminals"
    @deleted="onDeleted"
    @terminal-exited="onTerminalExited"
    @minimize="minimizeSelf"
  />
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type { TerminalRecord } from "@agent-workbench/shared";
import { createTerminal, listTerminals } from "../../services/api";
import TerminalTabs from "../../sections/TerminalTabs.vue";
import { useWorkspaceHost } from "../host";

const props = defineProps<{ workspaceId: string; toolId: string }>();
const host = useWorkspaceHost();

const terminals = ref<TerminalRecord[]>([]);
const autoCreating = ref(false);

async function refreshTerminals(): Promise<boolean> {
  if (!props.workspaceId) return false;
  try {
    terminals.value = await listTerminals(props.workspaceId);
    return true;
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function ensureTerminalOnActivate() {
  if (!props.workspaceId) return;
  if (autoCreating.value) return;
  if (terminals.value.length > 0) return;

  autoCreating.value = true;
  try {
    await createTerminal(props.workspaceId, {});
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  } finally {
    autoCreating.value = false;
  }
  await refreshTerminals();
}

function minimizeSelf() {
  host.minimizeTool(props.toolId);
}

async function onTerminalExited() {
  await refreshTerminals();
  if (terminals.value.length === 0) minimizeSelf();
}

async function onDeleted() {
  await refreshTerminals();
  if (terminals.value.length === 0) minimizeSelf();
}

watch(
  () => props.workspaceId,
  async () => {
    terminals.value = [];
    const ok = await refreshTerminals();
    if (ok) await ensureTerminalOnActivate();
  }
);

onMounted(() => {
  void refreshTerminals().then((ok) => {
    if (ok) return ensureTerminalOnActivate();
  });
});
</script>
