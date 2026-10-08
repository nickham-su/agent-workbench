<template>
  <a-drawer
    :open="open"
    :title="task ? '编辑定时任务' : '创建定时任务'"
    width="min(100vw, 920px)"
    :closable="false"
    :body-style="{ padding: 0 }"
    @close="emit('close')"
  >
    <template #extra>
      <a-button type="text" aria-label="关闭表单" @click="emit('close')"><CloseOutlined /></a-button>
    </template>
    <div class="space-y-6 px-4 py-5 pb-8 text-sm text-[var(--text-primary)] sm:px-6 sm:py-6">
      <section aria-labelledby="task-basic-heading" class="space-y-4">
        <h3 id="task-basic-heading" class="m-0 flex items-center gap-2 text-base font-semibold"><span class="section-number">1</span>基本信息</h3>
        <label class="block space-y-2 font-medium"><span><span class="text-red-500">*</span> 任务名称</span>
          <a-input v-model:value="form.name" :maxlength="400" size="middle" aria-label="任务名称" placeholder="为任务起个名字" />
        </label>
        <label v-if="!task" class="flex items-center gap-3 font-medium">
          <a-switch v-model:checked="form.enabled" aria-label="创建后立即启用" />创建后立即启用
        </label>
      </section>

      <section aria-labelledby="task-context-heading" class="space-y-4">
        <h3 id="task-context-heading" class="m-0 flex items-center gap-2 text-base font-semibold"><span class="section-number">2</span>执行上下文</h3>
        <a-radio-group v-model:value="form.triggerMode" class="!grid !w-full grid-cols-1 gap-3 md:grid-cols-2" @change="clearSource">
          <a-radio value="new_session" class="context-card" :class="form.triggerMode === 'new_session' ? 'context-card-active' : ''">
            <span class="block font-semibold">＋ 新建 Session</span>
            <span class="mt-1 block text-xs leading-relaxed text-[var(--text-tertiary)]">每次从空白 Session 开始，仅使用下方 Prompt。</span>
          </a-radio>
          <a-radio value="fork_message" class="context-card" :class="form.triggerMode === 'fork_message' ? 'context-card-active' : ''">
            <span class="block font-semibold">基于历史消息</span>
            <span class="mt-1 block text-xs leading-relaxed text-[var(--text-tertiary)]">每次执行时，从现有会话的指定消息 Fork 出新会话，再追加任务 Prompt 并开始执行。</span>
          </a-radio>
        </a-radio-group>
        <div v-if="form.triggerMode === 'fork_message'" class="space-y-3 border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-3 sm:p-4">
          <div class="grid gap-4 md:grid-cols-2">
            <label class="block space-y-2 font-medium"><span><span class="text-red-500">*</span> Session ID</span>
              <a-input v-model:value="form.sourceSessionId" size="middle" aria-label="来源 Session ID" @update:value="clearSource" />
            </label>
            <label class="block space-y-2 font-medium"><span><span class="text-red-500">*</span> Message ID</span>
              <a-input v-model:value="form.sourceMessageId" size="middle" aria-label="来源 Message ID" @update:value="clearSource" />
            </label>
          </div>
          <div class="flex flex-wrap items-center gap-3">
            <a-button :loading="validating" :disabled="!form.sourceSessionId.trim() || !form.sourceMessageId.trim()" @click="validateSource">校验并加载</a-button>
            <p class="m-0 text-xs text-[var(--text-tertiary)]">请从 Agent 会话视图复制 Session ID 和 Message ID。</p>
          </div>
          <div v-if="sourceValidation" class="space-y-1 text-sm" aria-label="来源消息摘要">
            <div>{{ sourceValidation.title }} · {{ new Date(sourceValidation.messageCreatedAt).toLocaleString() }}</div>
            <div class="whitespace-pre-wrap break-words text-[var(--text-tertiary)]">{{ [...sourceValidation.messageSummary].slice(0, 500).join('') }}</div>
          </div>
        </div>
      </section>

      <section aria-labelledby="task-instructions-heading" class="space-y-4">
        <h3 id="task-instructions-heading" class="m-0 flex items-center gap-2 text-base font-semibold"><span class="section-number">3</span>任务指令与 Agent</h3>
        <div class="space-y-2">
          <label for="scheduled-task-prompt" class="block font-medium"><span class="text-red-500">*</span> 每次执行追加的 Prompt</label>
          <a-textarea id="scheduled-task-prompt" v-model:value="form.prompt" :rows="4" :maxlength="20000" aria-label="任务 Prompt" placeholder="输入每次执行时发送给 Agent 的任务指令" />
          <p v-if="form.triggerMode === 'fork_message'" class="m-0 text-xs text-[var(--text-tertiary)]">此 Prompt 会在所选历史消息上下文之后发送。</p>
        </div>
        <div class="max-w-[520px] space-y-2">
          <label for="scheduled-task-agent" class="block font-medium">Agent</label>
          <a-select id="scheduled-task-agent" v-model:value="form.agentId" class="w-full" size="middle" :options="agentOptions" placeholder="选择可用 Agent" aria-label="Agent" />
          <p class="m-0 text-xs text-[var(--text-tertiary)]">执行时使用该 Agent 已配置的默认模型。</p>
        </div>
      </section>

      <section aria-labelledby="task-schedule-heading" class="space-y-4">
        <h3 id="task-schedule-heading" class="m-0 flex items-center gap-2 text-base font-semibold"><span class="section-number">4</span>执行计划</h3>
        <a-radio-group v-model:value="scheduleKind" button-style="solid" aria-label="计划周期" @change="changeKind">
          <a-radio-button value="hourly">每小时</a-radio-button>
          <a-radio-button value="daily">每天</a-radio-button>
          <a-radio-button value="weekly">每周</a-radio-button>
        </a-radio-group>
        <div class="space-y-3 border border-[var(--border-color-secondary)] bg-[var(--panel-bg-elevated)] p-3 sm:p-4">
          <template v-if="editor.kind === 'hourly'">
            <label class="block space-y-2 font-medium"><span>执行分钟（可添加多个）</span>
              <a-select v-model:value="editor.minutes" mode="multiple" class="w-full max-w-[520px]" :options="minuteOptions" placeholder="选择每小时的分钟" aria-label="每小时的分钟" />
            </label>
          </template>
          <template v-else-if="editor.kind === 'daily'">
            <div class="font-medium">执行时间（可添加多个）</div>
            <div class="flex flex-wrap items-center gap-2">
              <a-tag v-for="minute in editor.minutesOfDay" :key="minute" class="!m-0 !border-blue-500 !px-2 !py-0.5 !text-blue-500" closable @close="removeDailyTime(minute)">{{ formatMinute(minute) }}</a-tag>
              <a-time-picker v-model:value="timeInput" format="HH:mm" value-format="HH:mm" placeholder="选择时间" aria-label="每日添加时间" />
              <a-button :disabled="!timeInput" @click="addDailyTime(timeInput ?? '')">＋ 添加时间</a-button>
            </div>
          </template>
          <template v-else-if="editor.mode === 'grid'">
            <label class="block space-y-2 font-medium"><span>星期（可多选）</span>
              <a-select v-model:value="editor.weekdays" mode="multiple" class="w-full max-w-[520px]" :options="weekdayOptions" aria-label="星期" />
            </label>
            <div class="font-medium">共用时间（可添加多个）</div>
            <div class="flex flex-wrap items-center gap-2">
              <a-tag v-for="minute in editor.times" :key="minute" class="!m-0 !border-blue-500 !px-2 !py-0.5 !text-blue-500" closable @close="removeGridTime(minute)">{{ formatMinute(minute) }}</a-tag>
              <a-time-picker v-model:value="timeInput" format="HH:mm" value-format="HH:mm" placeholder="选择时间" aria-label="每周添加共用时间" />
              <a-button :disabled="!timeInput" @click="addGridTime(timeInput ?? '')">＋ 添加时间</a-button>
            </div>
            <a-button size="small" @click="switchToPairs">按星期与时间成对编辑</a-button>
          </template>
          <template v-else>
            <p class="m-0 text-xs text-[var(--text-tertiary)]">此计划的星期和时间并非完整组合；逐条编辑，避免生成额外计划。</p>
            <div v-for="(slot, index) in editor.slots" :key="index" class="flex flex-wrap items-center gap-2">
              <a-select v-model:value="slot.weekday" :options="weekdayOptions" class="w-32" aria-label="成对星期" />
              <a-time-picker :value="formatMinute(slot.minuteOfDay)" format="HH:mm" value-format="HH:mm" @change="(value: string) => setPairTime(index, value)" />
              <a-button aria-label="删除时间槽" @click="editor.kind === 'weekly' && editor.mode === 'pairs' && editor.slots.splice(index, 1)">删除</a-button>
            </div>
            <a-button @click="editor.kind === 'weekly' && editor.mode === 'pairs' && editor.slots.push({weekday:1,minuteOfDay:540})">＋ 添加时间槽</a-button>
          </template>
        </div>
        <div v-if="schedulePreview.length" class="space-y-2 border border-[var(--border-color-secondary)] bg-blue-500/10 p-3 sm:p-4" aria-label="执行计划预览">
          <h4 class="m-0 font-semibold">执行计划预览</h4>
          <p class="m-0">{{ scheduleSummary }} 执行</p>
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-blue-500"><span v-for="(time, i) in schedulePreview" :key="i">{{ time }}</span></div>
        </div>
        <p aria-label="计划规则说明" class="m-0 text-xs text-[var(--text-tertiary)]">按当前设备的本地时间设置计划；保存后计划固定。切换设备时区或发生夏令时变化后，本地显示的执行时间或星期可能变化。</p>
      </section>
      <a-alert v-if="error" type="error" :message="error" show-icon />
    </div>
    <template #footer>
      <div class="flex justify-end gap-2"><a-button @click="emit('close')">取消</a-button><a-button type="primary" :loading="submitting" :disabled="!canSave || submitting" @click="save">{{ task ? '保存' : '创建任务' }}</a-button></div>
    </template>
  </a-drawer>
