<template>
  <div
    ref="rootEl"
    class="awb-text-message whitespace-pre-wrap break-words select-text font-mono text-[color:var(--text-secondary)]"
    :style="collapsedStyle"
    :class="[
      expandable ? 'cursor-pointer' : '',
      tone === 'error' ? 'text-red-500' : ''
    ]"
    @click="onToggle"
  >
    {{ props.text }}
    <slot name="suffix" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";

const props = defineProps<{
  text: string;
  messageId: number;
  expanded?: boolean;
  maxHeightPx?: number;
  tone?: "normal" | "error";
}>();

const emit = defineEmits<{
  toggle: [expanded: boolean];
  requestMeasure: [messageId: number];
  clampChange: [clamped: boolean];
}>();

const rootEl = ref<HTMLElement | null>(null);
const expandable = ref(false);

const maxHeightPx = computed(() => {
  const raw = typeof props.maxHeightPx === "number" ? props.maxHeightPx : 100;
  if (!Number.isFinite(raw) || raw <= 0) return 100;
  return Math.floor(raw);
});

const expanded = computed(() => props.expanded === true);

async function measureExpandable() {
  await nextTick();
  const el = rootEl.value;
  if (!el) return;
  // scrollHeight 是内容全高,不受 max-height 影响。
  expandable.value = el.scrollHeight > maxHeightPx.value;
}

const collapsedStyle = computed(() => {
  if (!expandable.value) return undefined;
  if (expanded.value) return undefined;
  return {
    maxHeight: `${maxHeightPx.value}px`,
    overflow: "hidden"
  } as const;
});

function onToggle() {
  if (!expandable.value) return;
  // 避免用户选择文本时误触发展开/收起。
  const selection = window.getSelection?.();
  if (selection && selection.rangeCount > 0) {
    const text = selection.toString?.() ?? "";
    const anchor = selection.anchorNode;
    if (text.trim().length > 0 && anchor && rootEl.value?.contains(anchor)) {
      return;
    }
  }
  emit("toggle", !expanded.value);
}

const clampEnabled = computed(() => expandable.value && !expanded.value);

watch(
  () => clampEnabled.value,
  (next, prev) => {
    if (next === prev) return;
    emit("clampChange", next);
    emit("requestMeasure", props.messageId);
  }
);

watch(
  () => [props.text, props.messageId, maxHeightPx.value],
  () => {
    void measureExpandable();
  },
  { immediate: true }
);

onMounted(() => {
  void measureExpandable();
});
</script>
