import test from "node:test";
import assert from "node:assert/strict";
import { ClockPoller, ServerClock } from "./serverClock.js";

test("clock thresholds and failure retain estimate until 120 seconds", async () => {
  let now=10000;
  const clock=new ServerClock(()=>now);
  assert.equal(clock.snapshot().health,"unavailable");
  await clock.sync(async()=>{now+=100;return {now:now+2000,protocolVersion:1};});
  assert.equal(clock.snapshot().health,"normal");
  assert.equal(clock.snapshot().offset,2050);
  now+=1000;
  await clock.sync(async()=>{throw new Error("private");});
  assert.equal(clock.snapshot().health,"uncertain");
  assert.equal(clock.snapshot().retrying,true);
  now+=120000;
  assert.equal(clock.snapshot().health,"unavailable");
  assert.equal(clock.snapshot().serverNow,null);
});
test("clock deviation is tolerated below one minute in either direction",async()=>{
  const now=10_000,clock=new ServerClock(()=>now);
  await clock.sync(async()=>({now:now+59_999,protocolVersion:1}));
  assert.equal(clock.snapshot().health,"normal");
  await clock.sync(async()=>({now:now+60_000,protocolVersion:1}));
  assert.equal(clock.snapshot().health,"warning");
  await clock.sync(async()=>({now:now-59_999,protocolVersion:1}));
  assert.equal(clock.snapshot().health,"normal");
  await clock.sync(async()=>({now:now-60_000,protocolVersion:1}));
  assert.equal(clock.snapshot().health,"warning");
});
test("high RTT cannot report normal",async()=>{
  let now=10000;const clock=new ServerClock(()=>now);
  await clock.sync(async()=>{now+=2200;return {now:11100,protocolVersion:1};});
  assert.equal(clock.snapshot().health,"uncertain");
});
test("poller visibility requests immediately and successful sync resets 30s cadence",async()=>{
  let now=10000;let next=0;const timers=new Map<number,{fn:()=>void;ms:number}>();let calls=0;const snapshots:string[]=[];
  const clock=new ServerClock(()=>now);
  const poller=new ClockPoller(clock,async()=>{calls++;return {now,protocolVersion:1};},s=>snapshots.push(s.health),
    (fn,ms)=>{timers.set(++next,{fn,ms});return next as unknown as ReturnType<typeof setInterval>},
    (id)=>{timers.delete(Number(id))});
  poller.setVisible(true);await Promise.resolve();await Promise.resolve();
  assert.equal(calls,1);
  assert.deepEqual([...timers.values()].map(v=>v.ms).sort((a,b)=>a-b),[1000,30000]);
  poller.setVisible(false);assert.equal(timers.size,0);
  now+=120000;poller.setVisible(true);await Promise.resolve();await Promise.resolve();
  assert.equal(calls,2);assert.equal(snapshots.at(-1),"normal");
  poller.dispose();assert.equal(timers.size,0);
});

test("a stale success cannot overwrite the newer server offset after hiding and retrying",async()=>{
  let now=100_000;
  let finishOld!: (value:{now:number;protocolVersion:1})=>void;
  const timers=new Map<number,()=>void>();let next=0,calls=0,updates=0;
  const clock=new ServerClock(()=>now);
  const poller=new ClockPoller(clock,()=>{
    calls++;
    return calls===1 ? new Promise<{now:number;protocolVersion:1}>((resolve)=>{finishOld=resolve;}) : Promise.resolve({now,protocolVersion:1 as const});
  },()=>{updates++;},(fn)=>{timers.set(++next,fn);return next as unknown as ReturnType<typeof setInterval>;},
  (id)=>{timers.delete(Number(id));});
  poller.setVisible(true);
  poller.setVisible(false);
  poller.setVisible(true);
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(calls,2);
  const current=clock.snapshot();
  assert.equal(current.offset,0);
  assert.equal(current.health,"normal");
  assert.equal(updates,1);
  finishOld({now:50_000,protocolVersion:1}); // Would set offset to -50_000 without a commit guard.
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.deepEqual(clock.snapshot(),current);
  assert.equal(updates,1);
  assert.equal(timers.size,2);
  poller.dispose();assert.equal(timers.size,0);
});

test("a stale failure cannot demote a newer successful clock sample",async()=>{
  let rejectOld!: (reason:Error)=>void;
  const clock=new ServerClock(()=>100_000);
  let calls=0,next=0;const timers=new Map<number,()=>void>();
  const poller=new ClockPoller(clock,()=>{
    calls++;
    return calls===1 ? new Promise<{now:number;protocolVersion:1}>((_,reject)=>{rejectOld=reject;}) :
      Promise.resolve({now:100_000,protocolVersion:1 as const});
  },()=>{},(fn)=>{timers.set(++next,fn);return next as unknown as ReturnType<typeof setInterval>;},
  (id)=>{timers.delete(Number(id));});
  poller.setVisible(true);
  poller.setVisible(false);
  poller.setVisible(true);
  await new Promise<void>((resolve)=>setImmediate(resolve));
  const current=clock.snapshot();
  rejectOld(new Error("old request failed"));
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.deepEqual(clock.snapshot(),current);
  poller.dispose();assert.equal(timers.size,0);
});

