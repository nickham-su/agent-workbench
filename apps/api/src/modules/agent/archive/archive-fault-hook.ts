import fs from "node:fs/promises";
import type { AgentTestFaults } from "../../../app/context.js";

/**
 * Archive adapter fault seam. Inputs contain metadata only; the composition-root
 * test mapping captures its own test payload and never receives archive text.
 */
export type ArchiveFaultHook = {
  afterAppendChunk?(input: { operation: "fork" | "compaction" | "clear"; chunkIndex: number; snapshotCount: number }): void | Promise<void>;
  beforeRollback?(input: { snapshotCount: number; firstSnapshotPath?: string }): void | Promise<void>;
  beforePendingSidecarWrite?(input: { operation: "compaction" | "clear"; snapshotCount: number }): void | Promise<void>;
  beforePendingSidecarRename?(input: { operation: "compaction" | "clear"; snapshotCount: number }): void | Promise<void>;
};

export const noArchiveFaultHook: ArchiveFaultHook = Object.freeze({});

/** Only the composition root converts the legacy AppContext test configuration. */
export function archiveFaultHookFromLegacyTestFaults(faults: AgentTestFaults | undefined): ArchiveFaultHook {
  return {
    afterAppendChunk(input) {
      const failAfter = faults?.archiveWrite?.failAfterChunks;
      if (input.operation === "fork" && typeof failAfter === "number" && Number.isFinite(failAfter) && input.chunkIndex >= failAfter) {
        const error = new Error("injected archive write failure");
        (error as Error & { code?: string }).code = "TEST_ARCHIVE_WRITE_FAIL";
        throw error;
      }
    },
    async beforeRollback(input) {
      const payload = faults?.archiveRollback?.appendBeforeRollback;
      if (payload && input.firstSnapshotPath) await fs.appendFile(input.firstSnapshotPath, payload, "utf8");
    },
    beforePendingSidecarWrite() {
      if (faults?.archiveSidecar?.failWrite) throw new Error("injected archive pending sidecar write failure");
    },
    beforePendingSidecarRename() {
      if (faults?.archiveSidecar?.failRename) throw new Error("injected archive pending sidecar rename failure");
    }
  };
}
