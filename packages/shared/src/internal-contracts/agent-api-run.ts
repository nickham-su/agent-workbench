import { Type, type Static } from "@sinclair/typebox";
import {
  AgentTerminalResultCodeSchema,
  AgentTerminalRunStatusSchema,
} from "../contracts/agent.js";

const IdSchema = Type.String({ minLength: 1 });

/** Worker 取得实际执行权时的幂等状态转换请求。 */
export const AgentApiMarkRunWorkInProgressRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiMarkRunWorkInProgressRequest = Static<typeof AgentApiMarkRunWorkInProgressRequestSchema>;

export const AgentApiMarkRunWorkInProgressResponseSchema = Type.Object({
  result: Type.Union([Type.Literal("updated"), Type.Literal("already_in_progress")])
}, { additionalProperties: false });
export type AgentApiMarkRunWorkInProgressResponse = Static<typeof AgentApiMarkRunWorkInProgressResponseSchema>;

/**
 * 无业务产物的终态意图。真正终态及 artifact 收敛由下一阶段的 converge RPC
 * 统一完成；该请求本身不接受或写入 actual terminal result。
 */
export const AgentApiPersistTerminalIntentRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  status: AgentTerminalRunStatusSchema,
  code: AgentTerminalResultCodeSchema,
  detail: Type.Null(),
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiPersistTerminalIntentRequest = Static<typeof AgentApiPersistTerminalIntentRequestSchema>;

export const AgentApiPersistTerminalIntentResponseSchema = Type.Object({
  result: Type.Union([Type.Literal("updated"), Type.Literal("already_persisted")])
}, { additionalProperties: false });
export type AgentApiPersistTerminalIntentResponse = Static<typeof AgentApiPersistTerminalIntentResponseSchema>;

/** convergence 不接收 Worker 结果，只读取已持久化的 intended terminal 三元组。 */
export const AgentApiConvergeRunTerminalRequestSchema = Type.Object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  updatedAt: Type.Number()
}, { additionalProperties: false });
export type AgentApiConvergeRunTerminalRequest = Static<typeof AgentApiConvergeRunTerminalRequestSchema>;

export const AgentApiConvergeRunTerminalResponseSchema = Type.Object({
  kind: Type.Union([Type.Literal("transitioned"), Type.Literal("already_converged")]),
  finalStatus: AgentTerminalRunStatusSchema
}, { additionalProperties: false });
export type AgentApiConvergeRunTerminalResponse = Static<typeof AgentApiConvergeRunTerminalResponseSchema>;
