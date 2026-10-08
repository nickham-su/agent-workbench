<template>
  <AgentToolCallRow
    tool-name="write"
    :input="input"
    :execution="execution"
    :now="now"
    :interactive="canOpen"
    :loading="opening"
    @activate="openInEditor"
  />
</template>

<script setup lang="ts">
import type { AgentTimelineToolExecution } from "@agent-workbench/shared";
import { message } from "ant-design-vue";
import { computed, onBeforeUnmount, onBeforeUpdate, ref, watch } from "vue";
import { useWorkspaceHost } from "@/features/workspace/host";
import { inferLanguageFromPath } from "@/shared/monaco/languageUtils";
import AgentToolCallRow from "./AgentToolCallRow.vue";
import { runAgentArtifactOpenRequest } from "./agentArtifactOpenController";
import { createAgentArtifactRequestGuard } from "./agentArtifactRequestGuard";

type WriteUiArtifactSide = {
  available: boolean;
  text?: string;
  truncated: boolean;
  bytes: number;
  reason?: string;
};

type WriteUiArtifact = {
  schemaVersion: number;
  toolName: string;
  workspaceId: string;
  toolCallId: string;
  createdAt: number;
  filePath: string;
  before: WriteUiArtifactSide;
  after: WriteUiArtifactSide;
};

const props = defineProps<{
  workspaceId: string;
  toolId: string;
  sessionId: string;
  toolExecutionId?: string;
  input: unknown;
  execution: AgentTimelineToolExecution | null;
  now: number;
}>();

const host = useWorkspaceHost(props.toolId);
const opening = ref(false);
const canOpen = computed(
  () => !!props.toolExecutionId && props.execution?.status === "completed",
);
const artifactCache = new Map<string, Promise<WriteUiArtifact>>();
const requestGuard = createAgentArtifactRequestGuard({
  workspaceId: props.workspaceId,
  sessionId: props.sessionId,
  executionId: props.toolExecutionId || "",
});
watch(
  () => [props.workspaceId, props.sessionId, props.toolExecutionId || ""] as const,
  ([workspaceId, sessionId, executionId]) =>
    requestGuard.update({ workspaceId, sessionId, executionId }),
  { flush: "sync" },
);
onBeforeUpdate(() =>
  requestGuard.update({
    workspaceId: props.workspaceId,
    sessionId: props.sessionId,
    executionId: props.toolExecutionId || "",
  }),
);
onBeforeUnmount(() => requestGuard.dispose());

function cacheKey() {
  return `${props.workspaceId}:${props.sessionId}:${props.toolExecutionId || ""}`;
}

async function fetchArtifact(request: ReturnType<typeof requestGuard.begin>) {
  const key = cacheKey();
  const existing = artifactCache.get(key);
  if (existing) {
    try {
      return await existing;
    } finally {
      request.finish();
    }
  }
  const executionId = props.toolExecutionId;
  if (!executionId) throw new Error("write execution unavailable");
  const promise = (async () => {
    const url = `/api/agent/sessions/${encodeURIComponent(props.sessionId)}/tool-executions/${encodeURIComponent(executionId)}/write-artifact?workspaceId=${encodeURIComponent(props.workspaceId)}`;
    const response = await fetch(url, { signal: request.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `http ${response.status}`);
    }
    return (await response.json()) as WriteUiArtifact;
  })();
  artifactCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    artifactCache.delete(key);
    throw error;
  } finally {
    request.finish();
  }
}

function explainUnavailable(side: WriteUiArtifactSide | undefined, label: string) {
  if (!side || side.available) return "";
  const reason =
    typeof side.reason === "string" && side.reason.trim()
      ? side.reason.trim()
      : "unavailable";
  return `${label} ${reason}`;
}

async function openInEditor() {
  if (!canOpen.value || opening.value) return;
  opening.value = true;
  try {
    await runAgentArtifactOpenRequest({
      guard: requestGuard,
      fetchArtifact,
      onArtifact: (artifact) => {
        const filePath = String(artifact.filePath || "").trim();
        if (!filePath) {
          message.error("file unavailable");
          return;
        }
        const language = inferLanguageFromPath(filePath);
        const beforeAvailable = artifact.before?.available === true;
        const afterAvailable = artifact.after?.available === true;
        const tabKey = `agent:write:${props.toolExecutionId}`;
        if (!beforeAvailable && afterAvailable) {
          host.call("editor", {
            type: "editor.openPreview",
            payload: {
              path: filePath,
              text: artifact.after.text || "",
              language,
              title: filePath,
              tabKey,
              source: "agent.write",
            },
          });
          return;
        }
        if (beforeAvailable && afterAvailable) {
          host.call("editor", {
            type: "editor.openDiff",
            payload: {
              original: artifact.before.text || "",
              modified: artifact.after.text || "",
              path: filePath,
              language,
              title: filePath,
              tabKey,
              source: "agent.write",
            },
          });
          return;
        }
        const reasons = [
          explainUnavailable(artifact.before, "before"),
          explainUnavailable(artifact.after, "after"),
        ].filter(Boolean);
        message.error(reasons[0] || "diff unavailable");
      },
      onError: (error) =>
        message.error(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    opening.value = false;
  }
}
</script>
