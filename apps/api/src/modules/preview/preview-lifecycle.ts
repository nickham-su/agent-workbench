import type { PreviewRuntime } from "./preview-runtime.js";

type Listener = {
  listen(options: { host: string; port: number }): Promise<unknown>;
  close(): Promise<unknown>;
};

export type PreviewListenerLifecycle = Readonly<{ close(): Promise<void> }>;

async function closeIgnoringFailure(listener: Listener) {
  try {
    await listener.close();
  } catch {
    // Preserve the original listen failure; cleanup is best effort.
  }
}

/** Starts preview first and guarantees best-effort cleanup when either listener cannot start. */
export async function startPreviewListenerLifecycle(params: {
  previewApp: Listener;
  mainApp: Listener;
  runtime: PreviewRuntime;
  previewListen: { host: string; port: number };
  mainListen: { host: string; port: number };
}): Promise<PreviewListenerLifecycle> {
  try {
    await params.previewApp.listen(params.previewListen);
    await params.mainApp.listen(params.mainListen);
  } catch (error) {
    await Promise.all([closeIgnoringFailure(params.mainApp), closeIgnoringFailure(params.previewApp)]);
    params.runtime.close();
    throw error;
  }

  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([closeIgnoringFailure(params.mainApp), closeIgnoringFailure(params.previewApp)]);
      params.runtime.close();
    }
  };
}
