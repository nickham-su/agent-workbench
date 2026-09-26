import assert from "node:assert/strict";
import test from "node:test";
import { mount } from "@vue/test-utils";
import type { ScheduledTask } from "@agent-workbench/shared";
import { apiClient } from "@/shared/api";
import { workspaceHostKey } from "@/features/workspace/host";
import ScheduledTasksToolView from "./ScheduledTasksToolView.vue";

const stubs={
  "a-button":{template:"<button :disabled='disabled' @click=\"$emit('click')\"><slot /></button>",props:["disabled"]},
  "a-input":{template:"<input :value='value' @input=\"$emit('update:value', $event.target.value)\" />",props:["value"]},
  "a-select":{template:"<div><slot /></div>",props:["value","options"]},
  "a-tooltip":{template:"<span><slot /></span>"},"a-tag":{template:"<span><slot /></span>"},
  "a-tabs":{template:"<div><slot /></div>"},"a-tab-pane":{template:"<div><slot /></div>"},
  "a-empty":{template:"<span>{{description}}</span>",props:["description"]},"a-spin":{template:"<span />"},"a-alert":{template:"<span />"},
  ScheduledTaskDrawer:{template:"<div data-testid='drawer' :data-open='String(open)' :data-workspace='workspaceId' :data-task='task?.id || \"\"' />",props:["open","workspaceId","task"]}
};
const tick=()=>new Promise((resolve)=>setImmediate(resolve));
function task(workspaceId:string,id:string):ScheduledTask {
  const active:ScheduledTask["activeExecution"] = id === "Second" ? {
    id:"active",taskId:id,triggerType:"manual",scheduledFor:null,status:"running",reasonCode:null,reasonMessage:null,
    sessionId:"session-active",sessionAvailable:true,runId:"run",createdAt:1,startedAt:1,finishedAt:null
  } : null;
  const skip:ScheduledTask["latestExecution"] = id === "Second" ? {
    id:"skip",taskId:id,triggerType:"scheduled",scheduledFor:2,status:"skipped",reasonCode:"previous_execution_running",reasonMessage:null,
    sessionId:null,sessionAvailable:false,runId:null,createdAt:2,startedAt:null,finishedAt:2
  } : null;
  return {id,workspaceId,name:`${id} private`,enabled:true,triggerMode:"new_session",prompt:"private prompt",agentId:"agent",schedule:{kind:"daily",minutesOfDayUtc:[540]},nextRunAt:Date.now()+10000,source:null,latestExecution:skip,latestScheduledExecution:skip,activeExecution:active,createdAt:1,updatedAt:1};
}
function fakeHost(){return {openTool(){},minimizeTool(){},toggleMinimize(){},callFrom(){},setToolDot(){},registerToolCommands(){return ()=>{};},emitToolEvent(){}};}

