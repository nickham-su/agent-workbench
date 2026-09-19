<template>
  <AgentToolCallRow
    tool-name="apply_patch"
    :input="input"
    :execution="execution"
    :now="now"
    :interactive="canOpen"
    :loading="opening"
    @activate="openAllDiffs"
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

type ApplyPatchUiArtifactFile = {
  type: "add" | "update" | "delete" | "move";
  path: string;
  fromPath?: string;
  additions: number;
  deletions: number;
  before: string;
  after: string;
};

type ApplyPatchUiArtifact = {
  schemaVersion: number;
  toolName: string;
  workspaceId: string;
  toolCallId: string;
  createdAt: number;
  files: ApplyPatchUiArtifactFile[];
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
const artifactCache = new Map<string, Promise<ApplyPatchUiArtifact>>();
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
  if (!executionId) throw new Error("apply_patch execution unavailable");
  const promise = (async () => {
    const url = `/api/agent/sessions/${encodeURIComponent(props.sessionId)}/tool-executions/${encodeURIComponent(executionId)}/apply-patch-artifact?workspaceId=${encodeURIComponent(props.workspaceId)}`;
    const response = await fetch(url, { signal: request.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `http ${response.status}`);
    }
    return (await response.json()) as ApplyPatchUiArtifact;
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

async function openAllDiffs() {
  if (!canOpen.value || opening.value) return;
  opening.value = true;
  try {
    await runAgentArtifactOpenRequest({
      guard: requestGuard,
      fetchArtifact,
      onArtifact: (artifact) => {
        const executionId = props.toolExecutionId;
        const files = Array.isArray(artifact.files)
          ? artifact.files.filter((file) => String(file.path || "").trim())
          : [];
        if (!executionId || files.length === 0) {
          message.error("diff unavailable");
          return;
        }
        for (const file of files) {
          const path = String(file.path).trim();
          host.call("editor", {
            type: "editor.openDiff",
            payload: {
              original: file.before || "",
              modified: file.after || "",
              path,
              language: inferLanguageFromPath(path),
              title: path,
              tabKey: `agent:applyPatch:${executionId}:${path}`,
              source: "agent.applyPatch",
            },
          });
        }
      },
      onError: (error) =>
        message.error(error instanceof Error ? error.message : String(error)),
    });
  } finally {
    opening.value = false;
  }
}
</script>
