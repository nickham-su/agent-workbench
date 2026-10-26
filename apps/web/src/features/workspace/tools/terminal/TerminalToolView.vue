<template>
  <div class="h-full min-h-0 flex">
    <div class="flex-1 min-w-0 min-h-0">
      <TerminalTabs
        ref="terminalTabs"
        :workspaceId="workspaceId"
        :terminals="terminals"
        :show-config-button="!configOpen"
        @open-config="openConfig"
        @created="refreshTerminals"
        @deleted="onDeleted"
        @terminal-exited="onTerminalExited"
        @terminal-invalidated="onTerminalInvalidated"
        @minimize="minimizeSelf"
      />
    </div>
    <TerminalConfigPanel v-if="configOpened" v-show="configOpen" :key="workspaceId" :workspace-id="workspaceId" :active="configOpen" @close="configOpen = false" @created="onConfigTerminalCreated" @run-started="activateConfigTerminal" @select="activateConfigTerminal" />
  </div>
</template>

<script lang="ts">
export default {
  name: "terminal"
};
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type { TerminalRecord } from "@agent-workbench/shared";
import { createTerminal, listTerminals } from "@/shared/api";
import TerminalTabs from "./TerminalTabs.vue";
import TerminalConfigPanel from "./TerminalConfigPanel.vue";
import { useWorkspaceHost } from "@/features/workspace/host";

const props = defineProps<{ workspaceId: string; toolId: string }>();
const host = useWorkspaceHost(props.toolId);

const terminals = ref<TerminalRecord[]>([]);
const terminalTabs = ref<InstanceType<typeof TerminalTabs>>();
const configOpen = ref(true);
const configOpened = ref(true);
function openConfig() { configOpened.value = true; configOpen.value = true; }
function activateConfigTerminal(request: { workspaceId: string; configId: string }) {
  if (disposed || request.workspaceId !== props.workspaceId) return;
  const terminal = terminals.value.find((term) => term.configId === request.configId);
  if (terminal) terminalTabs.value?.activateTerminal(terminal.id);
}
function onConfigTerminalCreated(terminal: TerminalRecord) {
  if (disposed || terminal.workspaceId !== props.workspaceId) return;
  // Apply the returned generation immediately; a failed follow-up list request
  // must not leave this stable tab attached to its previous physical session.
  const index = terminals.value.findIndex((term) => term.id === terminal.id);
  terminals.value = index < 0 ? [...terminals.value, terminal]
    : terminals.value.map((term) => term.id === terminal.id ? terminal : term);
  terminalTabs.value?.activateCreatedTerminal(terminal.id);
}
type RefreshRequest = { workspaceId: string; workspaceEpoch: number; generation: number };
let workspaceEpoch = 0, refreshGeneration = 0, disposed = false;
let autoCreatingEpoch: number | null = null;
function isWorkspaceCurrent(request: RefreshRequest) {
  return !disposed && request.workspaceId === props.workspaceId && request.workspaceEpoch === workspaceEpoch;
}
function isRefreshCurrent(request: RefreshRequest) {
  return isWorkspaceCurrent(request) && request.generation === refreshGeneration;
}
onBeforeUnmount(() => { disposed = true; refreshGeneration++; });

async function refreshTerminals(): Promise<RefreshRequest | null> {
  if (disposed || !props.workspaceId) return null;
  const request = { workspaceId: props.workspaceId, workspaceEpoch, generation: ++refreshGeneration };
  try {
    const result = await listTerminals(request.workspaceId);
    if (!isRefreshCurrent(request)) return null;
    terminals.value = result;
    return request;
  } catch (err) {
    if (isRefreshCurrent(request)) message.error(err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function ensureTerminalOnActivate(request: RefreshRequest) {
  if (!isRefreshCurrent(request)) return;
  if (autoCreatingEpoch === request.workspaceEpoch) return;
  if (terminals.value.length > 0) return;

  autoCreatingEpoch = request.workspaceEpoch;
  try {
    await createTerminal(request.workspaceId, {});
  } catch (err) {
    if (isWorkspaceCurrent(request)) message.error(err instanceof Error ? err.message : String(err));
  } finally {
    if (autoCreatingEpoch === request.workspaceEpoch) autoCreatingEpoch = null;
  }
  // A current Workspace's completed create needs a fresh list even if another
  // refresh started meanwhile. An old Workspace must never refresh its successor.
  if (isWorkspaceCurrent(request)) await refreshTerminals();
}

async function refreshAndEnsureTerminal() {
  const request = await refreshTerminals();
  if (request && isRefreshCurrent(request)) await ensureTerminalOnActivate(request);
}

function minimizeSelf() {
  host.minimizeTool(props.toolId);
}

async function onTerminalExited() {
  const request = await refreshTerminals();
  if (request && isRefreshCurrent(request) && terminals.value.length === 0) minimizeSelf();
}

async function onTerminalInvalidated() {
  const request = await refreshTerminals();
  if (request && isRefreshCurrent(request) && terminals.value.length === 0) minimizeSelf();
}

async function onDeleted() {
  const request = await refreshTerminals();
  if (request && isRefreshCurrent(request) && terminals.value.length === 0) minimizeSelf();
}

watch(
  () => props.workspaceId,
  () => {
    workspaceEpoch++;
    refreshGeneration++;
    configOpen.value = true;
    configOpened.value = true;
    terminals.value = [];
    void refreshAndEnsureTerminal();
  },
  { flush: "sync" }
);

onMounted(() => {
  void refreshAndEnsureTerminal();
});
</script>
