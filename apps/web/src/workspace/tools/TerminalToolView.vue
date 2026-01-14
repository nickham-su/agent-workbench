<template>
  <TerminalTabs
    :workspaceId="workspaceId"
    :terminals="terminals"
    @created="refreshTerminals"
    @deleted="refreshTerminals"
    @minimize="minimizeSelf"
  />
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type { TerminalRecord } from "@agent-workbench/shared";
import { listTerminals } from "../../services/api";
import TerminalTabs from "../../sections/TerminalTabs.vue";
import { useWorkspaceHost } from "../host";

const props = defineProps<{ workspaceId: string; toolId: string }>();
const host = useWorkspaceHost();

const terminals = ref<TerminalRecord[]>([]);

async function refreshTerminals() {
  if (!props.workspaceId) return;
  try {
    terminals.value = await listTerminals(props.workspaceId);
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}

function minimizeSelf() {
  host.minimizeTool(props.toolId);
}

watch(
  () => props.workspaceId,
  async () => {
    terminals.value = [];
    await refreshTerminals();
  }
);

onMounted(() => {
  void refreshTerminals();
});
</script>
