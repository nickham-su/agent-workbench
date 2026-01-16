<template>
  <div class="w-full h-full min-h-[240px] flex items-center justify-center">
    <div class="w-full max-w-[500px] mb-40 py-10 px-6 text-center border border-dashed border-[var(--border-color-secondary)] rounded">
      <div class="text-xl font-semibold text-[color:var(--text-color)]">{{ title }}</div>
      <div class="pt-3">
        <slot name="action" />
      </div>
      <div class="pt-4 text-xs leading-6 text-[color:var(--text-tertiary)] mx-auto max-w-[680px] text-left">
        <slot />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
}>();
</script>
