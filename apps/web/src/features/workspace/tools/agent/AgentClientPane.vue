<template>
  <div class="h-full min-h-0 flex flex-col">
    <header
      class="px-3 py-2 border-b border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] text-[0.9em] text-[color:var(--text-tertiary)]"
      :title="sessionTitleText"
    >
      <div class="flex items-center justify-between gap-2 min-w-0">
        <div class="min-w-0 flex-1 flex items-center gap-2">
          <a-button
            v-if="isSubtaskSession && props.parentSessionId"
            type="link"
            size="small"
            class="!px-0 shrink-0"
            @click="emit('open-parent', props.parentSessionId)"
            >{{ t("agent.client.backToParent") }}</a-button
          >
          <span class="min-w-0 truncate text-[14px] leading-none text-[color:var(--text-secondary)]">
            {{ sessionTitleText }}
          </span>
          <a-tooltip v-if="props.sessionReady" :title="t('agent.actions.setSessionTitle')">
            <a-button
              type="text"
              size="small"
              class="!px-1 shrink-0 !text-[color:var(--text-tertiary)] hover:!text-[color:var(--text-secondary)]"
              :aria-label="t('agent.actions.setSessionTitle')"
              @click.stop="emit('open-title-setting')"
            >
              <template #icon><EditOutlined class="text-[12px]" /></template>
            </a-button>
          </a-tooltip>
          <template v-if="headerTokensText">
            <span class="leading-none whitespace-nowrap">·</span>
            <span data-testid="agent-header-tokens" class="leading-none whitespace-nowrap tabular-nums">
              {{ headerTokensText }}
            </span>
          </template>
          <template v-if="runElapsedText">
            <span class="leading-none whitespace-nowrap">·</span>
            <span data-testid="agent-header-elapsed" class="leading-none whitespace-nowrap tabular-nums">
              {{ runElapsedText }}
            </span>
          </template>
        </div>
        <div v-if="props.sessionReady" class="shrink-0 flex items-center gap-1">
          <span class="leading-none whitespace-nowrap font-mono text-[12px] text-[color:var(--text-tertiary)]">
            {{ props.sessionId }}
          </span>
          <a-button
            size="small"
            type="text"
            class="!px-1 !text-[color:var(--text-tertiary)] hover:!text-[color:var(--text-secondary)]"
            :aria-label="t('agent.client.copySessionId')"
            @click="copySessionId"
          >
            <template #icon><CopyOutlined class="text-[12px]" /></template>
          </a-button>
        </div>
      </div>
    </header>

    <section class="relative flex-1 min-h-0">
      <main
        ref="scrollEl"
        class="h-full min-h-0 overflow-auto p-3 bg-[var(--panel-bg)]"
        :style="{ fontSize: 'var(--agent-font-size, 13px)' }"
        @scroll.passive="onScroll"
      >
        <div
          v-if="conversation.length === 0"
          class="h-full flex flex-col items-center justify-center gap-3 text-[color:var(--text-tertiary)]"
        >
          <div>{{ t("agent.client.welcome") }}</div>
          <a-button
            v-if="props.canChooseSession"
            type="link"
            size="small"
            @click="emit('choose-session')"
            >{{ t("agent.client.chooseSession") }}</a-button
          >
        </div>
        <div v-else class="flex flex-col">
          <article
            v-for="row in conversation"
            :key="row.id"
            class="group relative rounded"
            :class="messageClass(row)"
            :style="messageActionAnchorStyle(row)"
            :data-message-id="row.message.id"
          >
            <AgentMessageActions
              v-if="isMessageActionAnchor(row) && (showFork(row.message) || showRevert(row.message))"
              :disabled="isSessionMessageMutationPending"
              :message-id="row.message.id"
              :copy-message-id-label="t('agent.client.copyMessageId')"
              :time-text="messageTimeText(row.message)"
              :tools-text="messageToolsText(row.message)"
              :fork-label="t('agent.client.fork')"
              :revert-label="t('agent.client.revert')"
              :show-fork="showFork(row.message)"
              :show-revert="showRevert(row.message)"
              :outside="row.message.type === 'user'"
              @copy-message-id="copyMessageId(row.message.id)"
              @fork="onFork(row.message.id)"
              @revert="onRevert(row.message)"
            />
            <AssistantMarkdownMessage
              v-if="
                row.part?.type === 'text' && row.message.type === 'assistant'
              "
              :text="row.part.text"
              :message-id="row.message.id"
              :streaming="row.message.status === 'streaming'"
              :tone="row.message.status === 'failed' ? 'error' : 'normal'"
            />
            <AgentSystemMessage
              v-else-if="
                row.part?.type === 'text' &&
                (row.message.type === 'system' || row.message.type === 'compaction')
              "
              :text="row.part.text"
              :message-id="row.message.id"
              :label="row.message.type === 'compaction' ? t('agent.client.compactionSummary') : undefined"
            />
            <AssistantMarkdownMessage
              v-else-if="row.part?.type === 'reasoning'"
              :text="row.reasoningText"
              :message-id="row.message.id"
              :streaming="row.message.status === 'streaming'"
              class="assistant-reasoning-markdown italic"
              :style="{
                fontSize: 'calc(var(--agent-font-size, 13px) - 3px)',
                color: 'var(--text-tertiary)',
              }"
              section-key="reasoning"
            />
            <AgentUserMessage
              v-else-if="
                row.part?.type === 'text' && row.message.type === 'user'
              "
              :text="row.part.text"
            />
            <button
              v-else-if="row.part?.type === 'image'"
              type="button"
              class="m-0 appearance-none border-0 bg-transparent px-0 py-0.5 text-left text-blue-500 hover:underline cursor-pointer"
              @click="openAttachmentPreview(row.imageParts)"
            >
              {{ t("agent.client.imageCount", { count: row.imageParts.length }) }}
            </button>
            <AgentConversationToolCall
              v-else-if="row.part?.type === 'tool_call'"
              :workspace-id="props.workspaceId"
              :tool-id="props.toolId"
              :session-id="props.sessionId"
              :part="row.part"
              :execution="row.execution"
              :detail="
                row.execution
                  ? detailByExecutionId[row.execution.id]
                  : undefined
              "
              :loading="
                row.execution ? detailLoading.has(row.execution.id) : false
              "
              :todo-collapsed="collapsedTodoPartIds.has(row.part.id)"
              :subtask-agent-labels="props.subtaskAgentLabels"
              :now="now"
              @request-detail="ensureToolDetail"
              @open-subtask="emit('open-subtask', $event)"
              @toggle-todo="toggleTodoCollapse(row.part.id)"
            />
            <div
              v-else-if="row.message.status === 'streaming'"
              class="text-[color:var(--text-tertiary)]"
            >
              <LoadingOutlined spin />
            </div>
          </article>
        </div>
      </main>
      <a-button
        v-if="showScrollToBottom"
        class="absolute bottom-3 right-5"
        shape="circle"
        @click="scrollToBottom(true)"
        ><template #icon><DownOutlined /></template
      ></a-button>
    </section>

    <footer
      v-if="!isSubtaskSession"
      class="relative border-t border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-2"
    >
      <div
        v-if="runState.runNoticeText"
        class="mb-1 text-[0.85em] text-[color:var(--text-tertiary)]"
      >
        {{ runState.runNoticeText }}
      </div>
      <div v-if="pendingImages.length" class="mb-2 flex flex-wrap gap-2">
        <a-tag
          v-for="image in pendingImages"
          :key="image.id"
          closable
          @close="removePendingImage(image.id)"
          ><FileImageOutlined /> {{ image.filename }} ·
          {{ formatPendingAgentImageLabel(image) }}</a-tag
        >
      </div>
      <a-textarea
        ref="inputEl"
        v-model:value="draft"
        :disabled="!hasAvailableAgents || props.sessionModelMutationPending"
        :readonly="sending || props.sessionModelMutationPending"
        :placeholder="inputPlaceholder"
        :style="{ fontSize: 'var(--agent-font-size, 13px)' }"
        :auto-size="{ minRows: 2, maxRows: 6 }"
        @input="onInputChanged"
        @click="syncInputCaret"
        @keyup="syncInputCaret"
        @paste="onImagePaste"
        @keydown="onInputKeydown"
      />
      <div
        v-if="inputCandidates.length"
        class="absolute left-2 right-2 bottom-[calc(100%+2px)] rounded border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] shadow-lg overflow-hidden"
        role="listbox"
        :id="inputCandidateListId"
      >
        <button
          v-for="(item, index) in inputCandidates"
          type="button"
          role="option"
          :id="createInputCandidateDomId(inputCandidateListId, index)"
          :key="item.id"
          class="m-0 block w-full appearance-none border-0 bg-transparent px-3 py-2 text-left text-[color:var(--text-color)] outline-none transition-colors"
          :aria-selected="item.id === selectedCandidateId"
          :class="item.id === selectedCandidateId
            ? 'bg-blue-500/25 font-medium text-blue-100 hover:bg-blue-500/30'
            : 'hover:bg-[var(--hover-bg)]'"
          @mousedown.prevent="pickCandidate(item)"
        >
          <span>{{ item.label }}</span
          ><span
            v-if="item.description"
            class="ml-2 text-[0.85em] text-[color:var(--text-tertiary)]"
            >{{ item.description }}</span
          >
        </button>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <a-select
          :value="effectiveAgentId || undefined"
          class="min-w-32 max-w-52"
          size="small"
          :options="props.agentOptions"
          :disabled="props.sessionModelMutationPending"
          @update:value="
            (value: string | undefined) =>
              emit('update:modelValue', value || null)
          "
        />
        <a-tooltip
          v-if="sessionModelLabel"
          :title="sessionModelLabel"
          placement="top"
          :mouse-enter-delay="0.45"
        >
          <a-button
            size="small"
            type="text"
            class="!px-1 max-w-60 min-w-0"
            :disabled="props.sessionModelMutationPending"
            :aria-label="t('agent.client.modelEditTooltip')"
            @click="requestModelModal"
          >
            <span class="block truncate">{{ sessionModelLabel }}</span>
          </a-button>
        </a-tooltip>
        <div class="flex items-center gap-1">
          <a-tooltip
            :title="t('agent.client.agentEnablementTooltip')"
            placement="top"
            :mouse-enter-delay="0.45"
          >
            <a-button
              size="small"
              type="text"
              class="!px-1"
              :aria-label="t('agent.client.agentEnablementTitle')"
              @click="openAgentEnablement"
              ><template #icon><RobotOutlined /></template></a-button
          ></a-tooltip>
          <a-tooltip
            :title="t('agent.client.contextManagerTooltip')"
            placement="top"
            :mouse-enter-delay="0.45"
          >
            <a-button
              size="small"
              type="text"
              class="!px-1"
              :aria-label="t('agent.client.contextManagerTitle')"
              @click="openContextManager"
              ><template #icon><AppstoreOutlined /></template></a-button
          ></a-tooltip>
        </div>
        <span
          v-if="processingPastedImages"
          class="text-[0.85em] text-[color:var(--text-tertiary)]"
          >{{ t("common.loading") }}</span
        >
        <div class="flex-1" />
        <a-button
          v-if="runState.status === 'running'"
          size="small"
          :loading="cancelling"
          @click="onCancel"
          >{{ t("agent.client.cancel") }}</a-button
        >
      </div>
    </footer>

    <AgentAttachmentPreviewModal
      :open="attachmentPreviewVisible"
      :loading="previewLoading"
      :error="previewError"
      :url="previewUrl"
      :index="previewIndex"
      :count="previewAttachments.length"
      @select="showPreviewAt"
      @close="closeAttachmentPreview"
    />

    <a-modal
      v-model:open="modelModalVisible"
      :title="t('agent.client.modelEditTitle')"
      :confirm-loading="modelSaving"
      @ok="saveModelOverride"
    >
      <a-select
        v-model:value="modelPath"
        class="w-full"
        :options="modelOptions"
        :loading="modelLoading"
      />
      <div v-if="modelError" class="mt-2 text-red-500">{{ modelError }}</div>
      <a-button
        class="mt-3"
        danger
        size="small"
        :disabled="!sessionModelState?.override"
        :loading="modelResetting"
        @click="resetModelOverride"
        >{{ t("agent.client.modelEditReset") }}</a-button
      >
    </a-modal>

    <a-modal
      v-model:open="contextModalVisible"
      :title="t('agent.client.contextManagerTitle')"
      :confirm-loading="contextSaving"
      @ok="saveContextSettings"
    >
      <div v-if="contextLoading" class="py-5 text-center">
        <LoadingOutlined spin />
      </div>
      <div v-else>
        <div v-if="contextError" class="text-red-500">{{ contextError }}</div>
        <div class="mb-2">{{ t("agent.client.contextAgentsGroupTitle") }}</div>
        <a-checkbox-group
          v-model:value="instructionKeys"
          class="flex flex-col gap-1"
          ><a-checkbox
            v-for="item in instructionCandidates"
            :key="instructionKey(item)"
            :value="instructionKey(item)"
            >{{ item.displayPath }}</a-checkbox
          ></a-checkbox-group
        >
        <div class="mt-4 mb-2">
          {{ t("agent.client.contextSkillsGroupTitle") }}
        </div>
        <a-checkbox-group v-model:value="skillKeys" class="flex flex-col gap-1"
          ><a-checkbox
            v-for="item in skillCandidates"
            :key="skillKey(item)"
            :value="skillKey(item)"
            >{{ item.displayName }} · {{ item.topLevelSkillCount }}</a-checkbox
          ></a-checkbox-group
        >
      </div>
    </a-modal>

    <a-modal
      v-model:open="enablementModalVisible"
      :title="t('agent.client.agentEnablementTitle')"
      :confirm-loading="enablementSaving"
      @ok="saveAgentEnablement"
    >
      <div v-if="enablementLoading" class="py-5 text-center">
        <LoadingOutlined spin />
      </div>
      <div v-else>
        <div v-if="enablementError" class="text-red-500">
          {{ enablementError }}
        </div>
        <a-checkbox-group
          v-model:value="enabledAgentIds"
          class="flex flex-col gap-1"
          ><a-checkbox
            v-for="item in enablementCandidates"
            :key="item.id"
            :value="item.id"
            >{{ item.name }}</a-checkbox
          ></a-checkbox-group
        >
      </div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import type {
  AgentImagePart,
  AgentMessage,
  AgentSessionMessageState,
  AgentTimelineToolExecution,
  AgentToolExecution,
} from "@agent-workbench/shared";
import type { AgentSessionAgentModelState } from "@agent-workbench/shared/internal-contracts/agent-api-session";
import {
  AppstoreOutlined,
  CopyOutlined,
  DownOutlined,
  EditOutlined,
  FileImageOutlined,
  LoadingOutlined,
  RobotOutlined,
} from "@ant-design/icons-vue";
import { Modal, message } from "ant-design-vue";
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import AgentAttachmentPreviewModal from "./AgentAttachmentPreviewModal.vue";
import AgentConversationToolCall from "./AgentConversationToolCall.vue";
import AgentMessageActions from "./AgentMessageActions.vue";
import AgentSystemMessage from "./AgentSystemMessage.vue";
import AgentUserMessage from "./AgentUserMessage.vue";
import AssistantMarkdownMessage from "./AssistantMarkdownMessage.vue";
import {
  agentUserMessageDraftText,
  buildConversationParts,
  canForkAgentTimelineMessage,
  canRevertAgentTimelineMessage,
  hasAgentMessageTextPart,
  type ConversationPart,
} from "./agentMessageTimeline";
import {
  applyTimelineResponse,
  advanceAgentRequestScope,
  buildTimelineRequest,
  createAgentRequestScope,
  createAgentTimelineControllerState,
  isCurrentAgentRequestScope,
  type AgentRequestScope,
} from "./agentTimelineController";
import { resolveAgentSlashSendAction } from "./agentSlashPayload";
import {
  createInputCandidateDomId,
  createInputCandidateListId,
  buildPromptCommandMap,
  buildSlashInputCandidates,
  findMentionTarget,
  isSlashMode,
  limitMentionCandidates,
  promptCommandInsertText,
  shouldConvertLeadingIdeographicCommaToSlash,
  type MentionCandidateItem,
} from "./agentInputCandidates";
import {
  AttachmentPreviewCache,
  collectClipboardAgentImageFiles,
  collectPastedAgentImages,
  createAgentMessageFormData,
  createAgentSendAttemptFingerprint,
  formatPendingAgentImageLabel,
  preparePastedAgentImages,
  resolveAgentSendAttempt,
  shouldBlockImageSlashCommand,
  type PendingAgentImage,
  type PendingAgentSendAttempt,
} from "./agentImageAttachments";
import { createAgentClientRequestId } from "./agentClientRequestId";
import {
  copyTextWithExecCommand,
  formatAgentHeaderTokens,
  resolveCycledAgentId,
  shouldRunAgentElapsedTimer,
} from "./agentClientHeader";
import { runAgentSessionMessageMutation } from "./agentMessageMutationAction";
import { formatAgentMessageTimestamp } from "./agentMessageMetadata";
import { runAgentSessionForkAction } from "./agentForkSessionAction";
import {
  createAgentCompactAttemptFingerprint,
  resolveAgentCompactAttempt,
  type PendingAgentCompactAttempt,
  shouldClearPendingAgentCompactAttempt,
} from "./agentCompactAttempt";
import { createAgentMessageMutationState } from "./agentMessageMutationState";
import {
  canRequestSessionModelOpen,
  isSessionModelSendBlocked,
  resolveSessionModelPresentation,
} from "./agentSessionModelPresentation";
import { createAgentTimelineRefreshScheduler } from "./agentTimelineRefreshScheduler";
import { createAgentToolDetailCache } from "./agentToolDetailCache";
import { createAgentPendingRunRegistry } from "./agentPendingRunRegistry";
import { createAgentPendingRunController } from "./agentPendingRunController";
import { registerPendingAgentRun } from "./agentPendingRunRegistration";
import { agentRunTerminalMessageKey, isSilentAgentRunTerminal } from "./agentRunTerminalPresentation";
import { formatElapsedDuration } from "./subtaskRunDisplay";
import { useAgentSessionStatusStore } from "./useAgentSessionStatusStore";
import {
  ApiError,
  cancelAgentSession,
  compactAgentSession,
  detectWorkspaceAgentEnablement,
  detectWorkspaceAgentsInstructions,
  detectWorkspaceExternalSkillRoots,
  forkAgentSession,
  getAgentAttachmentContent,
  getAgentGlobalPromptSettings,
  getAgentProvidersSettings,
  getAgentRunStatus,
  getAgentTimeline,
  getAgentToolExecutionDetail,
  listWorkspaceTopLevelSkills,
  resetAgentSessionModelOverride,
  revertAgentSession,
  sendAgentMessage,
  sendAgentMessageMultipart,
  suggestWorkspaceFilePaths,
  updateAgentSessionModelOverride,
  updateWorkspaceAgentEnablementSettings,
  updateWorkspaceAgentsInstructionsSettings,
  updateWorkspaceExternalSkillRootsSettings,
} from "@/shared/api";
import { getInitialLocale } from "@/shared/i18n/locale";

