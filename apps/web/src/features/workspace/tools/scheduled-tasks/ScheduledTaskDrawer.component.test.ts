import assert from "node:assert/strict";
import test from "node:test";
import { mount } from "@vue/test-utils";
import type { AxiosResponse } from "axios";
import ScheduledTaskDrawer from "./ScheduledTaskDrawer.vue";
import type { ScheduledTask } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api";

const drawer = {template:'<div :data-width="width"><slot name="extra" /><slot /><slot name="footer" /></div>',props:["open","title","width","closable"]};
const input = {template:'<input :value="value" @input="$emit(\'update:value\', $event.target.value)" @change="$emit(\'change\', $event)" />',props:["value"],emits:["update:value","change"]};
const stubs = {"a-drawer":drawer,"a-input":input,"a-textarea":input,"a-select":{template:"<div><slot /></div>",props:["value","options"]},
  "a-time-picker":{template:"<input :value=\"value\" @input=\"$emit('update:value', $event.target.value)\" />",props:["value"],emits:["update:value"]},"a-switch":{template:"<input type=checkbox />"},"a-radio-group":{template:"<div><slot /></div>"},"a-radio":{template:"<span><slot /></span>"},"a-radio-button":{template:"<span><slot /></span>"},
  "a-button":{template:"<button :disabled=\"disabled\" @click=\"$emit('click')\"><slot /></button>",props:["disabled"]},"a-tag":{template:"<span><slot /></span>"},"a-alert":{template:"<span />"}};
function task(schedule: ScheduledTask["schedule"]): ScheduledTask {
  return {id:"task",workspaceId:"workspace",name:"demo",enabled:true,prompt:"prompt",agentId:"agent",schedule,triggerMode:"fork_message",
    nextRunAt:5000,source:{sessionId:"session",messageId:"message",title:"source",messageSummary:"summary",messageCreatedAt:1000},latestExecution:null,latestScheduledExecution:null,activeExecution:null,createdAt:0,updatedAt:0};
}
test("creation form follows the prototype's four sections and keeps inputs empty",async()=>{
  const wrapper=mount(ScheduledTaskDrawer,{props:{open:true,task:null,workspaceId:"workspace",agents:[],readyAgentIds:[]},global:{stubs}});
  assert.equal(wrapper.get("[data-width]").attributes("data-width"),"min(100vw, 920px)");
  assert.equal(wrapper.findAll("h3.text-base").length,4);
  const headings=wrapper.findAll("h3").map((heading)=>heading.text());
  assert.deepEqual(headings,["1基本信息","2执行上下文","3任务指令与 Agent","4执行计划"]);
  assert.equal(wrapper.findAll(".context-card").length,2);
  assert.match(wrapper.get('[aria-label="执行计划预览"]').text(),/每天 09:00/);
  assert.equal((wrapper.get('[aria-label="任务名称"]').element as HTMLInputElement).value,"");
  assert.equal((wrapper.get('[aria-label="任务 Prompt"]').element as HTMLInputElement).value,"");
  assert.equal(wrapper.findAll('[aria-label="来源 Session ID"]').length,0);
  assert.match(wrapper.text(),/创建任务/);
  wrapper.unmount();
});
test("daily schedule allows adding another time without replacing an existing slot",async()=>{
  const wrapper=mount(ScheduledTaskDrawer,{props:{open:true,task:null,workspaceId:"workspace",agents:[],readyAgentIds:[]},global:{stubs}});
  await wrapper.get('[aria-label="每日添加时间"]').setValue("12:30");
  await wrapper.findAll("button").find((button)=>button.text().includes("添加时间"))!.trigger("click");
  assert.match(wrapper.get('[aria-label="执行计划预览"]').text(),/09:00、12:30/);
  wrapper.unmount();
});
test("editing non-factorizable weekly schedule presents pair editor without generating cross product",async()=>{
  const wrapper=mount(ScheduledTaskDrawer,{props:{open:true,task:task({kind:"weekly",slotsUtc:[{weekdayUtc:1,minuteOfDayUtc:540},{weekdayUtc:2,minuteOfDayUtc:600}]}),workspaceId:"workspace",agents:[],readyAgentIds:["agent"]},global:{stubs}});
  assert.match(wrapper.text(),/逐条编辑/);
  assert.equal(wrapper.findAll('[aria-label="成对星期"]').length,2);
  wrapper.unmount();
});
test("fork save requires fresh validation and changes to either ID revoke it",async()=>{
  const adapter=apiClient.defaults.adapter;
  const source=task({kind:"daily",minutesOfDayUtc:[540]}).source;
  apiClient.defaults.adapter=(async(config)=>({data:{source},status:200,statusText:"OK",headers:{},config})) as typeof adapter;
  try {
    const wrapper=mount(ScheduledTaskDrawer,{props:{open:true,task:task({kind:"daily",minutesOfDayUtc:[540]}),workspaceId:"workspace",agents:[],readyAgentIds:["agent"]},global:{stubs}});
    const save=()=>wrapper.findAll("button").find((button)=>button.text()==="保存")!;
    assert.equal(save().attributes("disabled")!==undefined,true);
    assert.match(wrapper.text(),/复制 Session ID/);
    await wrapper.findAll("button").find((button)=>button.text()==="校验并加载")!.trigger("click");
    await new Promise((resolve)=>setImmediate(resolve));
    assert.equal(save().attributes("disabled"),undefined);
    await wrapper.find('[aria-label="来源 Message ID"]').setValue("new-message");
    assert.equal(save().attributes("disabled")!==undefined,true);
    wrapper.unmount();
  } finally {apiClient.defaults.adapter=adapter;}
});
test("workspace switch invalidates in-flight source validation and erases old private inputs",async()=>{
  const adapter=apiClient.defaults.adapter;
  let complete!: (value:AxiosResponse)=>void;
  apiClient.defaults.adapter=(()=>new Promise((resolve)=>{complete=resolve;})) as typeof adapter;
  try {
    const first=task({kind:"daily",minutesOfDayUtc:[540]});
    const wrapper=mount(ScheduledTaskDrawer,{props:{open:true,task:first,workspaceId:"workspace-a",agents:[],readyAgentIds:["agent"]},global:{stubs}});
    await wrapper.findAll("button").find((button)=>button.text()==="校验并加载")!.trigger("click");
    const next={...first,workspaceId:"workspace-b",source:{...first.source!,sessionId:"session-b",messageId:"message-b"}};
    await wrapper.setProps({workspaceId:"workspace-b",task:next});
    assert.equal((wrapper.find('[aria-label="来源 Session ID"]').element as HTMLInputElement).value,"session-b");
    complete({data:{source:{...first.source,title:"PRIVATE_A",messageSummary:"PRIVATE_BODY_A"}},status:200,statusText:"OK",headers:{},config:{}} as AxiosResponse);
    await new Promise((resolve)=>setImmediate(resolve));
    assert.doesNotMatch(wrapper.text(),/PRIVATE_A|PRIVATE_BODY_A/);
    assert.equal(wrapper.findAll("button").find((button)=>button.text()==="保存")!.attributes("disabled")!==undefined,true);
    wrapper.unmount();
  } finally {apiClient.defaults.adapter=adapter;}
});
test("preview recalculates when the injected clock advances",async()=>{
  const wrapper=mount(ScheduledTaskDrawer,{props:{open:true,task:null,workspaceId:"workspace",agents:[],readyAgentIds:["agent"],now:Date.UTC(2025,0,1,8,59)},global:{stubs}});
  const before=wrapper.text();
  await wrapper.setProps({now:Date.UTC(2025,0,1,9,1)});
  assert.notEqual(wrapper.text(),before);
  const explanation=wrapper.get('[aria-label="计划规则说明"]').text();
  assert.match(explanation,/本地时间设置/);
  assert.match(explanation,/保存后计划固定/);
  assert.match(explanation,/时区.*夏令时.*执行时间或星期可能变化/);
  assert.doesNotMatch(explanation,/UTC|固定.*偏移/);
  assert.match(wrapper.text(),/夏令时/);
  wrapper.unmount();
});
test("editing only task metadata sends unchanged UTC schedule in full PUT",async()=>{
  const adapter = apiClient.defaults.adapter;
  let sent: Record<string,unknown> | null = null;
  const original = {...task({kind:"daily",minutesOfDayUtc:[1125]}),triggerMode:"new_session" as const,source:null};
  apiClient.defaults.adapter = (async(config)=>{
    if (config.method === "put") sent = JSON.parse(String(config.data));
    return {data:config.method === "put" ? {task:original} : {source:original.source},status:200,statusText:"OK",headers:{},config};
  }) as typeof adapter;
  try {
    const wrapper=mount(ScheduledTaskDrawer,{props:{open:true,task:original,workspaceId:"workspace",agents:[],readyAgentIds:["agent"]},global:{stubs}});
    await wrapper.findAll("button").find((button)=>button.text()==="保存")!.trigger("click");
    await new Promise((resolve)=>setImmediate(resolve));
    assert.deepEqual((sent as Record<string,unknown> | null)?.schedule,original.schedule);
    assert.equal((sent as Record<string,unknown> | null)?.enabled,undefined);
    wrapper.unmount();
  } finally { apiClient.defaults.adapter = adapter; }
});

