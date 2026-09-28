import type { JSONValue } from "ai";

/** Fixed request policy by Provider, not by model ID. The SDK maps it to model capabilities. */
export function reasoningProviderFixedOptions(
  providerNpm: "@ai-sdk/moonshotai" | "@ai-sdk/deepseek",
): Readonly<Record<string, JSONValue>> {
  if (providerNpm === "@ai-sdk/moonshotai") {
    return {
      thinking: { type: "enabled" },
      reasoningHistory: "preserved",
    };
  }
  if (providerNpm === "@ai-sdk/deepseek") {
    return { thinking: { type: "enabled" } };
  }
  throw new Error("unsupported reasoning provider");
}
