import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { serializeAgentTimelineQuery } from "./agentTimelineQuery.js";

test("Axios 序列化 Timeline 的已知 null root 为显式查询参数", () => {
  const url = axios.getUri({ url: "/timeline", params: {
    workspaceId: "workspace",
    mode: "delta",
    sinceRevision: 3,
    knownHeadMessageId: "head",
    knownContextRootIsNull: true,
  }, paramsSerializer: { serialize: serializeAgentTimelineQuery } });
  assert.match(url, /knownContextRootIsNull=true/);
  assert.doesNotMatch(url, /knownContextRootMessageId=/);
});

test("Axios 序列化 Timeline 的非空 root 为消息 ID 查询参数", () => {
  const url = axios.getUri({ url: "/timeline", params: {
    workspaceId: "workspace",
    mode: "delta",
    knownContextRootMessageId: "root",
  }, paramsSerializer: { serialize: serializeAgentTimelineQuery } });
  assert.match(url, /knownContextRootMessageId=root/);
  assert.doesNotMatch(url, /knownContextRootIsNull=/);
});
