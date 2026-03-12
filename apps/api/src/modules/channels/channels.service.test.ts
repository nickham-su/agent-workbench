import assert from "node:assert/strict";
import test from "node:test";
import { ChannelsService } from "./channels.service.js";

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

test("channels service logs sender/conversation ids when allowlist is empty", () => {
  const warns: Array<{ obj: any; msg: string }> = [];
  const logger = {
    warn(obj: any, msg: string) {
      warns.push({ obj, msg });
    }
  } as any;

  const service = new ChannelsService({} as any, logger, {} as any, {} as any);

  withEnv("AWB_CHANNEL_SENDER_ALLOWLIST", undefined, () => {
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

    assert.equal(res.ok, false);
    assert.equal(res.errorCode, "NOT_ALLOWED");
    assert.equal(res.message, "channel sender allowlist is empty");
  });

  assert.equal(warns.length, 1);
  assert.equal(warns[0]?.msg, "channels: inbound rejected by sender allowlist");
  assert.deepEqual(warns[0]?.obj, {
    channelType: "feishu",
    channelName: "im",
    senderExternalId: "ou_test_sender",
    conversationExternalId: "oc_test_chat",
    externalMessageId: "om_test_msg_1",
    reason: "channel sender allowlist is empty"
  });
});

test("channels service logs sender/conversation ids when sender is not in allowlist", () => {
  const warns: Array<{ obj: any; msg: string }> = [];
  const logger = {
    warn(obj: any, msg: string) {
      warns.push({ obj, msg });
    }
  } as any;

  const service = new ChannelsService({} as any, logger, {} as any, {} as any);

  withEnv("AWB_CHANNEL_SENDER_ALLOWLIST", "ou_allowed", () => {
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

    assert.equal(res.ok, false);
    assert.equal(res.errorCode, "NOT_ALLOWED");
    assert.equal(res.message, "sender is not allowed");
  });

  assert.equal(warns.length, 1);
  assert.equal(warns[0]?.msg, "channels: inbound rejected by sender allowlist");
  assert.deepEqual(warns[0]?.obj, {
    channelType: "feishu",
    channelName: "im",
    senderExternalId: "ou_denied_sender",
    conversationExternalId: "oc_test_chat_2",
    externalMessageId: "om_test_msg_2",
    reason: "sender is not allowed"
  });
});