</template>
<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { CloseOutlined } from "@ant-design/icons-vue";
import type { AgentItemView, CreateScheduledTaskRequest, ScheduledSource, ScheduledTask, UtcSchedule } from "@agent-workbench/shared";
import { scheduledApi } from "./scheduledApi";
import { scheduledErrorPresentation } from "./scheduledUi";
import { editorToUtc, formatMinute, nextThreePreview, parseMinute, summarize, toLocalEditor, WEEKDAYS, type ScheduleEditor } from "./scheduleEditor";

const props = defineProps<{open: boolean; task: ScheduledTask | null; workspaceId: string; agents: AgentItemView[]; readyAgentIds: string[]; now?: number; writesDisabled?: boolean}>();
const emit = defineEmits<{(event:"close"):void; (event:"saved", task:ScheduledTask):void; (event:"errorAction", action:"refreshList" | "stopWrites"):void}>();
const api = computed(() => scheduledApi(props.workspaceId));
const agentOptions = computed(() => props.agents.filter((agent) => props.readyAgentIds.includes(agent.id))
  .map((agent) => ({value:agent.id,label:agent.name})));
const form = reactive({ name:"", prompt:"", agentId:"", enabled:true, triggerMode:"new_session" as "new_session" | "fork_message", sourceSessionId:"", sourceMessageId:"" });
const editor = ref<ScheduleEditor>({kind:"daily",minutesOfDay:[540]});
let initialEditor = "";
const scheduleKind = ref<ScheduleEditor["kind"]>("daily");
const minuteOptions = Array.from({length:60}, (_, i) => ({value:i,label:`${String(i).padStart(2,"0")} 分`}));
const weekdayOptions = WEEKDAYS.map((label,value) => ({label,value}));
const timeInput = ref<string>();
const sourceValidation = ref<ScheduledSource | null>(null);
let validationEpoch = 0;
let scopeEpoch = 0;
const validating = ref(false);
const submitting = ref(false);
const error = ref("");
watch(() => [props.workspaceId, props.open, props.task?.id] as const, () => {
  scopeEpoch++;
  validationEpoch++;
  validating.value = false;
  submitting.value = false;
  sourceValidation.value = null; error.value = ""; timeInput.value = undefined;
  if (!props.open) return;
  const task = props.task;
  Object.assign(form, {name:task?.name ?? "",prompt:task?.prompt ?? "",agentId:task?.agentId ?? "", enabled:true,
    triggerMode:task?.triggerMode ?? "new_session",sourceSessionId:task?.source?.sessionId ?? "", sourceMessageId:task?.source?.messageId ?? ""});
  editor.value = task ? toLocalEditor(task.schedule, new Date().getTimezoneOffset()) : {kind:"daily",minutesOfDay:[540]};
  initialEditor = JSON.stringify(editor.value);
  scheduleKind.value = editor.value.kind;
}, {immediate:true});
function clearSource() { validationEpoch++; validating.value = false; sourceValidation.value = null; }
function changeKind() {
  timeInput.value = undefined;
  editor.value = scheduleKind.value === "hourly" ? {kind:"hourly",minutes:[0]} : scheduleKind.value === "daily" ? {kind:"daily",minutesOfDay:[540]} : {kind:"weekly",mode:"grid",weekdays:[1],times:[540]};
}
function addDailyTime(v: string) { const minute = parseMinute(v); if (editor.value.kind === "daily" && minute !== null) editor.value.minutesOfDay = [...new Set([...editor.value.minutesOfDay, minute])].sort((a,b)=>a-b); timeInput.value = undefined; }
function removeDailyTime(v:number) { if (editor.value.kind === "daily") editor.value.minutesOfDay = editor.value.minutesOfDay.filter((n)=>n!==v); }
function addGridTime(v: string) { const minute = parseMinute(v); if (editor.value.kind === "weekly" && editor.value.mode === "grid" && minute !== null) editor.value.times = [...new Set([...editor.value.times, minute])].sort((a,b)=>a-b); timeInput.value = undefined; }
function removeGridTime(v:number) { if (editor.value.kind === "weekly" && editor.value.mode === "grid") editor.value.times = editor.value.times.filter((n)=>n!==v); }
function switchToPairs() { if (editor.value.kind === "weekly" && editor.value.mode === "grid") editor.value = {kind:"weekly",mode:"pairs",slots:editor.value.weekdays.flatMap((weekday)=>editor.value.kind === "weekly" && editor.value.mode === "grid" ? editor.value.times.map((minuteOfDay)=>({weekday,minuteOfDay})) : [])}; }
function setPairTime(i:number,v:string) { const minute = parseMinute(v); if (minute !== null && editor.value.kind === "weekly" && editor.value.mode === "pairs" && editor.value.slots[i]) editor.value.slots[i]!.minuteOfDay = minute; }
const utcPreview = computed<UtcSchedule | null>(() => { try { return props.task && JSON.stringify(editor.value) === initialEditor ? props.task.schedule : editorToUtc(editor.value, new Date().getTimezoneOffset()); } catch { return null; } });
const scheduleSummary = computed(() => utcPreview.value ? summarize(utcPreview.value, new Date().getTimezoneOffset()) : "请选择至少一个有效时间槽");
const schedulePreview = computed(() => utcPreview.value ? nextThreePreview(utcPreview.value, props.now ?? Date.now(), (date) => {
  const today = new Date(props.now ?? Date.now());
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const time = date.toLocaleTimeString(undefined, {hour:"2-digit", minute:"2-digit", hour12:false});
  if (date.toDateString() === today.toDateString()) return `今天 ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${time}`;
  return `${date.toLocaleDateString()} ${time}`;
}) : []);
const canSave = computed(() => props.open && !props.writesDisabled && props.readyAgentIds.includes(form.agentId) &&
  (form.triggerMode !== "fork_message" || Boolean(sourceValidation.value &&
  sourceValidation.value.sessionId === form.sourceSessionId.trim() && sourceValidation.value.messageId === form.sourceMessageId.trim())));