type AgentOption = {
  value: string;
  label?: string;
  resolvedModel?: {
    providerId: string;
    modelId: string;
    providerName: string;
    modelName: string;
  } | null;
};
type Candidate = {
  id: string;
  label: string;
  description?: string;
  kind: "slash" | "prompt_command" | "skill" | "file";
  command?: any;
  insertText?: string;
};
type Source = { sourceType: "workspace" | "repo"; repoId?: string };
const props = defineProps<{
  workspaceId: string;
  toolId: string;
  sessionId: string;
  sessionKind: "primary" | "subtask";
  sessionTitle?: string;
  parentSessionId?: string | null;
  sessionReady: boolean;
  initialDraft?: string;
  ensureSession?: (sessionId: string) => Promise<string>;
  forkSession?: typeof forkAgentSession;
  canChooseSession?: boolean;
  active: boolean;
  modelValue?: string | null;
  agentOptions: AgentOption[];
  subtaskAgentLabels?: Record<string, string>;
  sessionModelStates: Record<string, AgentSessionAgentModelState>;
  sessionModelStateLoading: boolean;
  sessionModelMutationPending: boolean;
  modelOpenIntent: {
    agentId: string;
    requestId: number;
    ready: boolean;
  } | null;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string | null];
  forked: [sessionId: string];
  "open-subtask": [sessionId: string];
  "open-title-setting": [];
  "open-parent": [sessionId: string];
  "choose-session": [];
  "session-title-sync-needed": [sessionId: string];
  "session-metadata-updated": [session: AgentSessionMessageState];
  "agent-settings-updated": [];
  "request-session-model-open": [
    params: { sessionId: string; agentId: string },
  ];
  "session-model-open-consumed": [
    params: { sessionId: string; requestId: number },
  ];
  "session-model-state-updated": [state: AgentSessionAgentModelState];
  "session-model-mutation-pending": [
    params: { sessionId: string; pending: boolean },
  ];
}>();
const { t } = useI18n();
const statusStore = useAgentSessionStatusStore();
const runState = statusStore.getRunState(props.sessionId);
const isSubtaskSession = computed(() => props.sessionKind === "subtask");
const sessionTitleText = computed(
  () => String(props.sessionTitle || "").trim() || props.sessionId,
);
const hasAvailableAgents = computed(() => props.agentOptions.length > 0);
const effectiveAgentId = computed(() =>
  props.agentOptions.some((item) => item.value === props.modelValue)
    ? props.modelValue || ""
    : props.agentOptions[0]?.value || "",
);
const sessionModelState = computed(
  () => props.sessionModelStates[effectiveAgentId.value] ?? null,
);
const sessionModelLabel = computed(
  () =>
    resolveSessionModelPresentation(
      sessionModelState.value,
      props.sessionModelStateLoading,
      props.agentOptions.find((item) => item.value === effectiveAgentId.value)
        ?.resolvedModel
        ? `${props.agentOptions.find((item) => item.value === effectiveAgentId.value)?.resolvedModel?.providerName} / ${props.agentOptions.find((item) => item.value === effectiveAgentId.value)?.resolvedModel?.modelName}`
        : null,
    ).modelLabel || "",
);
const inputPlaceholder = computed(() => {
  if (!hasAvailableAgents.value) {
    return t("agent.client.inputPlaceholderNoAgent");
  }
  return runState.value.status === "running"
    ? t("agent.client.inputPlaceholderRunning")
    : t("agent.client.inputPlaceholderIdle");
});
const draft = ref("");
const sending = ref(false);
const cancelling = ref(false);
const pendingImages = ref<PendingAgentImage[]>([]);
const processingPastedImages = ref(0);
const pendingAttempt = ref<PendingAgentSendAttempt | null>(null);
const pendingCompactAttempt = ref<PendingAgentCompactAttempt | null>(null);
const scrollEl = ref<HTMLElement | null>(null);
const inputEl = ref<any>(null);
let savedScrollPosition: { top: number; wasAtBottom: boolean } | null = null;
// 失活、会话切换和用户滚动都可以发生在等待下一帧恢复期间；代次用于让旧恢复任务失效。
let scrollRestoreGeneration = 0;
let scrollRestorePending = false;
let scrollRestoreIntentHandler: EventListener | null = null;
const stickToBottom = ref(true);
const distanceToBottom = ref(0);
const timelineState = ref(createAgentTimelineControllerState());
const revision = computed(() => timelineState.value.revision);
const messages = computed(() => timelineState.value.messages);
const toolExecutions = computed(() => timelineState.value.toolExecutions);
const detailByExecutionId = ref<Record<string, AgentToolExecution>>({});
const detailLoading = ref(new Set<string>());
const collapsedTodoPartIds = ref(new Set<string>());
let refreshTimer: number | null = null;
let timelineRequestSequence = 0;
let disposed = false;
let requestScope = createAgentRequestScope(props.workspaceId, props.sessionId);
let loadingPreviousPageScope: AgentRequestScope | null = null;
const detailLoadingScopeByExecutionId = new Map<string, AgentRequestScope>();
let timelineRefreshScheduler = createAgentTimelineRefreshScheduler();
const detailCache = createAgentToolDetailCache();
const messageMutationState = createAgentMessageMutationState();
const pendingRunRegistry = createAgentPendingRunRegistry(
  typeof window === "undefined" ? null : window.sessionStorage,
);
const pendingRunController = createAgentPendingRunController({
  registry: pendingRunRegistry,
  fetchRun: ({ workspaceId, sessionId, runId }) => getAgentRunStatus({ workspaceId, sessionId, runId }),
  onTerminal: (run) => {
    if (!isSilentAgentRunTerminal(run)) {
      const text = t(agentRunTerminalMessageKey(run.code));
      if (run.status === "completed") message.success(text);
      else if (run.status === "cancelled") message.warning(text);
      else message.error(text);
    }
    if (!disposed && props.active && props.sessionReady) void refreshTimeline(false).catch(() => undefined);
  },
  onStale: () => {
    if (!disposed && props.active && props.sessionReady) {
      message.warning(t("agent.runTerminal.run_status_unavailable"));
    }
  },
});
let previousRunStatus = runState.value.status;
const isSessionMessageMutationPending = computed(() => messageMutationState.isPending(props.sessionId));
const conversation = computed(() =>
  buildConversationParts({
    revision: revision.value,
    messages: messages.value,
    toolExecutions: toolExecutions.value,
  }).map((row) => ({
    ...row,
    id: `${row.message.id}:${row.part?.id ?? "message"}`,
  })),
);
const showScrollToBottom = computed(
  () => conversation.value.length > 0 && distanceToBottom.value > 240,
);
const todoPartIds = computed(() =>
  conversation.value
    .filter((row) => row.part?.type === "tool_call" && row.part.toolName === "todolist")
    .map((row) => row.part!.id),
);
function toggleTodoCollapse(partId: string) {
  const next = new Set(collapsedTodoPartIds.value);
  if (next.has(partId)) next.delete(partId);
  else next.add(partId);
  collapsedTodoPartIds.value = next;
}
const now = ref(Date.now());
let elapsedTimer: number | null = null;
const runElapsedText = computed(() => {
  if (runState.value.status === "running") {
    const startedAt = runState.value.activeRunStartedAt;
    return typeof startedAt === "number" && Number.isFinite(startedAt)
      ? formatElapsedDuration(Math.max(0, now.value - startedAt))
      : "";
  }
  const durationMs = runState.value.lastRunDurationMs;
  return typeof durationMs === "number" && Number.isFinite(durationMs)
    ? formatElapsedDuration(Math.max(0, durationMs))
    : "";
});
function messageTimeText(targetMessage: AgentMessage) {
  return formatAgentMessageTimestamp(targetMessage.createdAt, now.value);
}
function messageToolsText(targetMessage: AgentMessage) {
  if (targetMessage.type !== "assistant") return "";
  const counts = new Map<string, number>();
  for (const part of [...targetMessage.parts].sort((left, right) => left.position - right.position)) {
    if (part.type !== "tool_call") continue;
    counts.set(part.toolName, (counts.get(part.toolName) ?? 0) + 1);
  }
  return [...counts]
    .map(([toolName, count]) => count > 1 ? `${toolName} ×${count}` : toolName)
    .join(", ");
}
const headerTokensText = computed(() => formatAgentHeaderTokens(
  runState.value.lastResponseTotalTokens,
  runState.value.contextTokenRatio,
));
function messageClass(row: ConversationPart) {
  if (row.part?.type === "image") return "px-2 py-0";

  const assistantWithoutText = row.message.type === "assistant" && !hasAgentMessageTextPart(row.message);
  return row.message.type === "user"
    ? "border border-blue-500/60 bg-blue-500/20 p-2"
    : row.part?.type === "tool_call"
      ? row.part.toolName === "todolist" || row.part.toolName === "subtask"
        ? "p-0"
        : (row.part.toolName === "write" ||
            row.part.toolName === "apply_patch") &&
          row.execution?.status === "completed"
          ? "px-2 py-0 transition-colors duration-100 hover:bg-[var(--hover-bg)]"
          : "px-2 py-0"
      : row.message.type === "system"
        ? "p-2 bg-[var(--panel-bg)]"
        : row.message.type === "compaction"
          ? "py-2"
          : assistantWithoutText
            ? "px-2 py-0"
            : "p-2";
}
function isMessageActionAnchor(row: ConversationPart) {
  return row.isFirstRowForMessage;
}
function messageActionAnchorStyle(row: ConversationPart) {
  if (
    isMessageActionAnchor(row) &&
    row.message.type === "assistant" &&
    row.part === null &&
    showFork(row.message)
  ) {
    return { minHeight: "1.75rem" };
  }
  return undefined;
}
function showFork(targetMessage: AgentMessage) {
  return !isSubtaskSession.value && canForkAgentTimelineMessage(targetMessage);
}
function showRevert(targetMessage: AgentMessage) {
  return !isSubtaskSession.value && canRevertAgentTimelineMessage(targetMessage);
}

