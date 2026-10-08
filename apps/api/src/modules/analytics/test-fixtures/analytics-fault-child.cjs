const fs = require("node:fs");

const mode = process.env.AWB_ANALYTICS_TEST_MODE;
const marker = process.env.AWB_ANALYTICS_TEST_MARKER;

function mark(value) {
  if (marker) fs.writeFileSync(marker, value, { mode: 0o600 });
}

if (mode === "ignore_shutdown") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  setInterval(() => {}, 1_000);
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "initialize") {
    process.send?.({ type: "ready", requestId: message.requestId });
    mark("ready");
    if (mode === "exit_after_ready") setImmediate(() => process.exit(17));
    return;
  }
  if (message.type === "signal") {
    if (mode === "target_signal_hang" && message.signal && message.signal.kind === "event" && message.signal.eventType === "execution_started") {
      mark("target_signal_pending");
      return;
    }
    process.send?.({ type: "signal_result", requestId: message.requestId, result: { accepted: true, receipt: null } });
    return;
  }
  if (message.type === "dashboard_query") {
    if (mode === "malformed_result") {
      process.send?.({
        type: "dashboard_result",
        requestId: message.requestId,
        response: { kind: "error", error: { code: "ANALYTICS_UNAVAILABLE", message: "test-only-private-detail" } }
      });
    }
    // hang_query intentionally does nothing.
    return;
  }
  if (message.type === "shutdown" && mode !== "ignore_shutdown") {
    process.send?.({ type: "shutdown_complete", requestId: message.requestId });
    process.disconnect?.();
  }
});
