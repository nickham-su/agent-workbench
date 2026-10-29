type ShutdownSignals = Pick<NodeJS.Process, "on" | "removeListener" | "exitCode">;

/** Repeated signals share cleanup only while it is running. Once settled,
 * remove our handlers so later explicit signals regain normal exit semantics. */
export function installApiShutdownHooks(
  close: () => Promise<void>,
  reportFailure: () => void | Promise<void>,
  signals: ShutdownSignals = process,
) {
  let shutdown: Promise<void> | null = null;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signals.removeListener("SIGINT", onSignal);
    signals.removeListener("SIGTERM", onSignal);
  };
  const onSignal = () => {
    shutdown ??= Promise.resolve().then(close).catch(async () => {
      signals.exitCode = 1;
      // A failed reporter must not replace a handled close error with an
      // unhandled rejection (including an asynchronous reporter).
      try { await reportFailure(); } catch { /* the failing exit code survives */ }
    }).finally(dispose);
  };
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  return dispose;
}
