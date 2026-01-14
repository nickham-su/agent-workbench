import type { ExecResult } from "./gitExec.js";
import { runGit } from "./gitExec.js";

function normalizeValue(raw: unknown) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.includes("\0") || s.includes("\n") || s.includes("\r")) return "";
  return s;
}

export type NormalizedGitIdentity = { name: string; email: string };

export function validateAndNormalizeGitIdentity(raw: unknown): NormalizedGitIdentity | null {
  const obj = (raw ?? {}) as any;
  const name = normalizeValue(obj.name);
  const email = normalizeValue(obj.email);
  if (!name || !email) return null;
  return { name, email };
}

function isUnsetNotFound(res: ExecResult) {
  const s = (res.stderr || res.stdout || "").toLowerCase();
  // git config --unset/--unset-all：key 不存在时通常会返回非 0，并输出 "not found"
  return s.includes("not found") || s.includes("no such key");
}

export async function gitConfigGet(params: { cwd: string; repoPath?: string; global?: boolean; key: string }) {
  const args: string[] = [];
  if (params.repoPath) args.push("-C", params.repoPath);
  args.push("config");
  if (params.global) args.push("--global");
  args.push("--get", params.key);
  const res = await runGit(args, { cwd: params.cwd });
  if (!res.ok) return null;
  const v = res.stdout.trim();
  return v ? v : null;
}

export async function gitConfigSet(params: { cwd: string; repoPath?: string; global?: boolean; key: string; value: string }) {
  const args: string[] = [];
  if (params.repoPath) args.push("-C", params.repoPath);
  args.push("config");
  if (params.global) args.push("--global");
  args.push(params.key, params.value);
  const res = await runGit(args, { cwd: params.cwd });
  return res.ok;
}

export async function gitConfigUnsetAll(params: { cwd: string; repoPath?: string; global?: boolean; key: string }) {
  const args: string[] = [];
  if (params.repoPath) args.push("-C", params.repoPath);
  args.push("config");
  if (params.global) args.push("--global");
  args.push("--unset-all", params.key);
  const res = await runGit(args, { cwd: params.cwd });
  if (res.ok) return true;
  if (isUnsetNotFound(res)) return true;
  return false;
}

