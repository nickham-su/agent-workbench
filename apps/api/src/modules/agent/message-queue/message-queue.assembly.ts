import type { Db } from "../../../infra/db/db.js";
import { AgentAttachmentPublicationService } from "../attachments/agent-attachment-publication.service.js";
import type { RunLifecycleApplication } from "../lifecycle/run-lifecycle-application.js";
import type { AgentRuntimeControlService } from "../runtime-control/runtime-control.service.js";
import { AgentMessageQueueDispatcher } from "./message-queue.dispatcher.js";
import { AgentMessageQueueService, type QueueProfileResolver } from "./message-queue.service.js";
import { AgentMessageQueueStore } from "./message-queue.store.js";

/** Lifecycle-owned assembly; remains sealed until trusted runtime recovery completes. */
export function createAgentMessageQueueAssembly(input: {
  db: Db; dataDir: string; lifecycle: Pick<RunLifecycleApplication, "startQueuedUserRun" | "resumeQueuedSession">;
  runtimeControl: AgentRuntimeControlService; resolveProfile: QueueProfileResolver; onScanError?: () => void;
  closeInputAdmission?: () => void;
}) {
  const store = new AgentMessageQueueStore(input.db);
  const publications = new AgentAttachmentPublicationService({ db: input.db, dataDir: input.dataDir });
  const service = new AgentMessageQueueService(store, { ...input, publications, admissionInitiallyClosed: true,
    resumeSession: request => input.lifecycle.resumeQueuedSession({ ...request, runtime: input.runtimeControl }),
  });
  const dispatcher = new AgentMessageQueueDispatcher(store, { ...input, runtime: input.runtimeControl, admissionInitiallyClosed: true });
  service.setDispatcherWake(() => dispatcher.wake());
  let opened = false;
  let closed = false;
  return {
    service, dispatcher,
    suspendRuntimeDispatch: () => dispatcher.suspendRuntimeDispatch(),
    /** Caller must first complete the same trusted Worker-ready / fallback-onListen recovery barrier. */
    openAfterRuntimeRecovery() {
      if (closed) return;
      if (!opened) {
        service.recoverPublications();
        opened = true;
        service.openAdmission();
        dispatcher.start();
      }
      dispatcher.resumeRuntimeDispatch();
    },
    /** Must settle before runtime shutdown and DB close; does not claim runtime quiescence. */
    async close(timeoutMs?: number) {
      closed = true;
      service.closeAdmission();
      input.closeInputAdmission?.();
      const [receiptsSettled, scansSettled] = await Promise.all([service.close(timeoutMs), dispatcher.close(timeoutMs)]);
      return receiptsSettled && scansSettled;
    },
  };
}