function clearRefreshTimer() {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = null;
}
function scheduleRefresh() {
  clearRefreshTimer();
  const pending =
    messages.value.some((item) => item.status === "streaming") ||
    toolExecutions.value.some(
      (item) => item.status === "queued" || item.status === "running",
    );
  if (
    props.active &&
    props.sessionReady &&
    (pending || runState.value.status === "running")
  )
    refreshTimer = window.setTimeout(() => void refreshTimeline(false).catch(() => undefined), 800);
}
async function loadTimeline(
  mode: "snapshot" | "delta" | "before",
  epoch: number,
  signal: AbortSignal,
) {
  if (
    disposed ||
    !props.sessionReady ||
    (mode === "before" &&
      (!timelineState.value.hasMore ||
        !timelineState.value.nextBeforeMessageId))
  )
    return mode === "before" ? { paginationExhausted: true } : undefined;
  const scope = requestScope;
  const sequence = ++timelineRequestSequence;
  const anchorElement =
    mode === "before"
      ? (scrollEl.value?.querySelector("article") as HTMLElement | null)
      : null;
  const anchor = anchorElement?.getBoundingClientRect().top ?? null;
  try {
    const response = await getAgentTimeline(
      scope.sessionId,
      buildTimelineRequest(timelineState.value, scope.workspaceId, mode),
      { signal },
    );
    if (
      disposed ||
      !isCurrentAgentRequestScope(requestScope, scope) ||
      timelineRefreshScheduler.currentEpoch() !== epoch
    )
      return;
    const result = applyTimelineResponse(
      timelineState.value,
      response,
      mode,
      sequence,
    );
    if (result.state === timelineState.value) return;
    timelineState.value = result.state;
    emit("session-metadata-updated", response.session);
    const invalidatedDetailIds = detailCache.syncTimeline(
      result.state.toolExecutions,
    );
    if (invalidatedDetailIds.size) {
      const next = { ...detailByExecutionId.value };
      for (const id of invalidatedDetailIds) delete next[id];
      detailByExecutionId.value = next;
    }
    await nextTick();
    if (mode === "before" && anchor !== null && anchorElement?.isConnected) {
      scrollEl.value!.scrollTop +=
        anchorElement.getBoundingClientRect().top - anchor;
    } else if (
      mode === "snapshot" ||
      response.timelineReset ||
      stickToBottom.value
    )
      scrollToBottom(true);
    return mode === "before"
      ? {
          paginationExhausted:
            !result.state.hasMore || !result.state.nextBeforeMessageId,
        }
      : undefined;
  } catch (error) {
    if (
      mode === "before" &&
      error instanceof ApiError &&
      (error.status === 404 || error.code === "TIMELINE_CURSOR_NOT_FOUND")
    ) {
      return { requestSnapshot: true };
    }
    if (!signal.aborted && isCurrentAgentRequestScope(requestScope, scope)) {
      message.error(error instanceof Error ? error.message : String(error));
    }
    throw error;
  } finally {
    if (isCurrentAgentRequestScope(requestScope, scope)) scheduleRefresh();
  }
}
async function refreshTimeline(forceFull: boolean) {
  const mode = forceFull || revision.value === 0 ? "snapshot" : "delta";
  if (!disposed) await timelineRefreshScheduler.request(mode, loadTimeline);
}

