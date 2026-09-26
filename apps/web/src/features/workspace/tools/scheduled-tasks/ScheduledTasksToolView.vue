<template>
  <div class="flex h-full min-h-0 bg-[var(--panel-bg)] text-sm text-[var(--text-primary)]">
    <aside class="flex w-[min(40%,370px)] min-w-[200px] flex-col border-r border-[var(--border-color-secondary)]">
      <div class="flex items-center justify-between gap-2 border-b border-[var(--border-color-secondary)] px-3 py-3">
        <h2 class="m-0 text-base font-semibold">定时任务</h2>
        <a-button class="!w-[108px] flex-none" :disabled="writesDisabled" @click="openCreate"><template #icon><PlusOutlined /></template>创建任务</a-button>
      </div>
      <div class="flex gap-2 border-b border-[var(--border-color-secondary)] px-3 py-3">
        <a-input :value="search" class="min-w-0 flex-1" placeholder="搜索任务" aria-label="搜索任务名称" @update:value="updateSearch">
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <a-select v-model:value="status" class="!w-[108px] flex-none" :options="[{value:'all',label:'全部状态'},{value:'enabled',label:'已启用'},{value:'paused',label:'已暂停'}]" aria-label="任务状态" @change="resetList" />
      </div>
      <div class="min-h-0 flex-1 overflow-auto px-2 py-2" aria-label="任务列表">
        <a-spin v-if="listLoading" class="block py-3" />
        <button v-for="item in tasks" :key="item.id" type="button" class="scheduled-task-card mb-1 w-full rounded border border-transparent p-3 text-left" :class="{ 'is-selected': selectedId === item.id }" @click="selectTask(item)">
          <div class="flex min-w-0 items-center gap-2">
            <span class="h-1.5 w-1.5 flex-none rounded-full" :class="item.enabled ? 'bg-green-500' : 'bg-gray-400'" />
            <span class="min-w-0 flex-1 truncate font-semibold" :title="item.name">{{ item.name }}</span>
            <a-tooltip v-if="item.latestScheduledExecution?.status === 'skipped'" :title="skipReason(item.latestScheduledExecution)"><span tabindex="0" role="img" aria-label="最近一次计划执行已跳过" class="text-amber-500">⚠</span></a-tooltip>
            <a-tag class="!m-0 flex-none" :color="item.enabled ? 'green' : 'default'">{{ item.enabled ? '已启用' : '已暂停' }}</a-tag>
          </div>
          <div class="mt-2 flex min-w-0 items-center justify-between gap-2 pl-3 text-xs text-[var(--text-tertiary)]">
            <span class="min-w-0 truncate"><ClockCircleOutlined class="mr-1" />{{ summarize(item.schedule, currentOffset) }}</span>
            <span v-if="isRunning(item)" class="flex-none text-blue-500">● 已运行 {{ elapsed(item.activeExecution!.startedAt ?? item.activeExecution!.createdAt) }} 分钟</span>
            <span v-else-if="item.nextRunAt" class="flex-none">下次：{{ shortTime(item.nextRunAt) }}</span>
            <span v-else class="flex-none">无后续计划</span>
          </div>
        </button>
        <a-empty v-if="!listLoading && !tasks.length" description="暂无任务" />
        <a-button v-if="nextCursor" block :loading="listLoading" @click="loadList(true)">加载更多</a-button>
      </div>
      <section class="space-y-1 border-t border-[var(--border-color-secondary)] bg-[var(--panel-bg)] px-3 py-2 text-xs leading-4" aria-label="时间同步状态">
        <div class="flex items-center justify-between gap-2">
          <span class="inline-flex items-center gap-1">
            <span aria-hidden="true" class="clock-health-dot" :class="clock.health === 'normal' ? 'text-green-500' : clock.health === 'warning' ? 'text-amber-500' : 'text-gray-400'">●</span>
            <span class="clock-health-label" :class="clock.health === 'normal' ? 'text-[var(--text-color)]' : clock.health === 'warning' ? 'text-amber-500' : 'text-gray-400'">{{ clockLabel }}</span>
          </span>
          <span class="text-[var(--text-tertiary)]">{{ clockDeviation }}</span>
        </div>
        <div v-if="clock.health !== 'normal'" class="flex justify-between gap-2 text-[var(--text-tertiary)]"><span>服务端时间</span><span>{{ clock.serverNow === null ? '—' : localTime(clock.serverNow) }}</span></div>
        <div v-if="clock.health !== 'normal'" class="flex justify-between gap-2 text-[var(--text-tertiary)]"><span>设备时间</span><span>{{ localTime(clock.deviceNow) }}</span></div>
      </section>
    </aside>
    <main class="min-w-0 flex-1 overflow-auto p-4 sm:p-5">
      <template v-if="selected">
        <header class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="m-0 break-words text-xl font-semibold">{{ selected.name }}</h2>
              <a-tag class="!m-0" :color="selected.enabled ? 'green' : 'default'">{{ selected.enabled ? '已启用' : '已暂停' }}</a-tag>
              <a-tag class="!m-0">{{ isRunning(selected) ? '运行中' : '空闲' }}</a-tag>
            </div>
            <p class="mb-0 mt-1 text-xs text-[var(--text-tertiary)]">创建于 {{ createdTime(selected.createdAt) }} · 最近更新 {{ updatedTime(selected.updatedAt) }}</p>
          </div>
          <div class="flex flex-wrap gap-2">
            <a-button :loading="busy" :disabled="writesDisabled" @click="toggleEnabled"><template #icon><PauseOutlined v-if="selected.enabled" /><PlayCircleOutlined v-else /></template>{{ selected.enabled ? '暂停' : '启用' }}</a-button>
            <a-button :loading="busy" :disabled="writesDisabled" @click="runNow"><template #icon><PlayCircleOutlined /></template>立即运行</a-button>
            <a-button :disabled="writesDisabled" @click="openEdit"><template #icon><EditOutlined /></template>编辑</a-button>
            <a-button class="scheduled-delete-button" :disabled="writesDisabled || isRunning(selected)" @click="confirmDelete"><template #icon><DeleteOutlined /></template>删除</a-button>
          </div>
        </header>
        <a-alert v-if="selected.latestScheduledExecution?.status === 'skipped'" class="mt-3" type="warning" show-icon :message="'最近一次计划执行已跳过：' + skipReason(selected.latestScheduledExecution)" />
        <a-alert v-if="notice" class="mt-3" :type="noticeType" :message="notice" show-icon closable @close="notice = ''" />
        <a-tabs v-model:activeKey="tab" class="scheduled-task-tabs">
          <a-tab-pane key="overview" tab="概览">
            <div class="max-w-[1080px] space-y-4 pt-1">
              <section class="detail-panel" aria-labelledby="task-runtime-heading">
                <h3 id="task-runtime-heading" class="detail-panel-heading">调度与运行</h3>
                <div class="grid gap-x-6 gap-y-5 p-4 md:grid-cols-2">
                  <div><div class="detail-label">执行计划</div><div class="mt-2">{{ summarize(selected.schedule, currentOffset) }} <span class="text-xs text-[var(--text-tertiary)]">（本地时间）</span></div></div>
                  <div><div class="detail-label">下次运行</div><div class="mt-2"><span v-if="selected.nextRunAt !== null" class="text-blue-500">{{ shortTime(selected.nextRunAt) }}</span><span v-else>无后续计划</span><span v-if="selected.nextRunAt !== null" class="ml-2 text-xs text-[var(--text-tertiary)]">{{ runCountdown(selected.nextRunAt) }}</span></div></div>
                  <div aria-label="最近执行"><div class="detail-label">最近执行</div>
                    <div class="mt-2"><span :class="executionColor(selected.latestExecution)">{{ selected.latestExecution ? statusLabel(selected.latestExecution.status) : '尚无执行' }}</span><span v-if="selected.latestExecution" class="text-xs text-[var(--text-tertiary)]"> · {{ shortTime(selected.latestExecution.createdAt) }}</span>
                      <a-button v-if="selected.latestExecution?.sessionAvailable && selected.latestExecution.sessionId" type="link" size="small" @click="openSession(selected.latestExecution.sessionId)">查看 Session ↗</a-button>
                      <span v-else-if="selected.latestExecution?.sessionId" class="ml-2 text-xs text-[var(--text-tertiary)]">Session 不可用</span>
                    </div>
                  </div>
                  <div><div class="detail-label">Agent</div><div class="mt-2">{{ agents.find((agent) => agent.id === selected!.agentId)?.name ?? selected.agentId }}</div></div>
                </div>
              </section>
              <section class="detail-panel" aria-labelledby="task-context-detail-heading">
                <h3 id="task-context-detail-heading" class="detail-panel-heading"><span>执行上下文</span><a-tag class="!m-0" :color="selected.triggerMode === 'fork_message' ? 'blue' : 'default'">{{ selected.triggerMode === 'fork_message' ? '基于历史消息' : '新建 Session' }}</a-tag></h3>
                <div class="p-4">
                  <div v-if="selected.source" class="space-y-2 rounded border border-[var(--border-color-secondary)] p-3">
                    <div class="font-medium"><MessageOutlined class="mr-2" />来源会话：{{ selected.source.title }}</div>
                    <blockquote class="m-0 border-l-2 border-[var(--border-color)] pl-3 whitespace-pre-wrap break-words text-[var(--text-tertiary)]">{{ selected.source.messageSummary }}</blockquote>
                    <div class="text-xs text-[var(--text-tertiary)]">锚点消息 · {{ createdTime(selected.source.messageCreatedAt) }}
                      <a-button type="link" size="small" @click="openSession(selected.source!.sessionId)">查看上下文 ↗</a-button>
                    </div>
                  </div>
                  <p v-else class="m-0 text-[var(--text-tertiary)]">每次执行时创建独立的空白 Session。</p>
                </div>
              </section>
              <section class="detail-panel" aria-labelledby="task-prompt-heading">
                <h3 id="task-prompt-heading" class="detail-panel-heading">每次执行追加的 Prompt</h3>
                <div class="p-4"><div class="whitespace-pre-wrap break-words rounded border border-[var(--border-color-secondary)] p-3">{{ selected.prompt }}</div></div>
              </section>
            </div>
          </a-tab-pane>
          <a-tab-pane key="history" tab="执行历史">
            <div class="pt-1">
              <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div class="flex flex-wrap gap-2">
                  <a-select v-model:value="resultFilter" class="w-32" :options="[{value:'all',label:'全部结果'},{value:'completed',label:'已完成'},{value:'failed',label:'已失败'},{value:'skipped',label:'已跳过'}]" aria-label="执行结果" @change="resetHistory" />
                  <a-select v-model:value="triggerFilter" class="w-32" :options="[{value:'all',label:'全部触发'},{value:'scheduled',label:'自动'},{value:'manual',label:'手动'}]" aria-label="触发方式" @change="resetHistory" />
                </div>
                <a-button @click="resetHistory"><template #icon><ReloadOutlined /></template>刷新</a-button>
              </div>
              <a-spin v-if="historyLoading" />
              <div v-if="history.length" class="overflow-x-auto">
                <table class="w-full min-w-[880px] border border-[var(--border-color-secondary)] text-left" aria-label="执行历史列表">
                  <thead class="bg-[var(--panel-bg-elevated)] text-[var(--text-tertiary)]">
                    <tr>
                      <th scope="col" class="px-3 py-2 font-normal">计划时间</th>
                      <th scope="col" class="px-3 py-2 font-normal">触发方式</th>
                      <th scope="col" class="px-3 py-2 font-normal">状态</th>
                      <th scope="col" class="px-3 py-2 font-normal">开始时间</th>
                      <th scope="col" class="px-3 py-2 font-normal">耗时</th>
                      <th scope="col" class="px-3 py-2 font-normal">关联会话</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="execution in history" :key="execution.id" class="border-t border-[var(--border-color-secondary)]" :class="execution.status === 'skipped' ? 'bg-[var(--fill-secondary)]' : ''">
                      <td class="whitespace-nowrap px-3 py-3">{{ historyTime(execution.scheduledFor ?? execution.createdAt) }}</td>
                      <td class="px-3 py-3">{{ execution.triggerType === 'manual' ? '手动' : '自动' }}</td>
                      <td class="whitespace-nowrap px-3 py-3">
                        <a-tooltip v-if="execution.status === 'skipped'" :title="skipReason(execution)"><span tabindex="0" class="text-amber-500"><PauseOutlined class="mr-1" />{{ statusLabel(execution.status) }}</span></a-tooltip>
                        <span v-else :class="executionColor(execution)"><CheckOutlined v-if="execution.status === 'completed'" class="mr-1" /><CloseOutlined v-else-if="execution.status === 'failed' || execution.status === 'failed_to_start'" class="mr-1" />{{ statusLabel(execution.status) }}</span>
                      </td>
                      <td class="whitespace-nowrap px-3 py-3">{{ execution.startedAt === null ? '—' : historyStartTime(execution.startedAt) }}</td>
                      <td class="whitespace-nowrap px-3 py-3">{{ executionDuration(execution) }}</td>
                      <td class="whitespace-nowrap px-3 py-3">
                        <a-button v-if="execution.sessionAvailable && execution.sessionId" type="link" size="small" class="!h-auto !p-0" @click="openSession(execution.sessionId)">查看 Session ↗</a-button>
                        <span v-else-if="execution.sessionId" class="text-xs text-[var(--text-tertiary)]">Session 不可用</span>
                        <span v-else>—</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <a-empty v-if="!historyLoading && !history.length" description="暂无执行历史" />
              <a-button v-if="historyCursor" block :loading="historyLoading" @click="loadHistory(true)">加载更多</a-button>
            </div>
          </a-tab-pane>
        </a-tabs>
      </template>
    </main>
    <ScheduledTaskDrawer :open="drawerOpen" :task="editing" :workspace-id="workspaceId" :agents="agents" :ready-agent-ids="readyAgentIds" :now="clock.deviceNow" :writes-disabled="writesDisabled" @close="closeDrawer" @saved="onSaved" @error-action="onDrawerErrorAction" />
  </div>
