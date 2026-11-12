import { cancelQueuedReceipts } from "./queued-receipt-cancellation.js";
import type { Db } from "../../../infra/db/db.js";
import { AgentAttachmentPublicationService } from "../attachments/agent-attachment-publication.service.js";
import type { RunLifecycleApplication } from "../lifecycle/run-lifecycle-application.js";
import type { AgentRuntimeControlService } from "../runtime-control/runtime-control.service.js";
import { AgentMessageQueueService, type QueueProfileResolver } from "./message-queue.service.js";
import { AgentMessageQueueStore } from "./message-queue.store.js";

/** Lifecycle-owned assembly; remains sealed until trusted runtime recovery completes. */
export function createAgentMessageQueueAssembly(input: {
  db: Db; dataDir: string; lifecycle: Pick<RunLifecycleApplication, "activateAcceptedUserRun" | "resumeQueuedSession" | "handoffQueuedContinuation">;
  runtimeControl: AgentRuntimeControlService; resolveProfile: QueueProfileResolver;
  closeInputAdmission?: () => void;
}) {
  const store = new AgentMessageQueueStore(input.db);
  const publications = new AgentAttachmentPublicationService({ db: input.db, dataDir: input.dataDir });
  const service = new AgentMessageQueueService(store, { ...input, publications, admissionInitiallyClosed: true,
    activateOrdinarySend: command => ({ ...input.lifecycle.activateAcceptedUserRun(command), inputText: store.get(command, command.receiptId).input_text! }),
    handoffContinuation: run => input.lifecycle.handoffQueuedContinuation({ ...run, runtime: input.runtimeControl }),
    resumeSession: request => input.lifecycle.resumeQueuedSession({ ...request, runtime: input.runtimeControl }),
  });
  let opened = false;
  let closed = false;
  return {
    service,
    /** Caller must first complete the same trusted Worker-ready / fallback-onListen recovery barrier. */
    openAfterRuntimeRecovery() {
      if (closed) return;
      if (!opened) {
        service.recoverPublications();
        input.db.transaction(() => {
          const sessions = input.db.prepare("select distinct workspace_id as workspaceId,session_id as sessionId from agent_user_message_receipt where status='queued'").all() as Array<{ workspaceId: string; sessionId: string }>;
          for (const scope of sessions) cancelQueuedReceipts(input.db, scope, store.listQueued(scope).map(row => row.id), Date.now());
        }).immediate();
        opened = true;
      }
      service.openAdmission();
    },
    /** Must settle before runtime shutdown and DB close; does not claim runtime quiescence. */
    async close(timeoutMs?: number) {
      closed = true;
      service.closeAdmission();
      input.closeInputAdmission?.();
      return service.close(timeoutMs);
    },
  };
}