async function refreshStructuralTimeline() {
  if (!disposed) await timelineRefreshScheduler.requestStructuralSnapshot(loadTimeline);
}
async function loadPreviousTimelinePage() {
  await timelineRefreshScheduler.request("before", loadTimeline);
}
function invalidateTimelineForStructuralMutation() {
  timelineRefreshScheduler.invalidate();
  timelineRequestSequence += 1;
}
async function ensureToolDetail(executionId: string) {
  if (detailByExecutionId.value[executionId]) return;
  if (detailLoading.value.has(executionId)) return;
  const scope = requestScope;
  const token = detailCache.begin(executionId);
  if (!token) return;
  detailLoadingScopeByExecutionId.set(executionId, scope);
  detailLoading.value = new Set(detailLoading.value).add(executionId);
  try {
    const result = await getAgentToolExecutionDetail(
      scope.sessionId,
      executionId,
      scope.workspaceId,
    );
    if (
      disposed ||
      !isCurrentAgentRequestScope(requestScope, scope) ||
      !detailCache.accepts(token, result)
    )
      return;
    detailByExecutionId.value = {
      ...detailByExecutionId.value,
      [executionId]: result,
    };
  } catch (error) {
    if (isCurrentAgentRequestScope(requestScope, scope)) {
      message.error(error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (
      isCurrentAgentRequestScope(requestScope, scope) &&
      detailLoadingScopeByExecutionId.get(executionId) === scope
    ) {
      detailLoadingScopeByExecutionId.delete(executionId);
      const next = new Set(detailLoading.value);
      next.delete(executionId);
      detailLoading.value = next;
    }
  }
}
function maxScrollTop(el: HTMLElement) {
  return Math.max(0, el.scrollHeight - el.clientHeight);
}
function isScrolledToBottom(el: HTMLElement) {
  // 浏览器布局可产生小数 scrollTop；仅允许极小误差，不能复用 120px 的自动跟随阈值。
  return Math.abs(maxScrollTop(el) - el.scrollTop) <= 1;
}
function syncScrollState(el: HTMLElement) {
  distanceToBottom.value = Math.max(
    0,
    maxScrollTop(el) - el.scrollTop,
  );
  stickToBottom.value = distanceToBottom.value <= 120;
}
function stopScrollRestoreIntentListener() {
  const handler = scrollRestoreIntentHandler;
  if (!handler) return;
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    window.removeEventListener(type, handler, true);
  }
  scrollRestoreIntentHandler = null;
}
function cancelPendingScrollRestore() {
  scrollRestoreGeneration += 1;
  scrollRestorePending = false;
  savedScrollPosition = null;
  stopScrollRestoreIntentListener();
}
function listenForScrollRestoreIntent() {
  stopScrollRestoreIntentListener();
  const handler: EventListener = () => cancelPendingScrollRestore();
  scrollRestoreIntentHandler = handler;
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
    window.addEventListener(type, handler, { capture: true, passive: true });
  }
}
function onScroll() {
  const el = scrollEl.value;
  if (!el) return;
  syncScrollState(el);
  // KeepAlive 重挂载期间浏览器可能短暂报告 scrollTop=0；这不是用户抵达顶部，不能加载历史分页。
  if (scrollRestorePending) return;
  if (el.scrollTop < 100 && loadingPreviousPageScope !== requestScope) {
    const scope = requestScope;
    loadingPreviousPageScope = scope;
    void loadPreviousTimelinePage().finally(() => {
      if (
        isCurrentAgentRequestScope(requestScope, scope) &&
        loadingPreviousPageScope === scope
      ) {
        loadingPreviousPageScope = null;
      }
    }).catch(() => undefined);
  }
}
function scrollToBottom(force = false) {
  const el = scrollEl.value;
  if (!el || (!force && !stickToBottom.value)) return;
  el.scrollTop = maxScrollTop(el);
  distanceToBottom.value = 0;
  stickToBottom.value = true;
}
function saveScrollPosition() {
  const el = scrollEl.value;
  if (!el) return;
  cancelPendingScrollRestore();
  syncScrollState(el);
  savedScrollPosition = {
    top: el.scrollTop,
    wasAtBottom: isScrolledToBottom(el),
  };
}
async function restoreScrollPosition() {
  const saved = savedScrollPosition;
  if (!saved) return;
  const generation = ++scrollRestoreGeneration;
  scrollRestorePending = true;
  listenForScrollRestoreIntent();

  // KeepAlive 先把 DOM 移回可见树，再由 Tabs 和消息异步更新完成布局。
  // 等到下一帧再写 scrollTop，避免被重新挂载/布局过程重置。
  await nextTick();
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  if (
    disposed ||
    generation !== scrollRestoreGeneration ||
    saved !== savedScrollPosition
  ) {
    if (generation === scrollRestoreGeneration) {
      scrollRestorePending = false;
      stopScrollRestoreIntentListener();
    }
    return;
  }

  const el = scrollEl.value;
  if (!el) {
    scrollRestorePending = false;
    stopScrollRestoreIntentListener();
    return;
  }
  if (saved.wasAtBottom) {
    scrollToBottom(true);
  } else {
    el.scrollTop = saved.top;
    syncScrollState(el);
  }
  savedScrollPosition = null;
  scrollRestorePending = false;
  stopScrollRestoreIntentListener();
}
async function onFork(messageId: string) {
  await runAgentSessionMessageMutation({
    state: messageMutationState,
    sessionId: props.sessionId,
    mutate: async () => {
      await runAgentSessionForkAction({
        sourceSessionId: props.sessionId,
        sourceMessageId: messageId,
        fork: props.forkSession ?? forkAgentSession,
        onForked: (sessionId) => emit("forked", sessionId),
      });
    },
    onError: (error) => message.error(error instanceof Error ? error.message : String(error)),
  });
}
function onRevert(targetMessage: AgentMessage) {
  const revertDraft = agentUserMessageDraftText(targetMessage);
  if (revertDraft === null) return;
  Modal.confirm({
    title: t("agent.client.revertConfirmTitle"),
    content: t("agent.client.revertConfirmContent"),
    okText: t("agent.client.revert"),
    cancelText: t("common.cancel"),
    async onOk() {
      const reverted = await runAgentSessionMessageMutation({
        state: messageMutationState,
        sessionId: props.sessionId,
        mutate: async () => {
          await revertAgentSession(props.sessionId, {
            workspaceId: props.workspaceId,
            messageId: targetMessage.id,
          });
        },
        onError: (error) => message.error(error instanceof Error ? error.message : String(error)),
      });
      if (!reverted) return;
      draft.value = revertDraft;
      pendingImages.value = [];
      pendingAttempt.value = null;
      selectedCandidateId.value = "";
      caret.value = revertDraft.length;
      message.success(t("agent.client.reverted"));
      invalidateTimelineForStructuralMutation();
      await nextTick();
      const input = inputEl.value?.resizableTextArea?.textArea as HTMLTextAreaElement | undefined;
      input?.focus();
      input?.setSelectionRange(revertDraft.length, revertDraft.length);
      await refreshStructuralTimeline().catch(() => undefined);
    },
  });
}
async function onCancel() {
  cancelling.value = true;
  try {
    await cancelAgentSession(props.sessionId, {
      workspaceId: props.workspaceId,
    });
    await refreshTimeline(false);
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    cancelling.value = false;
  }
}