test("refresh retains second-page selection and Workspace switch ignores old detail and resets Drawer",async()=>{
  const adapter=apiClient.defaults.adapter;
  const interval=globalThis.setInterval, clear=globalThis.clearInterval;
  const timers=new Map<ReturnType<typeof setInterval>,{fn:()=>void;ms:number}>();
  globalThis.setInterval=((fn:()=>void,ms:number)=>{const id=interval(()=>{},ms);timers.set(id,{fn,ms});return id;}) as typeof setInterval;
  globalThis.clearInterval=((id:ReturnType<typeof setInterval>)=>{timers.delete(id);clear(id);}) as typeof clearInterval;
  let completeOldDetail!: (response:unknown)=>void;
  let delayDetail=false;
  apiClient.defaults.adapter=(async(config)=>{
    const url=String(config.url),workspaceId=url.includes("workspace-b")?"workspace-b":"workspace-a";
    const ok=(data:unknown)=>({data,status:200,statusText:"OK",headers:{},config});
    if(url.endsWith("/server-time"))return ok({now:Date.now(),protocolVersion:1});
    if(url.endsWith("/ready-agents"))return ok({agentIds:["agent"]});
    if(url.includes("agents/available"))return ok({agents:[]});
    if(url.endsWith("/executions"))return ok({items: workspaceId === "workspace-b" ? [] : [{
      id:"failed",taskId:"Second",triggerType:"manual",scheduledFor:null,status:"failed_to_start",reasonCode:"agent_unavailable",reasonMessage:null,
      sessionId:"reserved",sessionAvailable:false,runId:null,createdAt:3,startedAt:null,finishedAt:4
    },{
      id:"completed",taskId:"Second",triggerType:"scheduled",scheduledFor:1,status:"completed",reasonCode:null,reasonMessage:null,
      sessionId:"session",sessionAvailable:true,runId:"run",createdAt:1,startedAt:1,finishedAt:192001
    },{
      id:"skipped",taskId:"Second",triggerType:"scheduled",scheduledFor:2,status:"skipped",reasonCode:"previous_execution_running",reasonMessage:null,
      sessionId:null,sessionAvailable:false,runId:null,createdAt:2,startedAt:null,finishedAt:2
    }],nextCursor:null});
    if(url.endsWith("/scheduled-tasks")) {
      if(workspaceId==="workspace-b")return ok({items:[task(workspaceId,"New")],nextCursor:null});
      if(config.params?.cursor)return ok({items:[task(workspaceId,"Second")],nextCursor:null});
      return ok({items:[task(workspaceId,"First")],nextCursor:"page-2"});
    }
    if(url.endsWith("/Second") && delayDetail)return new Promise((resolve)=>{completeOldDetail=(data)=>resolve(ok(data));});
    if(url.endsWith("/Second"))return ok({task:task(workspaceId,"Second")});
    if(url.endsWith("/New"))return ok({task:task(workspaceId,"New")});
    return ok({task:task(workspaceId,"First")});
  }) as typeof adapter;
  const wrapper=mount(ScheduledTasksToolView,{props:{workspaceId:"workspace-a",toolId:"scheduledTasks"},global:{stubs,provide:{[workspaceHostKey as symbol]:fakeHost()}}});
  try {
    await tick();await tick();
    assert.equal(wrapper.classes().includes("bg-[var(--panel-bg)]"),true);
    assert.equal(wrapper.findAll(".scheduled-task-card")[0]!.classes().includes("is-selected"),true);
    assert.match(wrapper.get("main h2").text(),/First private/);
    assert.doesNotMatch(wrapper.text(),/选择任务查看详情/);
    const createButton=wrapper.findAll("button").find((button)=>button.text()==="创建任务")!;
    assert.equal(createButton.classes().includes("!w-[108px]"),true);
    assert.equal(wrapper.get('[aria-label="任务状态"]').classes().includes("!w-[108px]"),true);
    await wrapper.findAll("button").find((button)=>button.text()==="加载更多")!.trigger("click");
    await tick();await tick();
    const firstCard=wrapper.findAll("button").find((button)=>button.text().includes("First private"))!;
    assert.equal(firstCard.classes().includes("scheduled-task-card"),true);
    assert.equal(firstCard.classes().includes("is-selected"),true);
    await wrapper.findAll("button").find((button)=>button.text().includes("Second private"))!.trigger("click");
    await tick();await tick();
    assert.equal(wrapper.get(".scheduled-task-tabs").classes().includes("mt-4"),false);
    assert.equal(wrapper.findAll("button").find((button)=>button.text().includes("Second private"))!.classes().includes("is-selected"),true);
    assert.equal(firstCard.classes().includes("is-selected"),false);
    assert.match(wrapper.text(),/Second private/);
    assert.match(wrapper.get('[aria-label="最近执行"]').text(),/已跳过/);
    assert.deepEqual(wrapper.findAll(".detail-panel-heading").map((heading)=>heading.text()),
      ["调度与运行","执行上下文新建 Session","每次执行追加的 Prompt"]);
    assert.equal(wrapper.get('[aria-label="任务列表"]').element.parentElement?.className.includes("370px"),true);
    const clockPanel=wrapper.get('[aria-label="时间同步状态"]');
    assert.doesNotMatch(clockPanel.text(),/服务端时间|设备时间/);
    assert.match(clockPanel.text(),/时间同步正常/);
    assert.equal(clockPanel.classes().includes("space-y-1"),true);
    assert.equal(clockPanel.get(".clock-health-dot").classes().includes("text-green-500"),true);
    assert.equal(clockPanel.get(".clock-health-label").classes().includes("text-[var(--text-color)]"),true);
    assert.match(wrapper.text(),/运行中/);
    const deleteButton=wrapper.findAll("button").find((button)=>button.text()==="删除")!;
    assert.equal(deleteButton.attributes("disabled")!==undefined,true);
    assert.match(deleteButton.classes().join(" "),/scheduled-delete-button/);
    assert.equal(deleteButton.attributes("danger"),undefined);
    assert.match(wrapper.text(),/Session 不可用/);
    const historyTable=wrapper.get('table[aria-label="执行历史列表"]');
    assert.deepEqual(historyTable.findAll("thead th").map((cell)=>cell.text()),
      ["计划时间","触发方式","状态","开始时间","耗时","关联会话"]);
    const historyRows=historyTable.findAll("tbody tr");
    assert.equal(historyRows.length,3);
    assert.equal(historyRows[0]!.findAll("td")[1]!.text(),"手动");
    assert.equal(historyRows[0]!.findAll("td")[3]!.text(),"—");
    assert.equal(historyRows[0]!.findAll("td")[4]!.text(),"—");
    assert.equal(historyRows[1]!.findAll("td")[4]!.text(),"3分12秒");
    assert.equal(historyRows[2]!.findAll("td")[5]!.text(),"—");
    assert.equal(historyRows[2]!.classes().includes("bg-[var(--fill-secondary)]"),true);
    assert.equal(historyRows[1]!.findAll("button").some((button)=>button.text()==="查看 Session ↗"),true);
    for(const timer of timers.values())if(timer.ms===30000)timer.fn();
    await tick();await tick();
    assert.match(wrapper.text(),/Second private/);
    assert.ok(wrapper.findAll("button").some((button)=>button.text().includes("Second private")));
    await wrapper.findAll("button").find((button)=>button.text()==="编辑")!.trigger("click");
    assert.equal(wrapper.get('[data-testid="drawer"]').attributes("data-open"),"true");
    assert.equal(wrapper.get('[data-testid="drawer"]').attributes("data-task"),"Second");
    delayDetail=true;
    await wrapper.findAll("button").find((button)=>button.text().includes("Second private"))!.trigger("click");
    await wrapper.setProps({workspaceId:"workspace-b"});
    completeOldDetail({task:task("workspace-a","Second")});
    await tick();await tick();
    assert.doesNotMatch(wrapper.text(),/Second private|First private/);
    assert.match(wrapper.text(),/New private/);
    assert.equal(wrapper.findAll(".scheduled-task-card")[0]!.classes().includes("is-selected"),true);
    assert.match(wrapper.get("main h2").text(),/New private/);
    assert.equal(wrapper.get('[data-testid="drawer"]').attributes("data-open"),"false");
    assert.equal(wrapper.get('[data-testid="drawer"]').attributes("data-task"),"");
    assert.equal(wrapper.get('[data-testid="drawer"]').attributes("data-workspace"),"workspace-b");
  }finally{
    wrapper.unmount();apiClient.defaults.adapter=adapter;globalThis.setInterval=interval;globalThis.clearInterval=clear;
    const remaining=timers.size;for(const id of timers.keys())clear(id);
    assert.equal(remaining,0,"unmount clears clock and refresh intervals");
  }
});

