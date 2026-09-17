<template>
  <a-modal
    :open="open"
    :footer="null"
    :title="t('agent.client.imagePreviewTitle')"
    @cancel="emit('close')"
  >
    <div v-if="loading" class="py-8 text-center"><LoadingOutlined spin /></div>
    <div v-else-if="error" class="text-red-500">{{ error }}</div>
    <img v-else-if="url" :src="url" class="max-h-[65vh] mx-auto" />
    <div v-if="count > 1" class="mt-3 flex justify-center gap-2">
      <a-button
        size="small"
        :disabled="index === 0"
        @click="emit('select', index - 1)"
        >‹</a-button
      >
      <span>{{ index + 1 }} / {{ count }}</span>
      <a-button
        size="small"
        :disabled="index + 1 >= count"
        @click="emit('select', index + 1)"
        >›</a-button
      >
    </div>
  </a-modal>
</template>

<script setup lang="ts">
import { LoadingOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";

defineProps<{
  open: boolean;
  loading: boolean;
  error: string;
  url: string;
  index: number;
  count: number;
}>();
const emit = defineEmits<{ close: []; select: [index: number] }>();
const { t } = useI18n();
</script>
