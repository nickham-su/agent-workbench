import { createHash } from "node:crypto";

export type BudgetImage = { stableRef: string; mediaType: string; byteSize: number };
export type QueueBudgetTool = { name: string; description: string; inputSchema: unknown };
export class QueueInputBudgetError extends Error {
  constructor(readonly reason: "budget_configuration_invalid" | "provider_context_too_large" | "attachment_integrity_failed" | "prepare_snapshot_too_large" | "prepare_cache_capacity") {
    super(reason); this.name = "QueueInputBudgetError";
  }
}
const compareUnicode = (left: string, right: string) => {
  const a = Array.from(left), b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (diff) return diff;
  }
  return a.length - b.length;
};

/** Strict canonical JSON. No credentials or replay strings are ever emitted to diagnostics. */
export function canonicalQueueInputJson(value: unknown): string {
  const active = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item !== "object" || !item || active.has(item)) throw new Error("Queue input contains non-JSON data");
    if (Object.getOwnPropertySymbols(item).length) throw new Error("Queue input contains symbol keys");
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length || Array.from({ length: item.length }, (_, index) => index)
          .some(index => !Object.hasOwn(item, index))) throw new Error("Queue input contains a sparse or extended array");
        return item.map(visit);
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Queue input contains a non-JSON object");
      return Object.fromEntries(Object.keys(item).sort(compareUnicode).map(key => [key, visit((item as Record<string, unknown>)[key])]));
    } finally { active.delete(item); }
  };
  const serialize = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(serialize).join(",")}]`;
    if (item !== null && typeof item === "object") return `{${Object.keys(item).sort(compareUnicode).map(key => `${JSON.stringify(key)}:${serialize((item as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(item);
  };
  return serialize(visit(value));
}
export const queueInputSnapshotHash = (value: unknown) => createHash("sha256").update(canonicalQueueInputJson(value)).digest("hex");

export function queueOutputReservation(window: unknown, aiSdkValue: unknown, legacyValue?: unknown): number {
  if (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0) throw new QueueInputBudgetError("budget_configuration_invalid");
  const explicit = aiSdkValue !== undefined ? aiSdkValue : legacyValue;
  const reserve = explicit === undefined ? Math.min(4096, Math.max(1, Math.floor(window / 4))) : explicit;
  if (typeof reserve !== "number" || !Number.isSafeInteger(reserve) || reserve <= 0 || reserve >= window) throw new QueueInputBudgetError("budget_configuration_invalid");
  return reserve;
}

/** Images are the actual opened occurrences, in SDK request traversal order (including native tool media). */
export function buildQueueInputSnapshotView(input: {
  system: string; messages: readonly unknown[];
  tools: readonly QueueBudgetTool[]; providerReplay?: unknown; images: readonly BudgetImage[];
}) {
  let imageIndex = 0;
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== "object") return value;
    const row = value as Record<string, unknown>;
    if ((row.type === "file" && typeof row.mediaType === "string" && row.mediaType.startsWith("image/")) || row.type === "image" || row.type === "media") {
      const image = input.images[imageIndex++];
      if (!image || !image.stableRef || !Number.isSafeInteger(image.byteSize) || image.byteSize <= 0) throw new Error("Image budget metadata is unavailable");
      return { type: "budget_image", stableRef: image.stableRef, mediaType: image.mediaType, byteSize: image.byteSize };
    }
    if (Object.getPrototypeOf(row) !== Object.prototype && Object.getPrototypeOf(row) !== null) throw new Error("Queue input contains a non-JSON object");
    if (Object.getOwnPropertySymbols(row).length) throw new Error("Queue input contains symbol keys");
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, normalize(item)]));
  };
  const messages = input.messages.map(value => {
    if (!value || typeof value !== "object") throw new Error("Invalid budget message");
    const row = value as Record<string, unknown>;
    const content = typeof row.content === "string" ? [{ type: "text", text: row.content }] : row.content;
    if (!Array.isArray(content)) throw new Error("Invalid budget content");
    return normalize({ ...row, content });
  });
  const systemMessages = input.system ? [{ role: "system", content: [{ type: "text", text: input.system }] }] : [];
  if (imageIndex !== input.images.length) throw new Error("Image budget occurrences changed");
  const tools = input.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
    .sort((a, b) => compareUnicode(a.name, b.name));
  return { systemMessages, messages, tools, providerReplay: input.providerReplay ?? [] };
}
