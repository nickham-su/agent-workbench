<template>
  <div>
    <div
      class="flex items-center gap-2 min-w-0 flex-wrap w-full pl-2 pr-0 py-0.5 rounded cursor-pointer hover:bg-[var(--hover-bg)] transition-colors duration-100 font-mono text-[color:var(--text-secondary)]"
      role="button"
      tabindex="0"
      @click="openInEditor"
      @keydown.enter.prevent="openInEditor"
      @keydown.space.prevent="openInEditor"
    >
      <span class="min-w-0 inline-flex items-baseline gap-0 max-w-full">
        <span class="shrink-0">write(</span>
        <span class="min-w-0 truncate" :title="summary.filePath">{{ summary.filePath }}</span>
        <span class="shrink-0">)</span>
        <span class="shrink-0 ml-1">[{{ summary.bytesWritten }} bytes]</span>
      </span>
      <span v-if="errorText" class="min-w-0 max-w-[30%] truncate text-red-500">
        error: {{ errorText }}
      </span>
      <span class="text-[color:var(--text-tertiary)] text-xs">打开到编辑器</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { message } from "ant-design-vue";
import { useWorkspaceHost } from "@/features/workspace/host";
import { inferLanguageFromPath } from "@/shared/monaco/languageUtils";

type WriteDisplay = {
  summary: string;
  filePath: string;
  bytesWritten: number;
  existedBefore: boolean;
};

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
  summary: {
    bytesWritten: number;
    existedBefore: boolean;
  };
  before: WriteUiArtifactSide;
  after: WriteUiArtifactSide;
};

const props = defineProps<{
  workspaceId: string;
  toolId: string;
  sessionId: string;
  itemId: number;
  toolCallId?: string;
  summary: WriteDisplay;
  errorText?: string;
}>();

const host = useWorkspaceHost(props.toolId);
const artifactCache = new Map<string, Promise<WriteUiArtifact>>();

function cacheKey() {
  return `${props.workspaceId}:${props.toolCallId || props.itemId}`;
}

async function fetchArtifact() {
  const key = cacheKey();
  const existing = artifactCache.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const url = `/api/agent/sessions/${encodeURIComponent(props.sessionId)}/context-items/${props.itemId}/write-artifact`;
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `http ${response.status}`);
    }
    return (await response.json()) as WriteUiArtifact;
  })();
  artifactCache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    artifactCache.delete(key);
    throw err;
  }
}

function explainUnavailable(side: WriteUiArtifactSide | undefined, label: string) {
  if (!side || side.available) return "";
  const reason = typeof side.reason === "string" && side.reason.trim() ? side.reason.trim() : "unavailable";
  return `${label} ${reason}`;
}

async function openInEditor() {
  if (!props.toolCallId) {
    message.error("missing toolCallId");
    return;
  }
  try {
    const artifact = await fetchArtifact();
    const language = inferLanguageFromPath(props.summary.filePath);
    const beforeAvailable = artifact.before?.available === true;
    const afterAvailable = artifact.after?.available === true;
    const tabKey = `agent:write:${props.toolCallId}`;
    if (!beforeAvailable && afterAvailable) {
      host.call("editor", {
        type: "editor.openPreview",
        payload: {
          path: props.summary.filePath,
          text: artifact.after.text || "",
          language,
          title: props.summary.filePath,
          tabKey,
          source: "agent.write"
        }
      });
      return;
    }
    if (beforeAvailable && afterAvailable) {
      host.call("editor", {
        type: "editor.openDiff",
        payload: {
          original: artifact.before.text || "",
          modified: artifact.after.text || "",
          path: props.summary.filePath,
          language,
          title: props.summary.filePath,
          tabKey,
          source: "agent.write"
        }
      });
      return;
    }
    const reasons = [
      explainUnavailable(artifact.before, "before"),
      explainUnavailable(artifact.after, "after")
    ].filter(Boolean);
    message.error(reasons[0] || "diff unavailable");
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}
</script>
