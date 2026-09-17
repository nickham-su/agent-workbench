<template>
  <div class="absolute -top-5 right-1 flex gap-1" data-testid="agent-message-actions">
    <button
      class="px-1 text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      :aria-label="forkLabel"
      :disabled="disabled"
      @click="emit('fork')"
      >{{ forkLabel }}</button
    >
    <button
      class="px-1 text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      :aria-label="revertLabel"
      :disabled="disabled"
      @click="emit('revert')"
      >{{ revertLabel }}</button
    >
  </div>
</template>

<script setup lang="ts">
defineProps<{
  disabled: boolean;
  forkLabel: string;
  revertLabel: string;
}>();
const emit = defineEmits<{
  fork: [];
  revert: [];
}>();
</script>
