<template>
  <a-layout-header class="flex items-center gap-3 !h-12 !px-3 !bg-[var(--panel-bg-elevated)]">
    <div class="flex items-center gap-3 min-w-0">
      <div class="text-[color:var(--text-color)] font-semibold text-sm shrink-0">
        {{ workspace?.title || t("workspace.title") }}
      </div>
    </div>

    <div class="flex items-center gap-2 shrink-0">
      <template v-for="(group, groupIndex) in headerActionGroups" :key="group.key">
        <a-divider v-if="groupIndex > 0" type="vertical" class="!mx-0 !h-5 !border-[var(--border-color-secondary)]" />

        <div class="flex items-center gap-2">
          <template v-for="(segment, segmentIndex) in splitActionSegments(group.actions)" :key="`${group.key}:${segment.key}`">
            <a-divider v-if="segmentIndex > 0" type="vertical" class="!mx-0 !h-4 !border-[var(--border-color-secondary)]" />

            <template v-for="action in segment.actions" :key="action.id">
            <a-button
              v-if="!action.tooltip"
              size="small"
              :disabled="action.disabled"
              :loading="action.loading"
              @click="action.onClick"
            >
              <template v-if="action.icon" #icon><component :is="action.icon" /></template>
              <span v-if="action.label">{{ action.label }}</span>
            </a-button>

            <a-tooltip
              v-else
              :title="action.tooltip"
              :mouseEnterDelay="0"
              :mouseLeaveDelay="0"
              placement="top"
            >
              <a-button
                size="small"
                :disabled="action.disabled"
                :loading="action.loading"
                @click="action.onClick"
              >
                <template v-if="action.icon" #icon><component :is="action.icon" /></template>
                <span v-if="action.label">{{ action.label }}</span>
              </a-button>
            </a-tooltip>
            </template>
          </template>
          </div>
      </template>
    </div>

    <div class="flex-1 min-w-0"></div>
  </a-layout-header>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { WorkspaceDetail } from "@agent-workbench/shared";
import type { HeaderActionGroup } from "@/features/workspace/types";

defineProps<{
  workspace: WorkspaceDetail | null;
  headerActionGroups: HeaderActionGroup[];
}>();

const { t } = useI18n();

function normalizedActionGroupKey(groupKey: string | undefined) {
  return groupKey?.trim() || "__default";
}

function splitActionSegments(actions: HeaderActionGroup["actions"]) {
  const segments: { key: string; actions: HeaderActionGroup["actions"] }[] = [];
  for (const action of actions) {
    const key = normalizedActionGroupKey(action.groupKey);
    const prev = segments[segments.length - 1];
    if (!prev || prev.key !== key) {
      segments.push({ key, actions: [action] });
      continue;
    }
    prev.actions.push(action);
  }
  return segments;
}

</script>
