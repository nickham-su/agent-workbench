<template>
  <a-layout-header class="flex items-center gap-3 !h-12 !px-3 !bg-[var(--panel-bg-elevated)]">
    <div class="flex items-center gap-3 min-w-0">
      <div class="text-[color:var(--text-color)] font-semibold text-sm shrink-0">
        {{ workspace?.title || t("workspace.title") }}
      </div>
      <div v-if="workspace && workspace.repos.length > 0" class="flex items-center gap-2 min-w-0">
        <a-select
          v-model:value="repoDirName"
          size="small"
          class="min-w-[200px]"
          show-search
          :filter-option="filterRepoOption"
          :placeholder="t('workspace.repoSelector.placeholder')"
        >
          <a-select-option
            v-for="r in workspace.repos"
            :key="r.dirName"
            :value="r.dirName"
            :label="`${formatRepoDisplayName(r.repo.url)} ${r.repo.url}`"
          >
            <a-tooltip :mouseEnterDelay="0" :mouseLeaveDelay="0" placement="rightTop">
              <template #title>
                <span class="font-mono break-all">{{ r.repo.url }}</span>
              </template>
              <span class="font-mono">{{ formatRepoDisplayName(r.repo.url) }}</span>
            </a-tooltip>
          </a-select-option>
        </a-select>
        <div v-if="currentRepoStatus" class="text-[color:var(--text-secondary)] text-xs font-mono shrink-0">
          <span v-if="currentRepoStatus.head.detached">{{ t("workspace.repoSelector.detached") }}</span>
          <span v-else>{{ currentRepoStatus.head.branch }}</span>
        </div>
      </div>
    </div>

    <div class="flex items-center gap-2 shrink-0">
      <a-button v-if="workspace && currentTarget" size="small" :disabled="gitBusy" @click="onCheckout">
        {{ t("workspace.actions.checkout") }}
      </a-button>

      <template v-for="group in headerActionGroups" :key="group.key">
        <div class="flex items-center gap-2">
          <a-button
            v-for="action in group.actions"
            :key="action.id"
            size="small"
            :disabled="action.disabled"
            :loading="action.loading"
            @click="action.onClick"
          >
            {{ action.label }}
          </a-button>
        </div>
      </template>
    </div>

    <div class="flex-1 min-w-0"></div>
  </a-layout-header>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { GitStatusResponse, GitTarget, WorkspaceDetail } from "@agent-workbench/shared";
import type { HeaderActionGroup } from "@/features/workspace/types";

const props = defineProps<{
  workspace: WorkspaceDetail | null;
  currentRepoDirName: string;
  currentRepoStatus: GitStatusResponse | null;
  gitBusy: boolean;
  currentTarget: GitTarget | null;
  headerActionGroups: HeaderActionGroup[];
  filterRepoOption: (input: string, option: any) => boolean;
  formatRepoDisplayName: (rawUrl: string) => string;
}>();

const emit = defineEmits<{
  (e: "update:currentRepoDirName", value: string): void;
  (e: "checkout"): void;
}>();

const { t } = useI18n();

const repoDirName = computed({
  get: () => props.currentRepoDirName,
  set: (value: string) => emit("update:currentRepoDirName", value)
});

function onCheckout() {
  emit("checkout");
}
</script>
