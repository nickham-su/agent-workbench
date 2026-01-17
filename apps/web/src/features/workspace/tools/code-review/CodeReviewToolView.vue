<template>
  <CodeReviewPanel
    v-if="target"
    ref="panelRef"
    :workspaceId="workspaceId"
    :target="target"
    :gitBusy="gitBusy"
    :beginGitOp="beginGitOp"
    :push="push"
    @changesSummary="(s) => emit('changesSummary', s)"
  />
  <div v-else class="h-full min-h-0 flex items-center justify-center text-xs text-[color:var(--text-tertiary)]">
    {{ t("codeReview.placeholder.selectRepo") }}
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { GitPushRequest, GitTarget } from "@agent-workbench/shared";
import CodeReviewPanel from "./CodeReviewPanel.vue";
import { useWorkspaceHost } from "@/features/workspace/host";

const props = defineProps<{
  workspaceId: string;
  target: GitTarget | null;
  toolId: string;
  gitBusy: boolean;
  beginGitOp: () => () => void;
  push?: (params?: Omit<GitPushRequest, "target">) => Promise<void>;
}>();

const emit = defineEmits<{
  changesSummary: [summary: { unstaged: number; staged: number }];
}>();

const host = useWorkspaceHost();
const { t } = useI18n();
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
