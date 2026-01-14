<template>
  <a-dropdown :trigger="['contextmenu']">
    <template #overlay>
      <a-menu v-if="moveTargets.length > 0" @click="onMenuClick">
        <a-menu-item v-for="item in moveTargets" :key="item.area">
          {{ item.label }}
        </a-menu-item>
      </a-menu>
      <a-menu v-else>
        <a-menu-item disabled>
          {{ contextMenuHint || title }}
        </a-menu-item>
      </a-menu>
    </template>

    <a-tooltip :title="title" :mouseEnterDelay="0" :mouseLeaveDelay="0" :placement="tooltipPlacement">
      <button :class="buttonClass" type="button" @click="emit('click')">
        <component :is="icon" class="text-lg" />
      </button>
    </a-tooltip>
  </a-dropdown>
</template>

<script setup lang="ts">
import type { DockArea } from "./host";
import { computed } from "vue";

const props = defineProps<{
  title: string;
  icon: any;
  active: boolean;
  minimized: boolean;
  moveTargets: { area: DockArea; label: string }[];
  contextMenuHint?: string;
  tooltipPlacement?: string;
}>();

const emit = defineEmits<{
  click: [];
  moveTo: [area: DockArea];
}>();

const buttonClass = computed(
  () =>
    "w-8 h-8 flex items-center justify-center rounded hover:bg-[var(--hover-bg)] transition-colors " +
    (props.active ? "bg-[var(--fill-secondary)] text-[color:var(--text-color)]" : "text-[color:var(--text-secondary)]") +
    (props.active && props.minimized ? " opacity-70" : "")
);

const contextMenuHint = computed(() => props.contextMenuHint);
const tooltipPlacement = computed(() => props.tooltipPlacement || "top");

function onMenuClick(info: any) {
  const area = String(info?.key || "") as DockArea;
  if (!area) return;
  emit("moveTo", area);
}
</script>