test("clock timer failure during mount does not freeze task loading, search or creation",async()=>{
  const adapter=apiClient.defaults.adapter;
  const interval=globalThis.setInterval,clear=globalThis.clearInterval;
  const timers=new Set<ReturnType<typeof setInterval>>();let failClockOnce=true,listCalls=0,agentCalls=0;
  globalThis.setInterval=((fn:()=>void,ms:number)=>{
    if(failClockOnce){failClockOnce=false;throw new TypeError("Illegal invocation");}
    const id=interval(()=>{},ms);timers.add(id);return id;
  }) as typeof setInterval;
  globalThis.clearInterval=((id:ReturnType<typeof setInterval>)=>{
    timers.delete(id);clear(id);
  }) as typeof clearInterval;
  apiClient.defaults.adapter=(async(config)=>{
    const url=String(config.url);
    const ok=(data:unknown)=>({data,status:200,statusText:"OK",headers:{},config});
    if(url.endsWith("/scheduled-tasks")){listCalls++;return ok({items:url.includes("workspace-empty")?[]:[task("workspace-a","First")],nextCursor:null});}
    if(url.endsWith("/executions"))return ok({items:[],nextCursor:null});
    if(url.endsWith("/ready-agents"))return ok({agentIds:["agent"]});
    if(url.includes("agents/available")){agentCalls++;return ok({agents:[]});}
    if(url.endsWith("/server-time"))return ok({now:Date.now(),protocolVersion:1});
    return ok({task:task("workspace-a","First")});
  }) as typeof adapter;
  let wrapper:ReturnType<typeof mount> | undefined;
  try {
    wrapper=mount(ScheduledTasksToolView,{props:{workspaceId:"workspace-a",toolId:"scheduledTasks"},global:{stubs,provide:{[workspaceHostKey as symbol]:fakeHost()}}});
    await tick();await tick();
    assert.equal(agentCalls,1);
    assert.equal(listCalls,1);
    assert.match(wrapper.text(),/First private/);
    await wrapper.find('input[aria-label="搜索任务名称"]').setValue("First");
    await wrapper.findAll("button").find((button)=>button.text()==="创建任务")!.trigger("click");
    assert.equal(wrapper.get('[data-testid="drawer"]').attributes("data-open"),"true");
    assert.match(wrapper.text(),/时间同步不可用/);
    assert.match(wrapper.get('[aria-label="时间同步状态"]').text(),/服务端时间.*设备时间/);
    await wrapper.setProps({workspaceId:"workspace-empty"});
    await tick();await tick();
    assert.equal(wrapper.findAll(".scheduled-task-card").length,0);
    assert.equal(wrapper.find("main h2").exists(),false);
    assert.doesNotMatch(wrapper.text(),/选择任务查看详情/);
  }finally{
    wrapper?.unmount();apiClient.defaults.adapter=adapter;globalThis.setInterval=interval;globalThis.clearInterval=clear;
    for(const id of timers)clear(id);
    assert.equal(timers.size,0,"unmount clears timers after failed clock start");
  }
});
