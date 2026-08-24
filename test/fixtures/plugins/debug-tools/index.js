const plugin = {
  meta: {
    id: "debug-tools",
    name: "Debug Tools",
    version: "0.1.0",
    description: "Self-contained runtime fixture for plugin tool tests."
  },
  capabilities: {
    tools: [
      {
        name: "echo_inspect",
        description: "Echoes the input and optionally returns JSON-safe raw data.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["message"],
          properties: {
            message: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            includeRaw: { type: "boolean" },
            mode: { enum: ["ok", "throw", "long_text"] }
          }
        },
        outputMode: "text+raw",
        riskLevel: "low",
        execute(args) {
          const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
          const message = typeof input.message === "string" ? input.message : "";
          const mode = typeof input.mode === "string" ? input.mode : "ok";

          if (mode === "throw") {
            throw new Error("debug-tools requested failure");
          }

          if (mode === "long_text") {
            return {
              text: [`debug-tools long_text: ${message}`, ...Array.from({ length: 60 }, (_, index) => `line ${index + 1}`)].join("\n")
            };
          }

          const text = `tool: plugin_debug-tools_echo_inspect\nmessage: ${message}`;
          return input.includeRaw === false
            ? { text }
            : { text, raw: { receivedArgs: input } };
        }
      }
    ]
  }
};

export default plugin;
