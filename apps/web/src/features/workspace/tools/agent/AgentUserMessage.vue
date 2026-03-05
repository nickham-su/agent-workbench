<template>
  <div
    class="agent-user-message whitespace-pre-wrap break-words pr-24 text-[13px]"
    :class="tone === 'error' ? 'text-red-500' : ''"
  >
    {{ props.text }}
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  text: string;
  tone?: "normal" | "error";
}>();

const tone = props.tone ?? "normal";
</script>
