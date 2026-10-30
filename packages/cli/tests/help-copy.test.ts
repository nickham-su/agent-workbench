import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/program.js";
import { captureIO } from "./helpers.js";

async function help(args: string[]) {
  const capture = captureIO();
  let configurations = 0;
  let requests = 0;
  const code = await runCli([...args, "--help", "--json"], {
    io: capture.io,
    createConfigStore: () => { configurations++; throw Error("help must stay offline"); },
    http: { request: async () => { requests++; throw Error("help must stay offline"); } }
  });
  assert.equal(code, 0, capture.diagnostic());
  assert.equal(configurations, 0);
  assert.equal(requests, 0);
  assert.equal(capture.diagnostic(), "");
  // Commander may wrap descriptions; check their meaning independently of terminal width.
  return capture.output().replace(/\s+/g, "");
}

test("normal help describes usage without speculative availability or result disclaimers", async () => {
  const commands = [[], ["login"], ["workspace"], ["workspace", "list"], ["agent"], ["agent", "list"], ["session"],
    ...["list", "show", "status", "send", "messages", "cancel", "compact"].map((action) => ["session", action]),
    ["file"], ["file", "download"]];
  for (const command of commands) {
    const output = await help(command);
    assert.doesNotMatch(output, /不保证|不代表|不表示|竞态|仅词法过滤|尚非最终正文|不显示仓库地址|不查询或推断/, command.join(" "));
  }
});

test("positive help retains input, follow, cancellation and download operation rules", async () => {
  const agent = await help(["agent", "list"]);
  assert.ok(agent.includes("当前工作区的可选Agent"));
  assert.ok(agent.includes("按配置顺序"));
  const status = await help(["session", "status"]);
  assert.ok(status.includes("查看会话是否正在执行（idle/running）"));
  const send = await help(["session", "send"]);
  assert.ok(send.includes("文本或图片至少一个"));
  assert.ok(send.includes("默认受理后返回，使用-f等待执行结果"));
  assert.ok(send.includes("创建或发送失败时立即返回，不自动重试"));
  assert.ok(send.includes("主会话"));
  const messages = await help(["session", "messages"]);
  assert.ok(messages.includes("-n1返回最近一条普通消息"));
  const cancel = await help(["session", "cancel"]);
  assert.ok(cancel.includes("服务端处理请求时的当前执行及其活动后代"));
  assert.ok(cancel.includes("不回滚文件、不删除历史"));
  const compact = await help(["session", "compact"]);
  assert.ok(compact.includes("配置顺序第一个userAgent"));
  assert.ok(compact.includes("空闲主"));
  assert.ok(compact.includes("保留原消息历史和工作区文件"));
  for (const output of [send, messages, compact]) assert.ok(output.includes("中断监听不会取消后台执行"));
  const download = await help(["file", "download"]);
  for (const rule of ["目录由服务端生成ZIP", "100MiB", ".git/软链整次失败", "空目录不保留", "不覆盖已有文件或链接"]) {
    assert.ok(download.includes(rule), rule);
  }
});
