import assert from "node:assert/strict";
import test from "node:test";
import { ChannelsService } from "./channels.service.js";

test("channels service logs sender/conversation ids when allowlist is empty", () => {
  const warns: Array<{ obj: any; msg: string }> = [];
  const logger = {
    warn(obj: any, msg: string) {
      warns.push({ obj, msg });
    }
  } as any;

  const service = new ChannelsService({} as any, logger, {} as any, {} as any);

  const res = service.ingestInboundMessage({
    pluginId: "feishu",
    channelName: "im",
    accountId: "default",
    conversationKey: "feishu_default_chat_1",
    chatType: "group",
    chatId: "oc_test_chat",
    externalMessageId: "om_test_msg_1",
    sender: { id: "ou_test_sender" },
    text: "hello"
  });

  assert.equal(res.ok, true);
  assert.equal(res.deduplicated, false);

  // allowlist now applies at trigger/run stage; ingest should not emit reject log.
  assert.equal(warns.length, 0);
});

test("channels service does not reject sender at ingest stage", () => {
  const warns: Array<{ obj: any; msg: string }> = [];
  const logger = {
    warn(obj: any, msg: string) {
      warns.push({ obj, msg });
    }
  } as any;

  const service = new ChannelsService({} as any, logger, {} as any, {} as any);

  const res = service.ingestInboundMessage({
    pluginId: "feishu",
    channelName: "im",
    accountId: "default",
    conversationKey: "feishu_default_chat_2",
    chatType: "direct",
    chatId: "oc_test_chat_2",
    externalMessageId: "om_test_msg_2",
    sender: { id: "ou_denied_sender" },
    text: "hello"
  });

  assert.equal(res.ok, true);
  assert.equal(res.deduplicated, false);

  // allowlist now applies at trigger/run stage; ingest should not emit reject log.
  assert.equal(warns.length, 0);
});
