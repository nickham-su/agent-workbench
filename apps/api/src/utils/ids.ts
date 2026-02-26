import { randomBytes, randomUUID } from "node:crypto";

let lastMs = 0;
let sameMsSeq = 0;

export function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export function newSortableId(prefix: string) {
  const now = Date.now();
  if (now === lastMs) {
    sameMsSeq += 1;
  } else {
    lastMs = now;
    sameMsSeq = 0;
  }
  const ts = now.toString(36).padStart(10, "0");
  const seq = sameMsSeq.toString(36).padStart(4, "0");
  const random = randomBytes(6).toString("hex");
  return `${prefix}_${ts}${seq}${random}`;
}
