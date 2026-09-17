import type { Db } from "../../infra/db/db.js";

export type TerminalAuthArtifactKind = "ssh-key" | "askpass" | "askpass-token" | "legacy";
export type TerminalAuthCleanupPhase = "armed" | "recoverable" | "unresolved";

export type TerminalAuthCleanupIntent = {
  terminalId: string;
  artifactKind: TerminalAuthArtifactKind;
  phase: TerminalAuthCleanupPhase;
  artifactName: string;
  expectedDev: number | null;
  expectedIno: number | null;
  rootDev: number | null;
  rootIno: number | null;
  diagnostic: string;
  updatedAt: number;
};

type Row = TerminalAuthCleanupIntent;
const ARMED_DIAGNOSTIC = "auth cleanup latch armed before secret side effects";

function get(db: Db, terminalId: string, artifactKind: TerminalAuthArtifactKind): TerminalAuthCleanupIntent | null {
  const row = db.prepare(`
    select terminal_id as terminalId, artifact_kind as artifactKind, phase,
      artifact_name as artifactName, expected_dev as expectedDev, expected_ino as expectedIno,
      root_dev as rootDev, root_ino as rootIno, diagnostic, updated_at as updatedAt
    from terminal_auth_cleanup_intents
    where terminal_id = ? and artifact_kind = ?
  `).get(terminalId, artifactKind) as Row | undefined;
  return row ?? null;
}

/** 兼容只需判断单一 row 的旧调用；新生命周期必须使用 list。 */
export function getTerminalAuthCleanupIntent(db: Db, terminalId: string, artifactKind?: TerminalAuthArtifactKind) {
  if (artifactKind) return get(db, terminalId, artifactKind);
  return db.prepare(`
    select terminal_id as terminalId, artifact_kind as artifactKind, phase,
      artifact_name as artifactName, expected_dev as expectedDev, expected_ino as expectedIno,
      root_dev as rootDev, root_ino as rootIno, diagnostic, updated_at as updatedAt
    from terminal_auth_cleanup_intents where terminal_id = ? order by artifact_kind limit 1
  `).get(terminalId) as Row | undefined ?? null;
}

export function listTerminalAuthCleanupIntents(db: Db, terminalId: string): TerminalAuthCleanupIntent[] {
  return db.prepare(`
    select terminal_id as terminalId, artifact_kind as artifactKind, phase,
      artifact_name as artifactName, expected_dev as expectedDev, expected_ino as expectedIno,
      root_dev as rootDev, root_ino as rootIno, diagnostic, updated_at as updatedAt
    from terminal_auth_cleanup_intents where terminal_id = ? order by artifact_kind
  `).all(terminalId) as Row[];
}

function sameIntent(actual: TerminalAuthCleanupIntent | null, expected: TerminalAuthCleanupIntent) {
  return actual?.terminalId === expected.terminalId
    && actual.artifactKind === expected.artifactKind
    && actual.phase === expected.phase
    && actual.artifactName === expected.artifactName
    && actual.expectedDev === expected.expectedDev
    && actual.expectedIno === expected.expectedIno
    && actual.rootDev === expected.rootDev
    && actual.rootIno === expected.rootIno
    && actual.diagnostic === expected.diagnostic
    && actual.updatedAt === expected.updatedAt;
}

function assertRequiredRootIdentity(phase: TerminalAuthCleanupPhase, rootDev: number | null, rootIno: number | null) {
  if (phase === "unresolved" && rootDev === null && rootIno === null) return;
  // unresolved 可保留 legacy 的全空锚点；一旦存在锚点则必须是成对、可信的
  // identity，避免半空或越界值绕过后续 root authority 比较。
  if (rootDev === null || rootIno === null || !Number.isSafeInteger(rootDev) || rootDev < 0 || !Number.isSafeInteger(rootIno) || rootIno < 0) {
    throw new Error("terminal auth cleanup root anchor is invalid");
  }
}

