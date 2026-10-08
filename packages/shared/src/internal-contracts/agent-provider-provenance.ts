import { Type, type Static } from "@sinclair/typebox";
import type { AgentProviderReplayEnvelope } from "./agent-provider-replay.js";

const common = {
  protocolVersion: Type.Literal(1),
  providerId: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
};
export const AgentAssistantProvenanceSchema = Type.Union([
  Type.Object({ ...common, providerNpm: Type.Literal("@ai-sdk/openai"), protocol: Type.Literal("openai-responses") }, { additionalProperties: false }),
  Type.Object({ ...common, providerNpm: Type.Literal("@ai-sdk/moonshotai"), protocol: Type.Literal("moonshot-chat"), endpointDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  Type.Object({ ...common, providerNpm: Type.Literal("@ai-sdk/deepseek"), protocol: Type.Literal("deepseek-chat"), endpointDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
]);
export type AgentAssistantProvenance = Static<typeof AgentAssistantProvenanceSchema>;

export function agentReplayProvenance(envelope: AgentProviderReplayEnvelope): AgentAssistantProvenance {
  const provider = envelope.provider;
  const commonIdentity = {
    providerNpm: provider.npm,
    protocol: provider.npm === "@ai-sdk/openai" ? "openai-responses"
      : provider.npm === "@ai-sdk/moonshotai" ? "moonshot-chat" : "deepseek-chat",
    protocolVersion: provider.npm === "@ai-sdk/openai" ? envelope.version : provider.protocolVersion,
    providerId: provider.providerId,
    model: provider.model,
  };
  return provider.npm === "@ai-sdk/openai"
    ? { ...commonIdentity, providerNpm: "@ai-sdk/openai", protocol: "openai-responses" }
    : provider.npm === "@ai-sdk/moonshotai"
      ? { ...commonIdentity, providerNpm: "@ai-sdk/moonshotai", protocol: "moonshot-chat", endpointDigest: provider.endpointDigest }
      : { ...commonIdentity, providerNpm: "@ai-sdk/deepseek", protocol: "deepseek-chat", endpointDigest: provider.endpointDigest };
}

export function sameAgentReplayProvenance(left: AgentAssistantProvenance, right: AgentAssistantProvenance): boolean {
  return left.providerNpm === right.providerNpm && left.protocol === right.protocol
    && left.protocolVersion === right.protocolVersion && left.providerId === right.providerId
    && left.model === right.model
    && (left.providerNpm === "@ai-sdk/openai" && right.providerNpm === "@ai-sdk/openai"
      || left.providerNpm !== "@ai-sdk/openai" && right.providerNpm !== "@ai-sdk/openai"
        && left.endpointDigest === right.endpointDigest);
}