const slashCommands = [
  {
    name: "compact",
    usage: "/compact",
    summaryKey: "agent.client.compact",
    strictOnly: true,
    action: "compact" as const,
  },
];
const promptItems = ref<any[]>([]);
const promptSettingsLoaded = ref(false);
const mentionCandidates = ref<MentionCandidateItem[]>([]);
const selectedCandidateId = ref("");
const caret = ref(0);
const inputCandidateListId = createInputCandidateListId(props.sessionId);
let mentionTimer: number | null = null;
const promptCommandMap = computed(() =>
  buildPromptCommandMap(promptItems.value, slashCommands),
);
const slashMap = new Map(slashCommands.map((item) => [item.name, item]));
const inputCandidates = computed<Candidate[]>(() => {
  const text = draft.value;
  if (isSlashMode(text))
    return buildSlashInputCandidates({
      commands: slashCommands,
      promptCommands: promptCommandMap.value,
      query: text.trimStart().slice(1).toLowerCase(),
    }) as Candidate[];
  const target = findMentionTarget(text, caret.value);
  return target ? mentionCandidates.value : [];
});
watch(
  inputCandidates,
  (items) => {
    if (!items.length) {
      selectedCandidateId.value = "";
      return;
    }
    if (!items.some((item) => item.id === selectedCandidateId.value))
      selectedCandidateId.value = items[0]?.id || "";
  },
  { immediate: true },
);
function syncInputCaret() {
  const raw = inputEl.value?.resizableTextArea?.textArea as
    HTMLTextAreaElement | undefined;
  caret.value = raw?.selectionStart ?? draft.value.length;
}
function onInputChanged(event: Event) {
  const next = (event.target as HTMLTextAreaElement).value;
  if (shouldConvertLeadingIdeographicCommaToSlash(draft.value, next))
    draft.value = `/${next.slice(1)}`;
  syncInputCaret();
  void scheduleMentionRefresh();
}
async function scheduleMentionRefresh() {
  if (mentionTimer !== null) window.clearTimeout(mentionTimer);
  mentionTimer = window.setTimeout(() => void refreshMentionCandidates(), 120);
}
async function refreshMentionCandidates() {
  const target = findMentionTarget(draft.value, caret.value);
  if (!target || isSlashMode(draft.value)) {
    mentionCandidates.value = [];
    return;
  }
  try {
    const [skills, files] = await Promise.all([
      listWorkspaceTopLevelSkills(props.workspaceId),
      suggestWorkspaceFilePaths({
        workspaceId: props.workspaceId,
        query: target.query,
        limit: 10,
      }),
    ]);
    const skillRows: MentionCandidateItem[] = skills.items
      .filter(
        (item) =>
          !target.query ||
          `${item.id} ${item.name} ${item.description}`
            .toLowerCase()
            .includes(target.query.toLowerCase()),
      )
      .map((item) => ({
        id: `skill:${item.id}`,
        kind: "skill",
        label: `skill:${item.id}`,
        description: [item.name, item.description].filter(Boolean).join(" · "),
        insertText: `skill:${item.id}`,
      }));
    const fileRows: MentionCandidateItem[] = files.items.map((path) => ({
      id: `file:${path}`,
      kind: "file",
      label: path,
      insertText: path,
    }));
    mentionCandidates.value = limitMentionCandidates(
      [...skillRows, ...fileRows],
      10,
    );
    selectedCandidateId.value = mentionCandidates.value[0]?.id || "";
  } catch {
    mentionCandidates.value = [];
  }
}
function pickCandidate(item: Candidate) {
  if (item.kind === "slash") {
    draft.value = item.command?.usage || "/compact";
  } else if (item.kind === "prompt_command") {
    const prompt = promptCommandMap.value.get(item.command || "");
    if (prompt)
      draft.value = promptCommandInsertText(prompt, item.command || "");
  } else {
    const target = findMentionTarget(draft.value, caret.value);
    if (target)
      draft.value = `${draft.value.slice(0, target.replaceFrom)}@${item.insertText}${draft.value.slice(target.replaceTo)}`;
  }
  selectedCandidateId.value = "";
  mentionCandidates.value = [];
  nextTick(syncInputCaret);
}
function onCycleAgent(step: 1 | -1) {
  const nextId = resolveCycledAgentId(props.agentOptions, effectiveAgentId.value, step);
  if (nextId) emit("update:modelValue", nextId);
}
function onInputKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (
    inputCandidates.value.length &&
    (event.key === "ArrowDown" || event.key === "ArrowUp")
  ) {
    event.preventDefault();
    const items = inputCandidates.value;
    const index = Math.max(
      0,
      items.findIndex((item) => item.id === selectedCandidateId.value),
    );
    selectedCandidateId.value =
      items[
        (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
          items.length
      ]?.id || "";
    return;
  }
  if (
    inputCandidates.value.length &&
    (event.key === "Enter" || event.key === "Tab")
  ) {
    event.preventDefault();
    const item =
      inputCandidates.value.find(
        (candidate) => candidate.id === selectedCandidateId.value,
      ) || inputCandidates.value[0];
    if (item) pickCandidate(item);
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    onCycleAgent(event.shiftKey ? -1 : 1);
    return;
  }
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  ) {
    event.preventDefault();
    void onSend();
    return;
  }
  if (event.key === "Escape" && runState.value.status === "running") {
    event.preventDefault();
    void onCancel();
  }
}
async function refreshPromptItems() {
  try {
    promptItems.value = (await getAgentGlobalPromptSettings()).items || [];
    promptSettingsLoaded.value = true;
  } catch {
    promptItems.value = [];
  }
}
async function onImagePaste(event: ClipboardEvent) {
  const files = collectClipboardAgentImageFiles({
    items: event.clipboardData?.items,
    files: event.clipboardData?.files,
  });
  if (!files.some((file) => file.type.startsWith("image/"))) return;
  const hasText = Array.from(event.clipboardData?.types || []).includes(
    "text/plain",
  );
  if (!hasText) event.preventDefault();
  processingPastedImages.value += 1;
  try {
    const result = collectPastedAgentImages({
      files: await preparePastedAgentImages(files),
      existing: pendingImages.value,
      hasText,
      makeId: () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    pendingImages.value = [...pendingImages.value, ...result.accepted];
    if (result.rejected)
      message.warning(
        t(
          `agent.client.imagePaste${result.rejected[0].toUpperCase()}${result.rejected.slice(1)}`,
        ),
      );
  } finally {
    processingPastedImages.value -= 1;
  }
}
function removePendingImage(id: string) {
  pendingImages.value = pendingImages.value.filter((image) => image.id !== id);
}
async function onSend() {
  if (
    !hasAvailableAgents.value ||
    isSubtaskSession.value ||
    sending.value ||
    processingPastedImages.value ||
    isSessionModelSendBlocked({
      mutationPending: props.sessionModelMutationPending,
    })
  )
    return;
  const text = draft.value.trim();
  if (!text && pendingImages.value.length === 0) return;
  if (isSlashMode(text) && !promptSettingsLoaded.value)
    await refreshPromptItems();
  const action = resolveAgentSlashSendAction({
    text,
    promptCommands: promptCommandMap.value,
  });
  if (
    action.kind === "compact" &&
    shouldBlockImageSlashCommand("compact", pendingImages.value.length)
  ) {
    message.warning(t("agent.client.imageSlashCommandBlocked"));
    return;
  }
  sending.value = true;
  try {
    const ensuredId = props.ensureSession
      ? await props.ensureSession(props.sessionId)
      : props.sessionId;
    if (action.kind === "compact") {
      const fingerprint = createAgentCompactAttemptFingerprint({
        sessionId: ensuredId,
        workspaceId: props.workspaceId,
        agentId: effectiveAgentId.value || undefined,
        locale: getInitialLocale(),
      });
      const attempt = resolveAgentCompactAttempt({
        attempt: pendingCompactAttempt.value,
        fingerprint,
        makeClientRequestId: createAgentClientRequestId,
      });
      pendingCompactAttempt.value = attempt;
      const result = await compactAgentSession(ensuredId, {
        workspaceId: props.workspaceId,
        clientRequestId: attempt.clientRequestId,
        agentId: effectiveAgentId.value || undefined,
        uiLocale: getInitialLocale(),
      });
      draft.value = "";
      pendingCompactAttempt.value = null;
      registerPendingAgentRun(
        pendingRunController,
        { workspaceId: props.workspaceId, sessionId: ensuredId, runKind: "manual_compaction", runId: result.runId },
        statusStore,
      );
      void pendingRunController.pollNow();
    } else {
      const sendText = action.text;
      const fingerprint = createAgentSendAttemptFingerprint({
        draft: sendText,
        images: pendingImages.value,
      });
      const attempt = resolveAgentSendAttempt({
        attempt: pendingAttempt.value,
        fingerprint,
        makeClientRequestId: createAgentClientRequestId,
      });
      pendingAttempt.value = attempt;
      const payload = {
        workspaceId: props.workspaceId,
        clientRequestId: attempt.clientRequestId,
        agentId: effectiveAgentId.value || undefined,
        uiLocale: getInitialLocale(),
        ...(sendText ? { text: sendText } : {}),
      };
      const result = pendingImages.value.length
        ? await sendAgentMessageMultipart(
          ensuredId,
          createAgentMessageFormData(payload, pendingImages.value),
        )
        : await sendAgentMessage(
          ensuredId,
          payload as {
            workspaceId: string;
            clientRequestId: string;
            agentId?: string;
            uiLocale?: "zh-CN" | "en-US";
            text: string;
          },
        );
      registerPendingAgentRun(
        pendingRunController,
        { workspaceId: props.workspaceId, sessionId: ensuredId, runKind: "user", runId: result.runId },
        statusStore,
      );
      void pendingRunController.pollNow();
      draft.value = "";
      pendingImages.value = [];
      pendingAttempt.value = null;
    }
    if (action.kind === "compact") invalidateTimelineForStructuralMutation();
    await (action.kind === "compact" ? refreshStructuralTimeline() : refreshTimeline(false));
    scrollToBottom(true);
  } catch (error) {
    if (action.kind === "compact" && shouldClearPendingAgentCompactAttempt(error)) pendingCompactAttempt.value = null;
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    sending.value = false;
  }
}

const attachmentPreviewVisible = ref(false);
type AttachmentPreviewPart = Pick<AgentImagePart, "attachmentId" | "filename" | "mediaType">;
const previewAttachments = ref<AttachmentPreviewPart[]>([]);
const previewIndex = ref(0);
const previewUrl = ref("");
const previewLoading = ref(false);
const previewError = ref("");
const previewCache = new AttachmentPreviewCache();
let previewGeneration = 0;
async function showPreviewAt(index: number) {
  const attachment = previewAttachments.value[index];
  if (!attachment) return;
  const generation = ++previewGeneration;
  previewIndex.value = index;
  previewLoading.value = true;
  previewError.value = "";
  try {
    const url = await previewCache.get(
      attachment.attachmentId,
      (id) => getAgentAttachmentContent(props.sessionId, id, props.workspaceId),
      () => generation === previewGeneration && attachmentPreviewVisible.value,
    );
    if (generation === previewGeneration && url) previewUrl.value = url;
  } catch {
    if (generation === previewGeneration)
      previewError.value = t("agent.client.imagePreviewLoadFailed");
  } finally {
    if (generation === previewGeneration) previewLoading.value = false;
  }
}
function openAttachmentPreview(attachments: AttachmentPreviewPart[]) {
  if (!attachments.length) return;
  previewCache.clear();
  previewAttachments.value = attachments;
  previewIndex.value = 0;
  previewUrl.value = "";
  attachmentPreviewVisible.value = true;
  void showPreviewAt(0);
}
function closeAttachmentPreview() {
  previewGeneration += 1;
  attachmentPreviewVisible.value = false;
  previewAttachments.value = [];
  previewUrl.value = "";
  previewCache.clear();
}

async function copyTextWithFeedback(content: string, copiedMessage: string) {
  const normalizedContent = content.trim();
  if (!normalizedContent) return;
  try {
    if (typeof navigator.clipboard?.writeText === "function") {
      await navigator.clipboard.writeText(normalizedContent);
      message.success(copiedMessage);
      return;
    }
  } catch {
    // Clipboard API 不可用时继续使用兼容回退。
  }
  try {
    if (!copyTextWithExecCommand(normalizedContent)) throw new Error("copy command failed");
    message.success(copiedMessage);
  } catch (error) {
    message.error(
      t("common.copyFailed", {
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

async function copySessionId() {
  await copyTextWithFeedback(props.sessionId, t("agent.client.sessionIdCopied"));
}

async function copyMessageId(messageId: string) {
  await copyTextWithFeedback(messageId, t("agent.client.messageIdCopied"));
}

const modelModalVisible = ref(false);
const modelLoading = ref(false);
const modelSaving = ref(false);
const modelResetting = ref(false);
const modelError = ref("");
const modelPath = ref("");
const modelOptions = ref<Array<{ value: string; label: string }>>([]);
function requestModelModal() {
  const agentId = String(effectiveAgentId.value || "").trim();
  if (
    !canRequestSessionModelOpen({
      hasAvailableAgents: hasAvailableAgents.value,
      isSubtaskSession: isSubtaskSession.value,
      mutationPending: props.sessionModelMutationPending,
      agentId,
    })
  )
    return;
  emit("request-session-model-open", { sessionId: props.sessionId, agentId });
}
async function openModelModal() {
  if (
    !canRequestSessionModelOpen({
      hasAvailableAgents: !!effectiveAgentId.value,
      isSubtaskSession: isSubtaskSession.value,
      mutationPending: props.sessionModelMutationPending,
      agentId: effectiveAgentId.value,
    })
  )
    return;
  modelModalVisible.value = true;
  modelLoading.value = true;
  modelError.value = "";
  try {
    const settings = await getAgentProvidersSettings();
    modelOptions.value = settings.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        value: `${provider.id}\u0000${model.id}`,
        label: `${provider.name} / ${model.name}`,
      })),
    );
    const effective = sessionModelState.value?.effectiveModel;
    modelPath.value = effective
      ? `${effective.providerId}\u0000${effective.modelId}`
      : "";
  } catch (error) {
    modelError.value = error instanceof Error ? error.message : String(error);
  } finally {
    modelLoading.value = false;
  }
}
async function saveModelOverride() {
  const [providerId, modelId] = modelPath.value.split("\u0000");
  if (!providerId || !modelId || !effectiveAgentId.value) return;
  modelSaving.value = true;
  emit("session-model-mutation-pending", {
    sessionId: props.sessionId,
    pending: true,
  });
  try {
    emit(
      "session-model-state-updated",
      await updateAgentSessionModelOverride(
        props.sessionId,
        effectiveAgentId.value,
        { workspaceId: props.workspaceId, providerId, modelId },
      ),
    );
    modelModalVisible.value = false;
  } catch (error) {
    modelError.value = error instanceof Error ? error.message : String(error);
  } finally {
    modelSaving.value = false;
    emit("session-model-mutation-pending", {
      sessionId: props.sessionId,
      pending: false,
    });
  }
}
async function resetModelOverride() {
  if (!effectiveAgentId.value) return;
  modelResetting.value = true;
  emit("session-model-mutation-pending", {
    sessionId: props.sessionId,
    pending: true,
  });
  try {
    emit(
      "session-model-state-updated",
      await resetAgentSessionModelOverride(
        props.sessionId,
        effectiveAgentId.value,
        props.workspaceId,
      ),
    );
  } catch (error) {
    modelError.value = error instanceof Error ? error.message : String(error);
  } finally {
    modelResetting.value = false;
    emit("session-model-mutation-pending", {
      sessionId: props.sessionId,
      pending: false,
    });
  }
}

const contextModalVisible = ref(false);
const contextLoading = ref(false);
const contextSaving = ref(false);
const contextError = ref("");
const instructionCandidates = ref<
  Array<Source & { displayPath: string; enabled: boolean }>
>([]);
const skillCandidates = ref<
  Array<
    Source & {
      rootDir: string;
      displayName: string;
      topLevelSkillCount: number;
      enabled: boolean;
    }
  >
>([]);
const instructionKeys = ref<string[]>([]);
const skillKeys = ref<string[]>([]);
const instructionKey = (item: Source) =>
  item.sourceType === "workspace"
    ? "workspace"
    : `repo\u0000${item.repoId || ""}`;
const skillKey = (item: Source & { rootDir: string }) =>
  `${instructionKey(item)}\u0000${item.rootDir}`;
async function openContextManager() {
  contextModalVisible.value = true;
  contextLoading.value = true;
  contextError.value = "";
  try {
    const [instructions, skills] = await Promise.all([
      detectWorkspaceAgentsInstructions(props.workspaceId),
      detectWorkspaceExternalSkillRoots(props.workspaceId),
    ]);
    instructionCandidates.value = instructions.items.map((item) => ({
      sourceType: item.sourceType,
      ...(item.repoId ? { repoId: item.repoId } : {}),
      displayPath: item.displayPath,
      enabled: item.enabled,
    }));
    skillCandidates.value = skills.items.map((item) => ({
      sourceType: item.sourceType,
      ...(item.repoId ? { repoId: item.repoId } : {}),
      rootDir: item.rootDir,
      displayName: item.displayName,
      topLevelSkillCount: item.topLevelSkillCount,
      enabled: item.enabled,
    }));
    instructionKeys.value = instructionCandidates.value
      .filter((item) => item.enabled)
      .map(instructionKey);
    skillKeys.value = skillCandidates.value
      .filter((item) => item.enabled)
      .map(skillKey);
  } catch (error) {
    contextError.value = error instanceof Error ? error.message : String(error);
  } finally {
    contextLoading.value = false;
  }
}
async function saveContextSettings() {
  contextSaving.value = true;
  try {
    const selectedInstructions = new Set(instructionKeys.value);
    const selectedSkills = new Set(skillKeys.value);
    await Promise.all([
      updateWorkspaceAgentsInstructionsSettings(props.workspaceId, {
        enabledSources: instructionCandidates.value
          .filter((item) => selectedInstructions.has(instructionKey(item)))
          .map((item) =>
            item.sourceType === "workspace"
              ? { sourceType: "workspace" }
              : { sourceType: "repo", repoId: item.repoId! },
          ),
      }),
      updateWorkspaceExternalSkillRootsSettings(props.workspaceId, {
        enabledRoots: skillCandidates.value
          .filter((item) => selectedSkills.has(skillKey(item)))
          .map((item) =>
            item.sourceType === "workspace"
              ? { sourceType: "workspace", rootDir: item.rootDir }
              : {
                  sourceType: "repo",
                  repoId: item.repoId!,
                  rootDir: item.rootDir,
                },
          ),
      }),
    ]);
    contextModalVisible.value = false;
    emit("agent-settings-updated");
  } catch (error) {
    contextError.value = error instanceof Error ? error.message : String(error);
  } finally {
    contextSaving.value = false;
  }
}
const enablementModalVisible = ref(false);
const enablementLoading = ref(false);
const enablementSaving = ref(false);
const enablementError = ref("");
const enablementCandidates = ref<
  Array<{ id: string; name: string; enabled: boolean }>
>([]);
const enabledAgentIds = ref<string[]>([]);
async function openAgentEnablement() {
  enablementModalVisible.value = true;
  enablementLoading.value = true;
  enablementError.value = "";
  try {
    const result = await detectWorkspaceAgentEnablement(props.workspaceId);
    enablementCandidates.value = result.items;
    enabledAgentIds.value = result.items
      .filter((item) => item.enabled)
      .map((item) => item.id);
  } catch (error) {
    enablementError.value =
      error instanceof Error ? error.message : String(error);
  } finally {
    enablementLoading.value = false;
  }
}
async function saveAgentEnablement() {
  enablementSaving.value = true;
  try {
    await updateWorkspaceAgentEnablementSettings(props.workspaceId, {
      mode: "subset",
      enabledAgentIds: enabledAgentIds.value,
    });
    enablementModalVisible.value = false;
    emit("agent-settings-updated");
  } catch (error) {
    enablementError.value =
      error instanceof Error ? error.message : String(error);
  } finally {
    enablementSaving.value = false;
  }
}
watch(
  () =>
    [
      props.workspaceId,
      props.sessionId,
      props.active,
      props.sessionReady,
    ] as const,
  ([workspaceId, sessionId, active, ready]) => {
    if (disposed) return;
    if (
      workspaceId !== requestScope.workspaceId ||
      sessionId !== requestScope.sessionId
    ) {
      requestScope = advanceAgentRequestScope(
        requestScope,
        workspaceId,
        sessionId,
      );
      timelineState.value = createAgentTimelineControllerState();
      detailByExecutionId.value = {};
      detailLoading.value = new Set();
      collapsedTodoPartIds.value = new Set();
      detailLoadingScopeByExecutionId.clear();
      detailCache.reset();
      timelineRefreshScheduler.dispose();
      timelineRefreshScheduler = createAgentTimelineRefreshScheduler();
      loadingPreviousPageScope = null;
      timelineRequestSequence = 0;
      pendingRunController.stop();
      pendingCompactAttempt.value = null;
      messageMutationState.clear();
      cancelPendingScrollRestore();
      distanceToBottom.value = 0;
      stickToBottom.value = true;
    }
    if (active && ready) {
      void refreshTimeline(true).catch(() => undefined);
      void refreshPromptItems();
      pendingRunController.start({ workspaceId, sessionId });
    } else {
      clearRefreshTimer();
      pendingRunController.stop();
    }
  },
  { immediate: true },
);
watch(
  () => props.initialDraft,
  (value) => {
    if (value) draft.value = value;
  },
  { immediate: true },
);
watch(
  todoPartIds,
  (ids, previousIds) => {
    if (ids.length === 0) {
      collapsedTodoPartIds.value = new Set();
      return;
    }
    const latestId = ids.at(-1)!;
    const previousLatestId = previousIds?.at(-1);
    if (latestId === previousLatestId) return;
    collapsedTodoPartIds.value = new Set(ids.filter((id) => id !== latestId));
  },
  { immediate: true },
);
watch(
  () => runState.value.status,
  (nextStatus) => {
    const becameIdle = previousRunStatus === "running" && nextStatus !== "running";
    previousRunStatus = nextStatus;
    if (becameIdle && props.active && props.sessionReady) {
      // run 收敛后补一次最终 delta，避免最后一次轮询早于终态写入。
      void refreshTimeline(false).catch(() => undefined);
    } else scheduleRefresh();
  },
);
watch(
  () => props.modelOpenIntent,
  (intent) => {
    if (intent?.ready && intent.agentId === effectiveAgentId.value) {
      void openModelModal();
      emit("session-model-open-consumed", {
        sessionId: props.sessionId,
        requestId: intent.requestId,
      });
    }
  },
  { immediate: true },
);
function syncElapsedTimer() {
  if (elapsedTimer !== null) {
    window.clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  if (!shouldRunAgentElapsedTimer({
    active: props.active,
    status: runState.value.status,
    activeRunStartedAt: runState.value.activeRunStartedAt,
  })) return;
  now.value = Date.now();
  elapsedTimer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
}
watch(
  [() => props.active, () => runState.value.status, () => runState.value.activeRunStartedAt],
  syncElapsedTimer,
  { immediate: true },
);
onDeactivated(() => {
  saveScrollPosition();
});
onActivated(() => {
  void restoreScrollPosition();
});
onBeforeUnmount(() => {
  disposed = true;
  cancelPendingScrollRestore();
  clearRefreshTimer();
  pendingRunController.stop();
  if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
  if (mentionTimer !== null) window.clearTimeout(mentionTimer);
  previewCache.clear();
  timelineRefreshScheduler.dispose();
  detailCache.reset();
  messageMutationState.clear();
});
</script>
