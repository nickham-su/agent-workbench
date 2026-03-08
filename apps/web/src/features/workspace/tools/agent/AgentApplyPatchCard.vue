<template>
  <div>
    <div class="flex flex-col gap-0.5">
      <div v-for="(file, idx) in files" :key="`${file.path}-${idx}`">
        <div
          class="flex items-center gap-2 min-w-0 flex-wrap w-full pl-2 pr-0 py-0.5 rounded cursor-pointer hover:bg-[var(--hover-bg)] transition-colors duration-100 font-mono text-[color:var(--text-secondary)]"
          role="button"
          tabindex="0"
          @click="openFileDiff(file.path)"
          @keydown.enter.prevent="openFileDiff(file.path)"
          @keydown.space.prevent="openFileDiff(file.path)"
        >
          <span class="min-w-0 inline-flex items-baseline gap-0 max-w-full">
            <span class="shrink-0">applypatch(</span>
            <span class="min-w-0 truncate" :title="file.path">{{ file.path }}</span>
            <span class="shrink-0">)</span>
            <span class="shrink-0 ml-1">[+{{ file.additions }} -{{ file.deletions }}]</span>
          </span>
        </div>
      </div>
    </div>

    <div v-if="errorText" class="pl-2 pr-0 text-red-500 py-0.5">error: {{ errorText }}</div>
  </div>
</template>

<script setup lang="ts">
import { message } from "ant-design-vue";
import { useWorkspaceHost } from "@/features/workspace/host";
import { inferLanguageFromPath } from "@/shared/monaco/languageUtils";

type ApplyPatchFileMeta = {
  type: "add" | "update" | "delete" | "move";
  path: string;
  fromPath?: string;
  additions: number;
  deletions: number;
};

type ApplyPatchSummary = {
  fileCount: number;
  additions: number;
  deletions: number;
};

type ApplyPatchUiArtifactFile = ApplyPatchFileMeta & {
  before: string;
  after: string;
};

type ApplyPatchUiArtifact = {
  schemaVersion: number;
  toolName: string;
  workspaceId: string;
  toolCallId: string;
  createdAt: number;
  summary: ApplyPatchSummary;
  files: ApplyPatchUiArtifactFile[];
};

const props = defineProps<{
  workspaceId: string;
  toolId: string;
  sessionId: string;
  itemId: number;
  toolCallId?: string;
  summary: ApplyPatchSummary;
  files: ApplyPatchFileMeta[];
  omittedFiles: number;
  errorText?: string;
}>();

const host = useWorkspaceHost(props.toolId);
const artifactCache = new Map<string, Promise<ApplyPatchUiArtifact>>();

function cacheKey() {
  return `${props.workspaceId}:${props.toolCallId || props.itemId}`;
}

async function fetchArtifact() {
  const key = cacheKey();
  const existing = artifactCache.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const url = `/api/agent/sessions/${encodeURIComponent(props.sessionId)}/context-items/${props.itemId}/apply-patch-artifact`;
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(text || `http ${response.status}`);
    }
    return (await response.json()) as ApplyPatchUiArtifact;
  })();
  artifactCache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    artifactCache.delete(key);
    throw err;
  }
}

async function openFileDiff(pathValue: string) {
  const p = String(pathValue || "").trim();
  if (!p) return;
  if (!props.toolCallId) {
    message.error("missing toolCallId");
    return;
  }
  try {
    const artifact = await fetchArtifact();
    const file = artifact.files.find((item) => item.path === p);
    if (!file) {
      message.error(`diff unavailable: ${p}`);
      return;
    }
    host.call("editor", {
      type: "editor.openDiff",
      payload: {
        original: file.before || "",
        modified: file.after || "",
        path: p,
        language: inferLanguageFromPath(p),
        title: p,
        tabKey: `agent:applyPatch:${props.toolCallId}:${p}`,
        source: "agent.applyPatch"
      }
    });
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err));
  }
}
</script>