test("an Agent excluded by the authoritative ready check cannot be saved", async () => {
  const original = { ...task({kind:"daily", minutesOfDayUtc:[540]}),triggerMode:"new_session" as const,source:null };
  const wrapper = mount(ScheduledTaskDrawer,{props:{open:true,task:original,workspaceId:"workspace",agents:[],readyAgentIds:[]},global:{stubs}});
  const save = () => wrapper.findAll("button").find((button) => button.text() === "保存")!;
  assert.notEqual(save().attributes("disabled"),undefined);
  await wrapper.setProps({readyAgentIds:["agent"]});
  assert.equal(save().attributes("disabled"),undefined);
  wrapper.unmount();
});
test("closing drawer clears historical source validation",async()=>{
  const adapter = apiClient.defaults.adapter;
  apiClient.defaults.adapter = (async(config)=>({data:{source:task({kind:"daily",minutesOfDayUtc:[540]}).source},status:200,statusText:"OK",headers:{},config})) as typeof adapter;
  try {
  const wrapper=mount(ScheduledTaskDrawer,{props:{open:true,task:task({kind:"daily",minutesOfDayUtc:[540]}),workspaceId:"workspace",agents:[],readyAgentIds:["agent"]},global:{stubs}});
  assert.doesNotMatch(wrapper.text(),/summary/);
  await wrapper.findAll("button").find((button)=>button.text()==="校验并加载")!.trigger("click");
  await new Promise((resolve)=>setImmediate(resolve));
  assert.match(wrapper.text(),/summary/);
  await wrapper.setProps({open:false});
  assert.doesNotMatch(wrapper.text(),/summary/);
  wrapper.unmount();
  } finally { apiClient.defaults.adapter = adapter; }
});