test("ticker and interval reset errors do not escape async requests or prevent retry",async()=>{
  const timers=new Map<number,{fn:()=>void;ms:number}>();let next=0,failTicker=true,failReset=true,failClear=true;
  const poller=new ClockPoller(new ServerClock(),async()=>({now:Date.now(),protocolVersion:1}),()=>{},
    (fn,ms)=>{
      if(ms===1000 && failTicker){failTicker=false;throw new Error("ticker unavailable");}
      if(ms===30000 && timers.size && failReset){failReset=false;throw new Error("reset unavailable");}
      timers.set(++next,{fn,ms});return next as unknown as ReturnType<typeof setInterval>;
    },(id)=>{
      timers.delete(Number(id));
      if(failClear){failClear=false;throw new Error("clear unavailable");}
    });
  poller.setVisible(true); // Fails while creating the ticker; cleanup also encounters a clear error.
  assert.equal(timers.size,0);
  poller.setVisible(true); // Must be retryable even after the first failure.
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(timers.size,0,"async timer reset failure cleans up both intervals");
  poller.setVisible(true); // Recovery after the asynchronous reset failure.
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(timers.size,2);
  // A periodic request also resets the 30-second timer without duplicating it.
  const periodic=[...timers.values()].find(({ms})=>ms===30000)!;
  periodic.fn();
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(timers.size,2);
  poller.dispose();
  assert.equal(timers.size,0);
});

test("a rejected clock sync cannot surface as an unhandled request",async()=>{
  let failNow=true,next=0;const timers=new Map<number,()=>void>();
  const clock=new ServerClock(()=>{
    if(failNow){failNow=false;throw new Error("clock unavailable");}
    return Date.now();
  });
  const poller=new ClockPoller(clock,async()=>({now:Date.now(),protocolVersion:1}),()=>{},
    (fn)=>{timers.set(++next,fn);return next as unknown as ReturnType<typeof setInterval>;},
    (id)=>{timers.delete(Number(id));});
  poller.setVisible(true);
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(clock.snapshot().health,"unavailable");
  poller.setVisible(true);
  await new Promise<void>((resolve)=>setImmediate(resolve));
  poller.dispose();assert.equal(timers.size,0);
});

test("default browser timers retain their global receiver on start, reset, hide, and dispose",async()=>{
  const originalEvery=globalThis.setInterval,originalClear=globalThis.clearInterval;
  const timers=new Map<number,{fn:()=>void;ms:number}>();let next=0,calls=0;
  globalThis.setInterval=function(this:typeof globalThis,fn:()=>void,ms:number){
    assert.equal(this,globalThis,"native setInterval requires the global receiver");
    timers.set(++next,{fn,ms});return next as unknown as ReturnType<typeof setInterval>;
  } as typeof setInterval;
  globalThis.clearInterval=function(this:typeof globalThis,id:ReturnType<typeof setInterval>){
    assert.equal(this,globalThis,"native clearInterval requires the global receiver");
    timers.delete(Number(id));
  } as typeof clearInterval;
  const poller=new ClockPoller(new ServerClock(),async()=>{calls++;return {now:Date.now(),protocolVersion:1};},()=>{});
  try {
    poller.setVisible(true);
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.equal(calls,1);
    assert.deepEqual([...timers.values()].map(({ms})=>ms).sort((a,b)=>a-b),[1000,30000]);
    timers.get([...timers.keys()].find((id)=>timers.get(id)?.ms===30000)!)!.fn();
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.equal(calls,2);
    poller.setVisible(false);assert.equal(timers.size,0);
    poller.setVisible(true);
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.equal(calls,3);
    poller.dispose();assert.equal(timers.size,0);
  }finally{poller.dispose();globalThis.setInterval=originalEvery;globalThis.clearInterval=originalClear;}
});

test("clock adapter failure cannot throw during activation and allows a clean retry",async()=>{
  const timers=new Map<number,()=>void>();let next=0,fail=true,calls=0;
  const poller=new ClockPoller(new ServerClock(),async()=>{calls++;return {now:Date.now(),protocolVersion:1};},()=>{},
    (fn)=>{if(fail){fail=false;throw new TypeError("Illegal invocation");}timers.set(++next,fn);return next as unknown as ReturnType<typeof setInterval>;},
    (id)=>{timers.delete(Number(id));});
  poller.setVisible(true);
  assert.equal(timers.size,0);
  assert.equal(calls,0);
  poller.setVisible(true);
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(calls,1);
  assert.equal(timers.size,2);
  poller.dispose();assert.equal(timers.size,0);
});

test("async clock/update failures stay within the poller and do not leave timers behind",async()=>{
  const timers=new Map<number,()=>void>();let next=0,failUpdate=true;
  const clock=new ServerClock();
  const poller=new ClockPoller(clock,async()=>{throw new Error("time request failed");},()=>{
    if(failUpdate){failUpdate=false;throw new Error("render failed");}
  },(fn)=>{timers.set(++next,fn);return next as unknown as ReturnType<typeof setInterval>;},(id)=>{timers.delete(Number(id));});
  poller.setVisible(true);
  await new Promise<void>((resolve)=>setImmediate(resolve));
  assert.equal(clock.snapshot().health,"unavailable");
  // The callback failure is contained, and the next visible activation can retry.
  poller.setVisible(false);
  poller.setVisible(true);
  await new Promise<void>((resolve)=>setImmediate(resolve));
  poller.dispose();assert.equal(timers.size,0);
});
