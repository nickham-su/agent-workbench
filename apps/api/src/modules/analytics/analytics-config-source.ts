import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  isCanonicalAnalyticsSignal,
  type AnalyticsExpectedSlotsConfigSignal,
} from "@agent-workbench/shared";
import { openSecureAnalyticsRoot, type SecureAnalyticsDirectory } from "@agent-workbench/shared/node/analytics-root";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const SOURCE_FILE_MODE = 0o600;
const sourceAllocationTails = new Map<string, Promise<void>>();

type SourceConfigContent = Pick<
  AnalyticsExpectedSlotsConfigSignal,
  "enabledFactDomains" | "slots"
>;
type SourceConfigSignal = Pick<
  AnalyticsExpectedSlotsConfigSignal,
  "sourceConfigVersion" | "effectiveAt" | "enabledFactDomains" | "slots"
>;
type PersistedSourceConfig = {
  sourceVersion: number;
  effectiveAt: number;
  canonicalContent: string;
  canonicalHash: string;
};

function canonicalContent(input: SourceConfigContent) {
  return JSON.stringify({
    enabledFactDomains: [...input.enabledFactDomains].sort(),
    slots: [...input.slots]
      .map((slot) => ({
        domain: slot.domain,
        producerNamespace: slot.producerNamespace,
        producerId: slot.producerId,
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  });
}

function hash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

function isSafePersisted(value: unknown): value is PersistedSourceConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedSourceConfig>;
  return (
    Number.isSafeInteger(candidate.sourceVersion) &&
    (candidate.sourceVersion ?? 0) >= 1 &&
    Number.isSafeInteger(candidate.effectiveAt) &&
    (candidate.effectiveAt ?? -1) >= 0 &&
    typeof candidate.canonicalContent === "string" &&
    typeof candidate.canonicalHash === "string" &&
    candidate.canonicalHash === hash(candidate.canonicalContent)
  );
}

async function readPersisted(
  directory: SecureAnalyticsDirectory,
): Promise<PersistedSourceConfig | null> {
  try {
    const raw = await directory.readFile("config-source.json");
    const decoded: unknown = JSON.parse(raw);
    return isSafePersisted(decoded) ? decoded : null;
  } catch { return null; }
}

function sourceSignal(persisted: PersistedSourceConfig): SourceConfigSignal | null {
  try {
    const decoded: unknown = JSON.parse(persisted.canonicalContent);
    if (!decoded || typeof decoded !== "object") return null;
    const content = decoded as Partial<SourceConfigContent>;
    if (!Array.isArray(content.enabledFactDomains) || !Array.isArray(content.slots))
      return null;
    // Canonical persistence sorts slots, whereas the public contract uses a
    // mode-specific tuple order. Restore that transport order on replay.
    const slots = [...content.slots].sort((left, right) =>
      ({ worker: 0, execution: 1, model: 2 }[left.domain] ?? 3) - ({ worker: 0, execution: 1, model: 2 }[right.domain] ?? 3),
    );
    const signal: AnalyticsExpectedSlotsConfigSignal = {
      kind: "expected_slots_config",
      sentAt: 0,
      requestId: "config_source_replay",
      sourceConfigVersion: persisted.sourceVersion,
      effectiveAt: persisted.effectiveAt,
      enabledFactDomains: content.enabledFactDomains,
      slots,
    };
    if (
      !isCanonicalAnalyticsSignal(signal) ||
      canonicalContent(signal) !== persisted.canonicalContent
    )
      return null;
    return {
      sourceConfigVersion: signal.sourceConfigVersion,
      effectiveAt: signal.effectiveAt,
      enabledFactDomains: signal.enabledFactDomains,
      slots: signal.slots,
    };
  } catch {
    return null;
  }
}

async function publishAtomically(directory: SecureAnalyticsDirectory, value: PersistedSourceConfig) {
  try { await directory.publishJson("config-source.json", value); return true; }
  catch { return false; }
}

async function serializeSourceAllocation<T>(
  filePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = sourceAllocationTails.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  sourceAllocationTails.set(filePath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sourceAllocationTails.get(filePath) === tail)
      sourceAllocationTails.delete(filePath);
  }
}

/**
 * API-owned source ordering for expected-slot configuration. A failure is
 * intentionally returned as null: Analytics config must never block API work.
 * Multiple API processes are intentionally unsupported; this serializes the
 * one product API process while atomic file validation remains fail-closed.
 */
export async function allocateAnalyticsConfigSource(
  dataDir: string,
  input: SourceConfigContent,
  now = Date.now(),
): Promise<SourceConfigSignal | null> {
  if (!Number.isSafeInteger(now) || now < 0) return null;
  try {
    const root = await openSecureAnalyticsRoot(dataDir);
    // This is an in-process mutex key only. It is never dereferenced for I/O:
    // capability operations below remain anchored to the verified root FD.
    const allocationKey = path.resolve(dataDir, "analytics", "config-source.json");
    try {
    await root.deleteFile("config-source.json.lock").catch(() => undefined);
    return await serializeSourceAllocation(allocationKey, async () => {
      const previous = await readPersisted(root);
      // A present but invalid source cannot be safely replaced: its last
      // version is unknowable after a crash. Leave Analytics unconfigured.
      if (!previous) {
        if ((await root.list()).includes("config-source.json")) return null;
      }
      const content = canonicalContent(input);
      const digest = hash(content);
      if (
        previous &&
        previous.canonicalHash === digest &&
        previous.canonicalContent === content
      ) {
        return {
          sourceConfigVersion: previous.sourceVersion,
          effectiveAt: previous.effectiveAt,
          enabledFactDomains: input.enabledFactDomains,
          slots: input.slots,
        };
      }
      const sourceVersion = (previous?.sourceVersion ?? 0) + 1;
      if (!Number.isSafeInteger(sourceVersion)) return null;
      const effectiveAt = Math.max(now, previous?.effectiveAt ?? 0);
      const next = {
        sourceVersion,
        effectiveAt,
        canonicalContent: content,
        canonicalHash: digest,
      };
      if (!(await publishAtomically(root, next))) return null;
      return {
        sourceConfigVersion: sourceVersion,
        effectiveAt,
        enabledFactDomains: input.enabledFactDomains,
        slots: input.slots,
      };
    });
    } finally { await root.close(); }
  } catch {
    return null;
  }
}

/** Reads the durable API source without allocating a new version. */
export async function readAnalyticsConfigSource(
  dataDir: string,
): Promise<SourceConfigSignal | null> {
  try {
    const root = await openSecureAnalyticsRoot(dataDir);
    try {
      const persisted = await readPersisted(root);
      return persisted ? sourceSignal(persisted) : null;
    } finally { await root.close(); }
  } catch { return null; }
}

/** Test-only reader; production callers must use allocation or replay reads. */
export async function readAnalyticsConfigSourceForTest(dataDir: string) {
  const root = await openSecureAnalyticsRoot(dataDir);
  try { return await readPersisted(root); }
  finally { await root.close(); }
}
