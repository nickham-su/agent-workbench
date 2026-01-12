import { randomUUID } from "node:crypto";

export function newId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

