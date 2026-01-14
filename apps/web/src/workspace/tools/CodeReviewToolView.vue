<template>
  <CodeReviewPanel
    ref="panelRef"
    :workspaceId="workspaceId"
    :gitBusy="gitBusy"
    :beginGitOp="beginGitOp"
    :push="push"
    @changesSummary="(s) => emit('changesSummary', s)"
  />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import type { GitPushRequest } from "@agent-workbench/shared";
import CodeReviewPanel from "../../sections/CodeReviewPanel.vue";
import { useWorkspaceHost } from "../host";

const props = defineProps<{
  workspaceId: string;
  toolId: string;
  gitBusy: boolean;
  beginGitOp: () => () => void;
  push?: (params?: GitPushRequest) => Promise<void>;
}>();

const emit = defineEmits<{
  changesSummary: [summary: { unstaged: number; staged: number }];
}>();

const host = useWorkspaceHost();
const panelRef = ref<any>(null);
let unregister: (() => void) | null = null;

function refresh() {
  return panelRef.value?.refreshAll?.();
}

onMounted(() => {
  unregister = host.registerToolCommands(props.toolId, { refresh });
});

onBeforeUnmount(() => {
  unregister?.();
  unregister = null;
});
</script>

