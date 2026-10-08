<template>
  <Teleport to="body">
    <div
      ref="previewContainer"
      class="attachment-preview-container"
      @keydown.capture="onKeyDown"
      @error.capture="onImageError"
    >
      <a-image-preview-group
        v-if="previewContainer"
        :preview="{ visible: open, current: 0, onVisibleChange, getContainer: getPreviewContainer }"
      >
        <!-- 4.2.6 没有切图回调；只注册当前图片，附件索引与按需加载由父级管理。 -->
        <a-image
          :key="displayUrl"
          :src="displayUrl"
          :alt="t('agent.client.imagePreviewTitle')"
          :wrapper-style="{ display: 'none' }"
        />
      </a-image-preview-group>
    </div>
  </Teleport>

  <Teleport v-if="open && dialogBody" :to="dialogBody">
    <div
      class="attachment-preview-feedback"
      :style="{ zIndex: token.zIndexPopupBase + 81 }"
    >
      <div v-if="loading" class="attachment-preview-status" role="status">
        <LoadingOutlined spin /> {{ t('common.loading') }}
      </div>
      <div v-else-if="displayError" class="attachment-preview-status" role="alert">
        {{ displayError }}
      </div>
      <div v-if="count > 1" class="attachment-preview-navigation">
        <button
          type="button"
          :disabled="index === 0"
          :aria-label="t('agent.client.imagePreviewPrevious')"
          @click="select(index - 1)"
        >‹</button>
        <span>{{ index + 1 }} / {{ count }}</span>
        <button
          type="button"
          :disabled="index + 1 >= count"
          :aria-label="t('agent.client.imagePreviewNext')"
          @click="select(index + 1)"
        >›</button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { Image as AImage, message, theme } from "ant-design-vue";
import { LoadingOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";

const AImagePreviewGroup = AImage.PreviewGroup;
// 加载/失败时仍给预览组一个有效图片，保留遮罩、工具栏与关闭能力。
const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const props = defineProps<{
  open: boolean;
  loading: boolean;
  error: string;
  url: string;
  index: number;
  count: number;
}>();
const emit = defineEmits<{ close: []; select: [index: number] }>();
const { t } = useI18n();
const { token } = theme.useToken();
const previewContainer = shallowRef<HTMLElement | null>(null);
const dialogBody = shallowRef<HTMLElement | null>(null);
const decodeError = ref(false);
let disposed = false;
const displayError = computed(() => props.error || (decodeError.value ? t("agent.client.imagePreviewLoadFailed") : ""));
const displayUrl = computed(() => props.loading || displayError.value ? EMPTY_IMAGE : props.url || EMPTY_IMAGE);

watch(() => [props.open, props.index, props.url], () => { decodeError.value = false; });

function getPreviewContainer() {
  // 模板在容器 ref 就绪后才挂载 PreviewGroup。
  return previewContainer.value!;
}
watch([() => props.open, previewContainer], async ([open, container], _, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  dialogBody.value = null;
  if (!open || !container) return;

  // 4.2.6 的 Image Preview 未转发 modalRender/wrapProps。升级时应检查这处
  // DOM 适配：导航必须放进 body（sentinel 内），事件只归所属容器处理。
  // 两个 Vue flush 阶段分别覆盖 PreviewGroup 挂载与内部 Portal 的延后挂载。
  for (let phase = 0; phase < 2; phase += 1) {
    await nextTick();
    if (cancelled || disposed) return;
    const body = container.querySelector<HTMLElement>(".ant-image-preview-body");
    if (body) {
      dialogBody.value = body;
      return;
    }
  }
  // 不把导航退回焦点圈外；结构不兼容时明确报错并结束本次预览。
  console.error("[AgentAttachmentPreview] Ant image preview body was not mounted; check the 4.2.6 DOM adapter after upgrading.");
  message.error(t("agent.client.imagePreviewUnavailable"));
  emit("close");
}, { immediate: true, flush: "post" });

function onVisibleChange(visible: boolean) {
  if (!disposed && !visible && props.open) emit("close");
}
function select(index: number) {
  if (!disposed && props.open && index >= 0 && index < props.count && index !== props.index) emit("select", index);
}
function onImageError(event: Event) {
  const image = event.target;
  if (disposed || !props.open || props.loading || props.error || !props.url || !(image instanceof window.HTMLImageElement)) return;
  // 容器捕获同时覆盖隐藏原图和预览图；忽略关闭/切图后旧图片的事件。
  if (image.getAttribute("src") === props.url) decodeError.value = true;
}
function onKeyDown(event: KeyboardEvent) {
  if (disposed || !props.open || event.altKey || event.ctrlKey || event.metaKey || props.count <= 1) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    event.stopPropagation();
    select(props.index + (event.key === "ArrowLeft" ? -1 : 1));
  }
  // Tab/Shift+Tab 与 Escape 交给所属 Ant Dialog 的原生处理。
}
onBeforeUnmount(() => { disposed = true; });
</script>

<style scoped>
.attachment-preview-feedback {
  position: fixed;
  inset: 0;
  pointer-events: none;
  color: white;
}
.attachment-preview-status {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-width: calc(100vw - 48px);
  padding: 12px 20px;
  border-radius: 8px;
  background: rgb(0 0 0 / 65%);
  text-align: center;
  overflow-wrap: anywhere;
}
.attachment-preview-navigation {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgb(0 0 0 / 65%);
  pointer-events: auto;
}
.attachment-preview-navigation button {
  width: 36px;
  height: 32px;
  border: 1px solid rgb(255 255 255 / 50%);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}
.attachment-preview-navigation button:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
</style>