async function validateSource() {
  const sessionId = form.sourceSessionId.trim(), messageId = form.sourceMessageId.trim();
  const workspaceId = props.workspaceId, scope = scopeEpoch, taskApi = api.value;
  const epoch = ++validationEpoch;
  sourceValidation.value = null; validating.value = true; error.value = "";
  try {
    const {source} = await taskApi.validateSource(sessionId, messageId);
    if (scope === scopeEpoch && workspaceId === props.workspaceId && epoch === validationEpoch && form.sourceSessionId.trim() === sessionId && form.sourceMessageId.trim() === messageId && props.open && form.triggerMode === "fork_message") sourceValidation.value = source;
  } catch (e) { if (scope === scopeEpoch && epoch === validationEpoch) {
    const presentation = scheduledErrorPresentation(e);
    error.value = presentation.text;
    if (presentation.action === "refreshList" || presentation.action === "stopWrites") emit("errorAction", presentation.action);
  } }
  finally { if (scope === scopeEpoch && epoch === validationEpoch) validating.value = false; }
}
async function save() {
  if (!canSave.value || submitting.value) return;
  error.value = "";
  if (!form.name.trim() || !form.prompt.trim() || !form.agentId) { error.value = "请填写名称、Prompt 和 Agent"; return; }
  if (form.triggerMode === "fork_message" && (!sourceValidation.value || sourceValidation.value.sessionId !== form.sourceSessionId.trim() || sourceValidation.value.messageId !== form.sourceMessageId.trim())) { error.value = "请先校验来源消息"; return; }
  // Capture the offset exactly once for this submission. Do not use the preview's offset.
  const offset = new Date().getTimezoneOffset();
  let schedule: UtcSchedule;
  try { schedule = props.task && JSON.stringify(editor.value) === initialEditor ? props.task.schedule : editorToUtc(editor.value, offset); } catch { error.value = "请选择至少一个有效时间槽"; return; }
  const body = {name:form.name,prompt:form.prompt,agentId:form.agentId,triggerMode:form.triggerMode,schedule,
    sourceSessionId: form.triggerMode === "fork_message" ? form.sourceSessionId.trim() : null,
    sourceMessageId: form.triggerMode === "fork_message" ? form.sourceMessageId.trim() : null};
  submitting.value = true;
  const scope = scopeEpoch, workspaceId = props.workspaceId, taskApi = api.value, taskId = props.task?.id;
  try { const {task} = taskId ? await taskApi.replace(taskId, body) : await taskApi.create({...body,enabled:form.enabled} satisfies CreateScheduledTaskRequest);
    if (scope === scopeEpoch && workspaceId === props.workspaceId && props.open) { emit("saved",task); message.success("任务已保存"); }
  }
  catch (e) { if (scope === scopeEpoch) { const presentation = scheduledErrorPresentation(e); error.value = presentation.text;
    if (presentation.action === "revalidateSource") clearSource();
    if (presentation.action === "refreshList" || presentation.action === "stopWrites") emit("errorAction", presentation.action);
  } }
  finally { if (scope === scopeEpoch) submitting.value = false; }
}
</script>
<style scoped>
.section-number {
  display: inline-flex;
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgb(22 119 255 / 16%);
  color: #1677ff;
  font-size: .8rem;
}
.context-card { display: flex !important; width: 100%; min-height: 5.5rem; box-sizing: border-box; align-items: flex-start; margin: 0 !important; border: 1px solid var(--border-color-secondary); border-radius: 6px; padding: .75rem; }
.context-card-active { border-color: #1677ff; background: rgb(22 119 255 / 9%); }
.context-card :deep(.ant-radio) { margin-top: .25rem; }
.context-card :deep(.ant-radio + span) { flex: 1; min-width: 0; }
</style>
