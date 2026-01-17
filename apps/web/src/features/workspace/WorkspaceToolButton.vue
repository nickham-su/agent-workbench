<template>
  <a-dropdown :trigger="['contextmenu']">
    <template #overlay>
      <a-menu @click="onMenuClick">
        <a-menu-item key="moveUp" :disabled="!canMoveUp">
          {{ t("workspace.dock.moveUp") }}
        </a-menu-item>
        <a-menu-item key="moveDown" :disabled="!canMoveDown">
          {{ t("workspace.dock.moveDown") }}
        </a-menu-item>
        <a-menu-divider v-if="moveTargets.length > 0" />
        <a-menu-item v-for="item in moveTargets" :key="`moveTo:${item.area}`">
          {{ item.label }}
        </a-menu-item>
        <a-menu-item v-if="moveTargets.length === 0" disabled>
          {{ contextMenuHint || title }}
        </a-menu-item>
      </a-menu>
    </template>

    <a-tooltip :title="title" :mouseEnterDelay="0" :mouseLeaveDelay="0" :placement="tooltipPlacement">
      <button :class="buttonClass" type="button" tabindex="-1" @click="onButtonClick" @keydown="onButtonKeyDown">
        <component :is="icon" class="text-lg" />
        <span v-if="dot" class="absolute right-1 top-1 h-2 w-2 rounded-full bg-[var(--danger-color)]"></span>
      </button>
    </a-tooltip>
  </a-dropdown>
</template>

<script setup lang="ts">
import type { DockArea } from "./host";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  title: string;
  icon: any;
  active: boolean;
  minimized: boolean;
  dot?: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveTargets: { area: DockArea; label: string }[];
  contextMenuHint?: string;
  tooltipPlacement?: string;
}>();

const emit = defineEmits<{
  click: [];
  moveUp: [];
  moveDown: [];
  moveTo: [area: DockArea];
}>();

const buttonClass = computed(
  () =>
    // Tailwind 关闭 preflight 后，原生 button 会保留 UA 默认背景/边框；这里做局部 reset，避免未选中态出现“白底按钮”。
    "w-8 h-8 flex items-center justify-center rounded transition-colors border-0 appearance-none relative " +
    (props.active
      ? "bg-[var(--fill-secondary)] text-[color:var(--text-color)]"
      : "bg-transparent text-[color:var(--text-secondary)] hover:bg-[var(--hover-bg)]") +
    (props.active && props.minimized ? " opacity-70" : "")
);

const contextMenuHint = computed(() => props.contextMenuHint);
const tooltipPlacement = computed(() => props.tooltipPlacement || "top");
const { t } = useI18n();

function onMenuClick(info: any) {
  const key = String(info?.key || "");
  if (key === "moveUp") {
    emit("moveUp");
    return;
  }
  if (key === "moveDown") {
    emit("moveDown");
    return;
  }
  if (!key.startsWith("moveTo:")) return;
  const area = key.slice("moveTo:".length) as DockArea;
  if (!area) return;
  emit("moveTo", area);
}

function onButtonClick(event: MouseEvent) {
  emit("click");
  (event.currentTarget as HTMLButtonElement | null)?.blur();
}

function onButtonKeyDown(event: KeyboardEvent) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
}
</script>
