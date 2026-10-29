<template>
  <div class="h-full min-h-0 flex flex-col items-center justify-center gap-3 overflow-auto p-4" data-editor-media>
    <component
      :is="kind"
      ref="player"
      :src="active ? mediaUrl : undefined"
      :aria-label="title"
      controls
      preload="metadata"
      class="max-w-full max-h-full shrink min-h-0"
      @loadedmetadata="failure = undefined"
      @error="onError"
    />
    <span v-if="failure" class="text-xs text-[color:var(--text-tertiary)]" role="status">
      {{ t(`editor.media.${failure}`) }}
    </span>
    <a :href="downloadUrl" download class="shrink-0 text-xs text-[color:var(--text-secondary)] underline">
      {{ t('editor.media.download') }}
    </a>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref } from "vue";
import { useI18n } from "vue-i18n";
import { getWorkspaceDownloadUrl, getWorkspaceMediaUrl } from "@/shared/api";

const props = defineProps<{ workspaceId: string; path: string; kind: "audio" | "video"; title: string }>();
const { t } = useI18n();
const player = ref<HTMLMediaElement | null>(null);
const active = ref(true);
const failure = ref<"loadFailed" | "decodeFailed">();
const mediaUrl = computed(() => getWorkspaceMediaUrl({ workspaceId: props.workspaceId, path: props.path }));
const downloadUrl = computed(() => getWorkspaceDownloadUrl({ workspaceId: props.workspaceId, path: props.path }));

function onError() {
  if (!active.value) return;
  // HTTP/auth errors can also appear as MEDIA_ERR_SRC_NOT_SUPPORTED (4).
  failure.value = player.value?.error?.code === 3 ? "decodeFailed" : "loadFailed";
}

function releasePlayer() {
  active.value = false;
  const element = player.value;
  if (!element) return;
  element.pause();
  element.removeAttribute("src");
  // Explicitly abort in-flight Range requests and release the browser's media buffer.
  element.load();
}

onBeforeUnmount(releasePlayer);
onDeactivated(releasePlayer);
onActivated(() => {
  failure.value = undefined;
  active.value = true;
});
</script>