</template>
<script lang="ts">export default {name:"scheduledTasks"};</script>
<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { Modal } from "ant-design-vue";
import { CheckOutlined, ClockCircleOutlined, CloseOutlined, DeleteOutlined, EditOutlined, MessageOutlined, PauseOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import type { AgentItemView, ScheduledExecution, ScheduledTask } from "@agent-workbench/shared";
import { listWorkspaceAvailableAgents, listAgentSessions } from "@/shared/api";
import { useWorkspaceHost } from "@/features/workspace/host";
import { scheduledApi, ScheduledApiError } from "./scheduledApi";
import { normalizeTaskSearch, scheduledErrorPresentation, type ScheduledErrorAction } from "./scheduledUi";
import { ClockPoller, ServerClock, type ClockSnapshot } from "./serverClock";
import { summarize } from "./scheduleEditor";
import ScheduledTaskDrawer from "./ScheduledTaskDrawer.vue";

const props = defineProps<{workspaceId:string; toolId:string}>();
const host = useWorkspaceHost(props.toolId);
const api = computed(() => scheduledApi(props.workspaceId));
const tasks = ref<ScheduledTask[]>([]), selected = ref<ScheduledTask | null>(null), selectedId = ref("");
const search = ref(""), status = ref<"all" | "enabled" | "paused">("all"), nextCursor = ref<string | null>(null), listLoading = ref(false);
const history = ref<ScheduledExecution[]>([]), historyCursor = ref<string | null>(null), historyLoading = ref(false);
const resultFilter = ref<"all" | "completed" | "failed" | "skipped">("all"), triggerFilter = ref<"all" | "scheduled" | "manual">("all");
const tab = ref("overview"), editing = ref<ScheduledTask | null>(null), drawerOpen = ref(false), busy = ref(false);
const agents = ref<AgentItemView[]>([]), notice = ref(""), noticeType = ref<"error" | "info" | "success">("info");
const readyAgentIds = ref<string[]>([]);
const writesDisabled = ref(false);
const currentOffset = ref(new Date().getTimezoneOffset());
const serverClock = new ServerClock();
const clock = ref<ClockSnapshot>(serverClock.snapshot());
const clockPoller = new ClockPoller(serverClock, () => api.value.serverTime(), (snapshot) => {clock.value = snapshot; currentOffset.value = new Date().getTimezoneOffset();});
const clockLabel = computed(() => clock.value.health === "unavailable" ? "时间同步不可用" : clock.value.retrying ? "正在重新同步" :
  clock.value.health === "uncertain" ? "网络延迟较高，时间偏差仅供参考" : clock.value.health === "warning" ? "设备时间与服务端存在偏差" : "时间同步正常");
const localTime = (value:number) => new Date(value).toLocaleString();
const timeOfDay = (date:Date) => date.toLocaleTimeString(undefined, {hour:"2-digit",minute:"2-digit",hour12:false});
function shortTime(value:number) {
  const date = new Date(value), now = new Date(clock.value.deviceNow);
  if (date.toDateString() === now.toDateString()) return `今天 ${timeOfDay(date)}`;
  const tomorrow = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${timeOfDay(date)}`;
  return `${date.toLocaleDateString()} ${timeOfDay(date)}`;
}
function historyTime(value:number) {
  const date = new Date(value), now = new Date(clock.value.deviceNow);
  if (date.toDateString() === now.toDateString()) return `今天 ${timeOfDay(date)}`;
  const yesterday = new Date(now.getFullYear(),now.getMonth(),now.getDate()-1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${timeOfDay(date)}`;
  return `${date.toLocaleDateString(undefined,{month:"numeric",day:"numeric"})} ${timeOfDay(date)}`;
}
const historyStartTime = (value:number) => new Date(value).toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
function executionDuration(execution:ScheduledExecution) {
  if (execution.startedAt === null || (execution.finishedAt === null && execution.status !== "running")) return "—";
  const end = execution.finishedAt ?? clock.value.deviceNow;
  const seconds = Math.max(0,Math.floor((end - execution.startedAt)/1000));
  const hours = Math.floor(seconds/3600), minutes = Math.floor(seconds%3600/60);
  if (hours) return `${hours}小时${minutes}分`;
  if (minutes) return `${minutes}分${seconds%60}秒`;
  return `${seconds}秒`;
}
const createdTime = (value:number) => new Date(value).toLocaleString(undefined,{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
function updatedTime(value:number) {
  const delta = Math.max(0,clock.value.deviceNow - value);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return createdTime(value);
}
function runCountdown(value:number) {
  const minutes = Math.max(0,Math.ceil((value - clock.value.deviceNow)/60_000));
  return minutes < 60 ? `约 ${minutes} 分钟后` : minutes < 1_440 ? `约 ${Math.ceil(minutes/60)} 小时后` : `约 ${Math.ceil(minutes/1_440)} 天后`;
}
const clockDeviation = computed(() => clock.value.offset === null || clock.value.health === "unavailable" ? "偏差 —" :
  Math.abs(clock.value.offset) < 1000 ? "偏差 < 1 秒" : `偏差约 ${Math.round(Math.abs(clock.value.offset) / 1000)} 秒`);
const isRunning = (task:ScheduledTask) => Boolean(task.activeExecution);
const elapsed = (start:number) => Math.max(0,Math.floor((clock.value.deviceNow - start) / 60000));
const statusLabel = (s:ScheduledExecution["status"]) => ({starting:"待确认",running:"运行中",completed:"已完成",failed:"已失败",cancelled:"已取消",failed_to_start:"启动失败",skipped:"已跳过"})[s];
const executionColor = (execution:ScheduledExecution | null) => execution?.status === "completed" ? "text-green-500" :
  execution?.status === "failed" || execution?.status === "failed_to_start" ? "text-red-500" : execution?.status === "running" ? "text-blue-500" : "";
const skipReason = (execution:ScheduledExecution) => execution.reasonCode === "previous_execution_running" ? "跳过原因：上一次执行在本次计划时间到达时仍未结束。" : execution.reasonMessage ?? "计划执行已跳过";
const setNotice = (value:string, type:typeof noticeType.value = "info") => {notice.value = value;noticeType.value = type;};
let scopeEpoch = 0, listToken = 0, historyToken = 0, searchTimer:ReturnType<typeof setTimeout> | undefined, refreshTimer:ReturnType<typeof setInterval> | undefined;
function discardSelection() {selected.value=null;selectedId.value="";history.value=[];historyCursor.value=null;historyToken++;}
function handleError(error:unknown, fallback?:string) {
  const presentation=scheduledErrorPresentation(error);
  setNotice(fallback && !(error instanceof ScheduledApiError) ? fallback : presentation.text,"error");
  if (presentation.action === "stopWrites") writesDisabled.value=true;
  if (presentation.action === "refreshList") { discardSelection();resetList(); }
  if (presentation.action === "refreshHistory") { resetHistory();void refreshList(); }
  if (presentation.action === "wait") void refreshList();
  return presentation.action;
}
function onDrawerErrorAction(action:"refreshList" | "stopWrites") {
  if (action === "stopWrites") writesDisabled.value=true;
  if (action === "refreshList") {closeDrawer();discardSelection();resetList();}
}
async function loadAgents() {
  const workspaceId=props.workspaceId, scope=scopeEpoch, taskApi=api.value;
  try {const [response, ready]=await Promise.all([listWorkspaceAvailableAgents(workspaceId,"user"),taskApi.readyAgents()]);
    if(scope===scopeEpoch && workspaceId===props.workspaceId) {agents.value=response.agents;readyAgentIds.value=ready.agentIds;}}
  catch {if(scope===scopeEpoch && workspaceId===props.workspaceId) {agents.value=[];readyAgentIds.value=[];}}
}
async function loadList(more = false) {
  listLoading.value = true; const token = ++listToken, scope=scopeEpoch, workspaceId=props.workspaceId, taskApi=api.value;
  try {const page = await taskApi.list({status:status.value, q:normalizeTaskSearch(search.value),...(more && nextCursor.value ? {cursor:nextCursor.value} : {})});
    if (token !== listToken || scope !== scopeEpoch || workspaceId !== props.workspaceId) return;
    tasks.value = more ? [...tasks.value,...page.items] : page.items; nextCursor.value = page.nextCursor;
    if (selectedId.value) { const updated = tasks.value.find((item)=>item.id === selectedId.value); if (updated) selected.value = updated; else if (!more) {selected.value=null;selectedId.value="";} }
    if (!selectedId.value && tasks.value.length) void selectTask(tasks.value[0]!);
  } catch(e) {if(token===listToken && scope===scopeEpoch) handleError(e,"加载任务失败");}
  finally {if (token === listToken && scope===scopeEpoch) listLoading.value = false;}
}
function resetList() {nextCursor.value=null;tasks.value=[];void loadList();}
/** Re-read every loaded page in server order without dropping page-two selections. */
async function refreshList() {
  if(listLoading.value || !tasks.value.length) return;
  const scope=scopeEpoch, token=++listToken, workspaceId=props.workspaceId, taskApi=api.value;
  const count=tasks.value.length, rows:ScheduledTask[]=[];
  let cursor:string|null=null;
  try {
    do {const page=await taskApi.list({status:status.value,q:normalizeTaskSearch(search.value),...(cursor?{cursor}:{})});
      if(scope!==scopeEpoch || token!==listToken || workspaceId!==props.workspaceId)return;
      rows.push(...page.items);cursor=page.nextCursor;
    } while(cursor && rows.length<count);
    tasks.value=rows;nextCursor.value=cursor;
    const match=rows.find((item)=>item.id===selectedId.value);if(match)selected.value=match;
  }catch(e){if(scope===scopeEpoch && token===listToken)handleError(e,"刷新任务失败");}
}
function updateSearch(value:string) {search.value=[...value.trimStart()].slice(0,100).join("");if(searchTimer)clearTimeout(searchTimer);searchTimer=setTimeout(resetList,250);}
async function selectTask(task:ScheduledTask) {selectedId.value = task.id;selected.value = task;historyToken++;history.value=[];historyCursor.value=null;
  const scope=scopeEpoch, workspaceId=props.workspaceId, taskApi=api.value;
  try {const detail = await taskApi.detail(task.id);if (scope===scopeEpoch && workspaceId===props.workspaceId && selectedId.value === task.id) selected.value = detail.task;}
  catch(e) {if(scope===scopeEpoch && selectedId.value===task.id)handleError(e,"关联任务已不可用");}
  void loadHistory();}
async function loadHistory(more=false) {const id=selectedId.value;if (!id) return;historyLoading.value=true;const token=++historyToken;
  const scope=scopeEpoch,workspaceId=props.workspaceId,taskApi=api.value;
  try {const page=await taskApi.history(id,{result:resultFilter.value,triggerType:triggerFilter.value,...(more && historyCursor.value ? {cursor:historyCursor.value} : {})});
    if (id!==selectedId.value || token!==historyToken || scope!==scopeEpoch || workspaceId!==props.workspaceId) return;history.value=more?[...history.value,...page.items]:page.items;historyCursor.value=page.nextCursor;
  }catch(e){if (token===historyToken && scope===scopeEpoch) {
    if(more && e instanceof ScheduledApiError && e.code === "CURSOR_INVALID") {
      setNotice(scheduledErrorPresentation(e).text,"error");historyCursor.value=null;history.value=[];
      void loadHistory();
    } else handleError(e,"加载历史失败");
  }}finally{if (token === historyToken && scope===scopeEpoch) historyLoading.value=false;}}
function resetHistory(){historyCursor.value=null;history.value=[];void loadHistory();}
function openCreate(){if(writesDisabled.value)return;editing.value=null;drawerOpen.value=true;void loadAgents();}
function openEdit(){if(writesDisabled.value)return;editing.value=selected.value;drawerOpen.value=true;void loadAgents();}
function closeDrawer(){drawerOpen.value=false;editing.value=null;}
function onSaved(task:ScheduledTask){if(task.workspaceId!==props.workspaceId)return;const wasEditing=Boolean(editing.value);closeDrawer();if(wasEditing)void refreshList();else resetList();void selectTask(task);}
async function toggleEnabled(){if (!selected.value || writesDisabled.value)return;
  const scope=scopeEpoch,id=selected.value.id,workspaceId=props.workspaceId,taskApi=api.value;
  busy.value=true;try{const {task}=await taskApi.setEnabled(id,!selected.value.enabled);if(scope!==scopeEpoch || workspaceId!==props.workspaceId)return;selected.value=task;void refreshList();}
  catch(e){if(scope===scopeEpoch)handleError(e,"操作失败");}finally{if(scope===scopeEpoch)busy.value=false;}}
async function runNow(){if(!selected.value || writesDisabled.value)return;
  const scope=scopeEpoch,id=selected.value.id,workspaceId=props.workspaceId,taskApi=api.value;
  busy.value=true;try{const {execution}=await taskApi.run(id);if(scope!==scopeEpoch || workspaceId!==props.workspaceId)return;
    setNotice(execution.status==="starting"?"已提交，正在确认运行状态":"已提交运行","info");resetHistory();void refreshList();}
  catch(e){if(scope!==scopeEpoch)return;handleError(e,"运行失败");if(e instanceof ScheduledApiError && e.executionId)resetHistory();}
  finally{if(scope===scopeEpoch)busy.value=false;}}
function confirmDelete(){const id=selected.value?.id;if(!id || writesDisabled.value)return;
  const scope=scopeEpoch,workspaceId=props.workspaceId,taskApi=api.value;
  Modal.confirm({title:"删除定时任务？",content:"执行历史将删除，已有 Agent Session 与 Run 会保留。",okText:"删除",okType:"danger",cancelText:"取消",onOk:async()=>{
    if(scope!==scopeEpoch || workspaceId!==props.workspaceId || writesDisabled.value)return;
    try{await taskApi.delete(id);if(scope!==scopeEpoch)return;discardSelection();resetList();setNotice("任务已删除","success");}
    catch(e){if(scope===scopeEpoch)handleError(e,"删除失败");}
  }});
}
async function openSession(sessionId:string|null){if(!sessionId)return;const scope=scopeEpoch,workspaceId=props.workspaceId;
  try{const sessions=await listAgentSessions(workspaceId);if(scope!==scopeEpoch || workspaceId!==props.workspaceId)return;
    if(!sessions.some((s)=>s.id===sessionId)){setNotice("关联会话已不可用","error");return;}host.call("agent",{type:"openSession",payload:{sessionId}});
  }catch{if(scope===scopeEpoch)setNotice("关联会话已不可用","error");}}
let active=true;
function visibilityChanged(){clockPoller.setVisible(active && !document.hidden);}
onMounted(()=>{active=true;clockPoller.setVisible(!document.hidden);document.addEventListener("visibilitychange",visibilityChanged);
  void loadList();void loadAgents();refreshTimer=setInterval(()=>{if(active && !document.hidden){void refreshList();if(selectedId.value)void loadHistory();}},30000);});
onActivated(()=>{active=true;if(!document.hidden)clockPoller.setVisible(true);});
onDeactivated(()=>{active=false;clockPoller.setVisible(false);});
onBeforeUnmount(()=>{clockPoller.dispose();document.removeEventListener("visibilitychange",visibilityChanged);if(searchTimer)clearTimeout(searchTimer);if(refreshTimer)clearInterval(refreshTimer);});
watch(()=>props.workspaceId,()=>{scopeEpoch++;listToken++;historyToken++;if(searchTimer)clearTimeout(searchTimer);
  closeDrawer();discardSelection();tasks.value=[];agents.value=[];readyAgentIds.value=[];search.value="";status.value="all";resultFilter.value="all";triggerFilter.value="all";
  nextCursor.value=null;historyCursor.value=null;busy.value=false;listLoading.value=false;historyLoading.value=false;writesDisabled.value=false;notice.value="";
  clockPoller.setVisible(false);clockPoller.setVisible(active && !document.hidden);
  void loadList();void loadAgents();});
</script>
<style scoped>
.scheduled-task-card { background: var(--panel-bg); color: inherit; cursor: pointer; transition: background-color .15s ease; }
.scheduled-task-card:hover {
  background: var(--fill-secondary);
  background: color-mix(in srgb, var(--panel-bg) 85%, var(--text-color) 15%);
}
.scheduled-task-card.is-selected { background: var(--fill-secondary); border-color: var(--border-color); }
.scheduled-task-card.is-selected:hover {
  background: var(--panel-bg-elevated);
  background: color-mix(in srgb, var(--fill-secondary) 80%, var(--text-color) 20%);
}
.detail-panel { border: 1px solid var(--border-color-secondary); border-radius: 4px; background: var(--panel-bg); }
.detail-panel-heading { display: flex; min-height: 2.75rem; align-items: center; justify-content: space-between; gap: .75rem; margin: 0; border-bottom: 1px solid var(--border-color-secondary); padding: .625rem 1rem; font-size: .9rem; font-weight: 600; }
.detail-label { font-size: .8rem; color: var(--text-tertiary); }
.scheduled-delete-button:not(:disabled):hover { color: var(--danger-color) !important; border-color: var(--danger-color) !important; }
.scheduled-task-tabs { --detail-inset: 1rem; margin-top: 1px; margin-inline: calc(-1 * var(--detail-inset)); }
.scheduled-task-tabs :deep(.ant-tabs-nav-wrap),
.scheduled-task-tabs :deep(.ant-tabs-content-holder) { padding-inline: var(--detail-inset); }
@media (min-width: 640px) {
  .scheduled-task-tabs { --detail-inset: 1.25rem; }
}
</style>