/** 在该 artifact 的任何 secret 副作用前持久化 fail-closed latch。 */
export function armTerminalAuthCleanupIntent(db: Db, input: {
  terminalId: string;
  artifactKind?: TerminalAuthArtifactKind;
  artifactName?: string;
  rootDev: number | null;
  rootIno: number | null;
  updatedAt: number;
}) {
  const artifactKind = input.artifactKind ?? "legacy";
  const expected: TerminalAuthCleanupIntent = {
    terminalId: input.terminalId,
    artifactKind,
    phase: "armed",
    artifactName: input.artifactName ?? "<none>",
    expectedDev: null,
    expectedIno: null,
    rootDev: input.rootDev,
    rootIno: input.rootIno,
    diagnostic: ARMED_DIAGNOSTIC,
    updatedAt: input.updatedAt,
  };
  assertRequiredRootIdentity(expected.phase, expected.rootDev, expected.rootIno);
  const result = db.prepare(`
    insert into terminal_auth_cleanup_intents (
      terminal_id, artifact_kind, phase, artifact_name, expected_dev, expected_ino, root_dev, root_ino, diagnostic, updated_at
    ) values (@terminalId, @artifactKind, 'armed', @artifactName, null, null, @rootDev, @rootIno, @diagnostic, @updatedAt)
  `).run(expected);
  if (result.changes !== 1 || !sameIntent(get(db, expected.terminalId, expected.artifactKind), expected)) {
    throw new Error("terminal auth cleanup latch arm was not persisted");
  }
}

/** 更新一个明确 artifact 的权威 locator；零行、IGNORE 与读回不一致均 fail-closed。 */
export function updateTerminalAuthCleanupIntent(db: Db, input: TerminalAuthCleanupIntent | {
  terminalId: string;
  artifactKind?: TerminalAuthArtifactKind;
  phase: TerminalAuthCleanupPhase;
  artifactName: string;
  expectedDev?: number | null;
  expectedIno?: number | null;
  rootDev?: number | null;
  rootIno?: number | null;
  diagnostic: string;
  updatedAt: number;
}) {
  const artifactKind = input.artifactKind ?? "legacy";
  // unresolved 仍应保留最后一次可信 root anchor；只有 legacy migration 等原本
  // 没有 anchor 的行才允许继续为 null，绝不能因普通 phase update 丢失它。
  const existing = get(db, input.terminalId, artifactKind);
  const expected: TerminalAuthCleanupIntent = {
    terminalId: input.terminalId,
    artifactKind,
    phase: input.phase,
    artifactName: input.artifactName,
    expectedDev: input.expectedDev ?? null,
    expectedIno: input.expectedIno ?? null,
    rootDev: input.rootDev === undefined ? (existing?.rootDev ?? null) : input.rootDev,
    rootIno: input.rootIno === undefined ? (existing?.rootIno ?? null) : input.rootIno,
    diagnostic: input.diagnostic,
    updatedAt: input.updatedAt,
  };
  assertRequiredRootIdentity(expected.phase, expected.rootDev, expected.rootIno);
  const result = db.prepare(`
    update terminal_auth_cleanup_intents
    set phase = @phase, artifact_name = @artifactName, expected_dev = @expectedDev,
      expected_ino = @expectedIno, root_dev = @rootDev, root_ino = @rootIno, diagnostic = @diagnostic, updated_at = @updatedAt
    where terminal_id = @terminalId and artifact_kind = @artifactKind
  `).run(expected);
  if (result.changes !== 1 || !sameIntent(get(db, expected.terminalId, expected.artifactKind), expected)) {
    throw new Error("terminal auth cleanup latch update was not persisted");
  }
}

/** 删除一个明确 artifact 的权威 locator。 */
export function clearTerminalAuthCleanupIntent(db: Db, terminalId: string, artifactKind?: TerminalAuthArtifactKind) {
  const kind = artifactKind ?? getTerminalAuthCleanupIntent(db, terminalId)?.artifactKind;
  if (!kind) throw new Error("terminal auth cleanup latch clear was not persisted");
  const result = db.prepare("delete from terminal_auth_cleanup_intents where terminal_id = ? and artifact_kind = ?").run(terminalId, kind);
  if (result.changes !== 1 || get(db, terminalId, kind) !== null) {
    throw new Error("terminal auth cleanup latch clear was not persisted");
  }
}
