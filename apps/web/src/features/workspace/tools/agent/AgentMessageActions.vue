<template>
  <div
    class="pointer-events-none absolute right-1 z-10 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
    :class="outside ? '-top-5' : 'top-0.5'"
    data-testid="agent-message-actions"
  >
    <button
      type="button"
      class="flex h-5 w-5 items-center justify-center border-0 bg-transparent p-0 text-[12px] text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      :title="forkLabel"
      :aria-label="forkLabel"
      :disabled="disabled"
      @click="emit('fork')"
    >
      <svg viewBox="64 64 896 896" aria-hidden="true" class="h-[1em] w-[1em] fill-current">
        <path
          d="M752 100c-61.8 0-112 50.2-112 112 0 47.7 29.9 88.5 72 104.6v27.6L512 601.4 312 344.2v-27.6c42.1-16.1 72-56.9 72-104.6 0-61.8-50.2-112-112-112s-112 50.2-112 112c0 50.6 33.8 93.5 80 107.3v34.4c0 9.7 3.3 19.3 9.3 27L476 672.3v33.6c-44.2 15-76 56.9-76 106.1 0 61.8 50.2 112 112 112s112-50.2 112-112c0-49.2-31.8-91-76-106.1v-33.6l226.7-291.6c6-7.7 9.3-17.3 9.3-27v-34.4c46.2-13.8 80-56.7 80-107.3 0-61.8-50.2-112-112-112zM224 212a48.01 48.01 0 0196 0 48.01 48.01 0 01-96 0zm336 600a48.01 48.01 0 01-96 0 48.01 48.01 0 0196 0zm192-552a48.01 48.01 0 010-96 48.01 48.01 0 010 96z"
        />
      </svg>
    </button>
    <button
      v-if="showRevert"
      type="button"
      class="flex h-5 w-5 items-center justify-center border-0 bg-transparent p-0 text-[12px] text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
      :title="revertLabel"
      :aria-label="revertLabel"
      :disabled="disabled"
      @click="emit('revert')"
    >
      <svg viewBox="64 64 896 896" aria-hidden="true" class="h-[1em] w-[1em] fill-current">
        <path
          d="M793 242H366v-74c0-6.7-7.7-10.4-12.9-6.3l-142 112a8 8 0 000 12.6l142 112c5.2 4.1 12.9.4 12.9-6.3v-74h415v470H175c-4.4 0-8 3.6-8 8v60c0 4.4 3.6 8 8 8h618c35.3 0 64-28.7 64-64V306c0-35.3-28.7-64-64-64z"
        />
      </svg>
    </button>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    disabled: boolean;
    forkLabel: string;
    revertLabel: string;
    outside?: boolean;
    showRevert?: boolean;
  }>(),
  { outside: false, showRevert: true },
);
const emit = defineEmits<{
  fork: [];
  revert: [];
}>();
</script>
