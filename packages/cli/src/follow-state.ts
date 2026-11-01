import type { AgentHeadReplacementProof } from "@agent-workbench/shared";
import type { AgentApi } from "./agent-api.js";
import { CliError, responseError } from "./errors.js";
import { assertFinal, assertSameRecord, incomplete, ordered, timelineChanged } from "./follow-chain.js";
import type { FollowOutput } from "./follow-output.js";
import { isMessageAheadOfSession, isTimelineLookupMissing, projectMessage, readTimeline, selectHistory, type HistoryFrame, type MessageSelection, type MessageView, type TimelineMessage, type TimelinePage } from "./messages.js";
import type { ObservedRun } from "./run-status.js";

/** A structural response must yield to the fixed Run before another coordination read. */
export class TerminalObserved { constructor(readonly run: ObservedRun) {} }
export type RunProbe = () => Promise<ObservedRun>;
interface Watermark { revision: number; head: string | null; root: string | null; }
interface Stage {
  frame: HistoryFrame;
  start: Watermark;
  /** Actual head row observed at OPEN, never replaced by a newer raw baseline. */
  startHead?: TimelineMessage;
  paged: boolean;
  relocate: boolean;
  fenceDepth: number;
}
interface RetiredDraft {
  to: string;
  /** Exact distance from this retired identity to the current identity. */
  count: number;
  /** Aggregation may prove an intermediate hop without exposing its exact revision. */
  supersededRevision?: number;
  /** Last raw version seen before retirement; no retired body is retained here. */
  lastRevision: number;
}
interface Boundary {
  /** Explicit --after and accepted-send anchors are hard, unlike the automatic H0. */
  anchor: string | null;
  selection?: MessageSelection;
  includeInitialRun: boolean;
}
const watermark = (page: TimelinePage): Watermark => ({ revision: page.session.revision, head: page.session.headMessageId, root: page.session.contextRootMessageId });
const sameHead = (a: Watermark, b: Watermark) => a.head === b.head && a.root === b.root;
function cloneFrame(frame: HistoryFrame): HistoryFrame { return { ...frame, messages: new Map(frame.messages) }; }

/** Command-local committed facts. Before pages and unfinished rebuilds never advance this cursor. */
export class FollowState {
  private committed: Watermark;
  private historyIds = new Set<string>();
  /** Required raw observations outlive a reset, pass change, or terminal yield, but
   * never advance the committed cursor or qualify a request's head observation.
   * Unselected navigation suffixes stay out; proven retired slot rows are removed. */
  private readonly observed = new Map<string, TimelineMessage>();
  /** Verified slot aliases survive unfinished stages; retired drafts retain no body. */
  private readonly retired = new Map<string, RetiredDraft>();
  /** Only current protected successors, including candidates still outside the tail. */
  private readonly candidates = new Map<string, AgentHeadReplacementProof>();
  private mapped(id: string): string { return this.retired.get(id)?.to ?? id; }
  private initialized = false;
  private readonly initialRevision: number;
  private readonly initialHead: string | null;
  private autoHead: string | null;
  private readonly initialDepth: number;
  private readonly initialTailDepth: number;
  private readonly initialSelectionKnown: boolean;
  constructor(public frame: HistoryFrame, readonly runId: string | null, private readonly boundary: Boundary, private readonly output: FollowOutput) {
    this.committed = watermark(frame.initial);
    this.initialRevision = this.committed.revision;
    this.initialHead = this.committed.head;
    this.autoHead = boundary.selection ? this.initialHead : null;
    this.initialDepth = this.initialHead === null ? -1 : frame.messages.get(this.initialHead)!.depth;
    this.initialTailDepth = ordered(frame)[0]?.depth ?? 0;
    this.initialSelectionKnown = boundary.selection === undefined || selectHistory(frame, boundary.selection) !== null;
    if (boundary.selection) {
      // A partial tail already contains protected initial slots even if last N needs more pages.
      const selected = selectHistory(frame, boundary.selection);
      for (const item of selected ?? ordered(frame).map(projectMessage).filter((item): item is MessageView => item !== null)) this.historyIds.add(item.id);
    }
  }
  private target(message: TimelineMessage): boolean {
    return this.runId !== null && message.originSessionId === this.frame.sessionId && message.originRunId === this.runId;
  }
  private included(message: TimelineMessage, ids = this.historyIds, anchorDepth = this.boundary.anchor === null ? undefined : this.frame.messages.get(this.boundary.anchor)?.depth): boolean {
    return message.id !== this.boundary.anchor && (anchorDepth === undefined || message.depth > anchorDepth)
      && (ids.has(message.id) || this.target(message)
      && (this.boundary.includeInitialRun || message.updatedRevision > this.initialRevision));
  }
  private protectedIds(): Set<string> {
    const ids = new Set([...this.historyIds, ...this.output.emitted.keys(), ...this.observed.keys(), ...this.candidates.keys()]);
    if (this.autoHead !== null) ids.add(this.autoHead);
    if (this.boundary.anchor !== null) ids.add(this.boundary.anchor);
    for (const message of this.frame.messages.values()) if (this.included(message)) ids.add(message.id);
    // Hidden chain rows between selected slots are necessary immutable navigation facts too.
    let first = Number.POSITIVE_INFINITY; let last = -1;
    for (const id of ids) {
      const depth = (this.observed.get(id) ?? this.frame.messages.get(id))?.depth;
      if (depth !== undefined) { first = Math.min(first, depth); last = Math.max(last, depth); }
    }
    for (const message of this.frame.messages.values()) if (message.depth >= first && message.depth <= Math.min(last, this.initialDepth)) ids.add(message.id);
    return ids;
  }
  private retainRequired(stage: Stage): void {
    const ids = new Set([...this.protectedIds()].map((id) => this.mapped(id)));
    if (!this.initialized && this.boundary.selection) {
      const selected = this.initialSelection(stage);
      if (selected) for (const message of selected) ids.add(message.id);
      else {
        // A partial initial selection is not permission to forget the rows already
        // read for it. For last N, only older slots can fill its still-missing slots.
        for (const message of stage.frame.messages.values()) {
          if (message.depth <= this.initialDepth && projectMessage(message)
            && (this.boundary.selection.mode === "after" || message.depth < this.initialTailDepth)) ids.add(message.id);
        }
      }
    }
    for (const message of stage.frame.messages.values()) if (this.included(message)) ids.add(message.id);
    let first = Number.POSITIVE_INFINITY; let last = -1;
    for (const id of ids) {
      const message = stage.frame.messages.get(id) ?? this.observed.get(id) ?? this.frame.messages.get(id);
      if (message) { first = Math.min(first, message.depth); last = Math.max(last, message.depth); }
    }
    for (const message of stage.frame.messages.values()) {
      if (!ids.has(message.id) && !(message.depth >= first && message.depth <= Math.min(last, this.initialDepth))) continue;
      const previous = this.observed.get(message.id) ?? this.frame.messages.get(message.id);
      if (previous) assertSameRecord(previous, message);
      this.observed.set(message.id, message);
    }
  }
  private async delta(api: AgentApi, mark: Watermark): Promise<TimelinePage> {
    const page = await readTimeline(api, this.frame.workspaceId, this.frame.sessionId, { mode: "delta", sinceRevision: mark.revision,
      ...(mark.head === null ? {} : { knownHeadMessageId: mark.head }),
      ...(mark.root === null ? { knownContextRootIsNull: true } : { knownContextRootMessageId: mark.root }) });
    if (page.session.revision < mark.revision) throw timelineChanged();
    return page;
  }
  private async yieldRun(probe?: RunProbe): Promise<void> {
    if (probe) { const run = await probe(); if (run.status !== "running") throw new TerminalObserved(run); }
  }
  private applyProof(stage: Stage, page: TimelinePage, mark: Watermark, from: TimelineMessage | undefined): void {
    const proof = page.headReplacement;
    if (!proof) return;
    // readTimeline already validates the constant-sized schema and request/response binding.
    if (proof.fromMessageId !== mark.head || proof.fromSupersededRevision <= mark.revision) throw responseError("替换证明请求绑定无效。");
    // A proof-only header is already an authenticated identity fact, even before
    // its raw body is paged in. Check it before changing aliases or obligations.
    const expectation = this.candidates.get(proof.toMessageId);
    if (expectation) this.assertCandidateIdentity(expectation, proof);
    const target = this.observed.get(proof.toMessageId) ?? stage.frame.messages.get(proof.toMessageId) ?? this.frame.messages.get(proof.toMessageId);
    if (target) this.assertCandidateIdentity(target, proof);
    const protectedIds = this.protectedIds();
    const protectsFrom = [...protectedIds].some((id) => this.mapped(id) === proof.fromMessageId);
    if (this.boundary.anchor === proof.fromMessageId || this.output.released.has(proof.fromMessageId)) throw timelineChanged();
    if (protectsFrom || from && this.target(from)) {
      if (!from || from.id !== mark.head || from.updatedRevision > mark.revision || from.type !== "assistant"
        || from.status !== "streaming" || !this.target(from) || from.originRunId !== proof.runId
        || from.depth !== proof.depth || from.previousMessageId !== proof.previousMessageId) throw responseError("替换证明不符合已观察草稿的来源与槽位。");
      this.recordReplacement(proof, from);
    }
    // An unrelated, unselected r2 proof can explain navigation, never exempt protected r1.
    stage.frame.messages.delete(proof.fromMessageId);
    for (const id of this.retired.keys()) stage.frame.messages.delete(id);
    const candidate = page.messages.find((message) => message.id === proof.toMessageId);
    if (candidate) this.assertCandidate(candidate, proof, true);
  }
  private recordReplacement(proof: AgentHeadReplacementProof, source: TimelineMessage): void {
    if (this.retired.has(proof.toMessageId)) throw timelineChanged();
    const known = this.retired.get(source.id);
    const latest = this.observed.get(source.id) ?? source;
    // An older request observation can qualify a proof without erasing newer facts.
    if (latest.status !== "streaming" || proof.fromSupersededRevision <= Math.max(latest.updatedRevision, known?.lastRevision ?? -1)
      || known?.supersededRevision !== undefined && known.supersededRevision !== proof.fromSupersededRevision) {
      throw responseError("替换证明与已观察草稿的最新状态或版本冲突。");
    }
    if (!known) assertSameRecord(source, latest);
    const current = known?.to ?? source.id;
    const hops = proof.replacementCount - (known?.count ?? 0);
    if (current === proof.toMessageId ? hops !== 0 : hops <= 0) throw responseError("替换证明与已验证槽位关系冲突。");
    const expectation = this.candidates.get(proof.toMessageId);
    const target = this.observed.get(proof.toMessageId);
    for (const old of [expectation && { revision: expectation.toUpdatedRevision, status: expectation.toStatus },
      target && { revision: target.updatedRevision, status: target.status }]) {
      if (old && (proof.toUpdatedRevision < old.revision || old.status !== "streaming" && proof.toStatus !== old.status
        || proof.toUpdatedRevision === old.revision && proof.toStatus !== old.status)) {
        throw responseError("替换后继证明不能回退已观察状态或版本。");
      }
    }
    if (current !== proof.toMessageId) {
      const currentRaw = this.observed.get(current) ?? (current === source.id ? latest : undefined);
      const currentProof = this.candidates.get(current);
      if (this.boundary.anchor === current || this.output.released.has(current)
        || currentRaw && currentRaw.status !== "streaming" || currentProof && currentProof.toStatus !== "streaming") throw timelineChanged();
      const lastRevision = Math.max(currentRaw?.updatedRevision ?? -1, currentProof?.toUpdatedRevision ?? -1);
      if (proof.toUpdatedRevision <= lastRevision) throw responseError("替换后继早于已观察的槽位版本。");
      // A validated aggregate can extend a known chain. Its hop count proves the
      // extension; same Run/depth alone never retires an observed intermediate ID.
      for (const [id, fact] of this.retired) if (fact.to === current) {
        if (!Number.isSafeInteger(fact.count + hops)) throw responseError("替换链长度超出安全整数范围。");
        this.retired.set(id, { ...fact, to: proof.toMessageId, count: fact.count + hops });
      }
      this.retired.set(current, { to: proof.toMessageId, count: hops, lastRevision,
        ...(current === source.id ? { supersededRevision: proof.fromSupersededRevision } : {}) });
      this.observed.delete(current);
      this.candidates.delete(current);
    }
    const sourceFact = this.retired.get(source.id)!;
    sourceFact.supersededRevision = proof.fromSupersededRevision;
    this.candidates.set(proof.toMessageId, proof);
  }
  private assertCandidateIdentity(record: TimelineMessage | AgentHeadReplacementProof, proof: AgentHeadReplacementProof): void {
    // Proofs imply a native assistant header; raw records must prove the same
    // immutable identity. Revision/status progression is checked separately.
    const header = "toMessageId" in record ? { id: record.toMessageId, type: "assistant", originSessionId: record.sessionId,
      originRunId: record.runId, depth: record.depth, previousMessageId: record.previousMessageId } : record;
    if (proof.workspaceId !== this.frame.workspaceId || proof.sessionId !== this.frame.sessionId
      || "toMessageId" in record && record.workspaceId !== proof.workspaceId
      || header.id !== proof.toMessageId || header.type !== "assistant" || header.originSessionId !== proof.sessionId
      || header.originRunId !== proof.runId || header.previousMessageId !== proof.previousMessageId || header.depth !== proof.depth) {
      throw responseError("替换后继与已认证身份不一致。");
    }
  }
  private assertCandidate(message: TimelineMessage, proof: AgentHeadReplacementProof, exact: boolean): void {
    this.assertCandidateIdentity(message, proof);
    if (message.status === "superseded" || message.updatedRevision < proof.toUpdatedRevision
      || proof.toStatus !== "streaming" && message.status !== proof.toStatus
      || (exact || message.updatedRevision === proof.toUpdatedRevision) && (message.updatedRevision !== proof.toUpdatedRevision || message.status !== proof.toStatus)) {
      throw responseError("替换后继与证明头不一致。");
    }
  }
  private overlay(stage: Stage, page: TimelinePage): void {
    const protectedIds = new Set([...this.protectedIds()].map((id) => this.mapped(id)));
    for (const message of page.messages) {
      if (this.retired.has(message.id)) throw timelineChanged();
      const previous = this.observed.get(message.id) ?? stage.frame.messages.get(message.id) ?? this.frame.messages.get(message.id);
      if (previous && (protectedIds.has(message.id) || this.included(previous))) assertSameRecord(previous, message);
      stage.frame.messages.set(message.id, message);
    }
  }
  private stage(page: TimelinePage, mark: Watermark, previous: HistoryFrame, source: TimelineMessage | undefined): Stage {
    const frame = page.timelineReset ? { ...previous, messages: new Map<string, TimelineMessage>(), hasMore: page.hasMore, nextBeforeMessageId: page.nextBeforeMessageId } : cloneFrame(previous);
    const stage: Stage = { frame, start: watermark(page), paged: false, relocate: false, fenceDepth: -1 };
    this.applyProof(stage, page, mark, source);
    for (const id of this.retired.keys()) frame.messages.delete(id);
    this.overlay(stage, page);
    const head = stage.start.head === null ? undefined : stage.frame.messages.get(stage.start.head);
    if (stage.start.head !== null && !head) throw timelineChanged();
    stage.startHead = head;
    stage.fenceDepth = head?.depth ?? -1;
    if ((ordered(frame).at(-1)?.id ?? null) !== page.session.headMessageId) throw timelineChanged();
    this.retainRequired(stage);
    return stage;
  }
  private initialSelection(stage: Stage): MessageView[] | null {
    const selection = this.boundary.selection;
    if (!selection) return [];
    if (this.initialSelectionKnown) return [...this.historyIds].map((id) => stage.frame.messages.get(this.mapped(id)))
      .filter((message): message is TimelineMessage => message !== undefined).map(projectMessage).filter((message): message is MessageView => message !== null);
    const prefix = { ...stage.frame, messages: new Map(ordered(stage.frame).filter((message) => message.depth <= this.initialDepth).map((message) => [message.id, message])) };
    if (selection.mode === "after") return selectHistory(prefix, selection);
    // The already selected tail slots are frozen. A formerly hidden H0 becoming
    // visible must not displace an older initial history item while paging.
    const older = ordered(prefix).filter((message) => message.depth < this.initialTailDepth).map(projectMessage).filter((message): message is MessageView => message !== null);
    const needed = selection.count - this.historyIds.size;
    if (older.length < needed && prefix.hasMore) return null;
    const selected = new Set([...this.historyIds].map((id) => this.mapped(id)));
    for (const message of needed > 0 ? older.slice(-needed) : []) selected.add(message.id);
    return ordered(prefix).filter((message) => selected.has(message.id)).map(projectMessage).filter((message): message is MessageView => message !== null);
  }
  private needsMore(stage: Stage): boolean {
    const raw = ordered(stage.frame); const oldest = raw[0];
    let more = false;
    for (const id of this.protectedIds()) {
      if (stage.frame.messages.has(this.mapped(id))) continue;
      const old = this.observed.get(id) ?? this.frame.messages.get(id);
      if (!stage.frame.hasMore || old && oldest && oldest.depth <= old.depth) {
        if (!old && !this.initialized && this.boundary.selection?.mode === "after" && id === this.boundary.anchor) {
          throw new CliError(6, "消息锚点不属于此会话的当前可见分支。", { code: "ANCHOR_NOT_FOUND", phase: "history", effect: "not_applicable" });
        }
        throw timelineChanged();
      }
      more = true;
    }
    if (!this.initialized && this.initialSelection(stage) === null) {
      if (!stage.frame.hasMore) throw timelineChanged();
      more = true;
    }
    return more;
  }
  private checkChain(stage: Stage): void {
    const raw = ordered(stage.frame);
    for (let i = 1; i < raw.length; i++) if (raw[i].previousMessageId !== raw[i - 1].id || raw[i].depth <= raw[i - 1].depth) throw timelineChanged();
    if (!stage.frame.hasMore && raw.length && raw[0].previousMessageId !== null) throw timelineChanged();
  }
  private async build(api: AgentApi, stage: Stage, probe?: RunProbe): Promise<void> {
    const visited = new Set<string>();
    while (this.needsMore(stage)) {
      const oldest = ordered(stage.frame)[0];
      const cursor = stage.frame.nextBeforeMessageId;
      if (!oldest || cursor !== oldest.id || visited.has(cursor)) throw timelineChanged();
      visited.add(cursor);
      let page: TimelinePage;
      try { page = await readTimeline(api, this.frame.workspaceId, this.frame.sessionId, { mode: "before", beforeMessageId: cursor }); }
      catch (error) {
        if (!isTimelineLookupMissing(error)) throw error;
        // Only the actual mutable head/cursor may trigger structural coordination.
        const mutable = oldest.status === "streaming" && oldest.type === "assistant"
          && (this.target(oldest) && !this.output.released.has(oldest.id) && oldest.id !== this.boundary.anchor
            || !this.protectedIds().has(oldest.id));
        if (!mutable) throw timelineChanged();
        await this.yieldRun(probe);
        stage.relocate = true; return;
      }
      stage.paged = true;
      if (page.session.revision < stage.start.revision) throw timelineChanged();
      const moved = !sameHead(watermark(page), stage.start) || page.timelineReset;
      if (page.timelineReset || !page.messages.length) {
        if (moved) await this.yieldRun(probe);
        if (!page.messages.length) throw timelineChanged();
        stage.relocate = true; return;
      }
      const newest = page.messages.at(-1)!;
      if (newest.id !== oldest.previousMessageId || newest.depth >= oldest.depth || page.messages.some((message) => stage.frame.messages.has(message.id))) throw timelineChanged();
      this.overlay(stage, page);
      stage.frame.hasMore = page.hasMore;
      stage.frame.nextBeforeMessageId = page.nextBeforeMessageId;
      this.checkChain(stage);
      this.retainRequired(stage);
      // A terminal yield may discard this stage too. Preserve its validated raw
      // prefix first, while still probing before any next coordination read.
      if (moved) await this.yieldRun(probe);
      // A changed root is not a waiver. CHECK must establish the protected range in its view.
      if (page.session.contextRootMessageId !== stage.start.root) { stage.relocate = true; return; }
    }
    this.validate(stage);
    this.retainRequired(stage);
  }
  private close(stage: Stage, page: TimelinePage, final: boolean, keepSuffix = false): Stage {
    this.retainRequired(stage);
    // CHECK's head is fixed at OPEN. A newer BUILD row cannot impersonate its raw source.
    const raw = stage.startHead;
    const previous = stage.frame;
    const frame = page.timelineReset ? { ...previous, messages: new Map<string, TimelineMessage>(), hasMore: page.hasMore, nextBeforeMessageId: page.nextBeforeMessageId } : cloneFrame(previous);
    const next: Stage = { ...stage, frame };
    this.applyProof(next, page, stage.start, raw);
    this.overlay(next, page);
    if (final) {
      for (const message of page.messages) if (this.target(message) && message.depth > stage.fenceDepth) throw incomplete();
      // Only the frozen prefix is required. Later r2 rows must not create a moving goalpost.
      const relevant = ordered(frame).filter((message) => message.depth <= stage.fenceDepth);
      if (!keepSuffix) frame.messages = new Map(relevant.map((message) => [message.id, message]));
      let relevantDepth = -1;
      for (const id of this.protectedIds()) relevantDepth = Math.max(relevantDepth, frame.messages.get(this.mapped(id))?.depth ?? -1);
      for (const message of relevant) if (this.target(message)) relevantDepth = Math.max(relevantDepth, message.depth);
      if (!keepSuffix) frame.messages = new Map(relevant.filter((message) => message.depth <= relevantDepth).map((message) => [message.id, message]));
    }
    next.relocate = false;
    // A reset tail which does not contain the required range needs the next pass, not more CHECKs.
    if (this.needsMore(next)) next.relocate = true;
    if ([...frame.messages.values()].some((message) => isMessageAheadOfSession(message, page.session))) next.relocate = true;
    if (!next.relocate) this.validate(next);
    this.retainRequired(next);
    return next;
  }
  private validate(stage: Stage): void {
    this.checkChain(stage);
    for (const id of this.protectedIds()) {
      const old = this.observed.get(id) ?? this.frame.messages.get(id); const current = stage.frame.messages.get(this.mapped(id));
      if (!current || current.status === "superseded") throw timelineChanged();
      if (old && !this.retired.has(id)) assertSameRecord(old, current);
    }
    for (const proof of this.candidates.values()) {
      const candidate = stage.frame.messages.get(proof.toMessageId);
      if (!candidate) throw incomplete();
      this.assertCandidate(candidate, proof, false);
    }
  }
  private selectedIds(stage: Stage): Set<string> {
    return this.initialized ? new Set([...this.historyIds].map((id) => this.mapped(id)))
      : new Set((this.initialSelection(stage) ?? []).map((message) => message.id));
  }
  private views(stage: Stage): MessageView[] {
    const ids = this.selectedIds(stage);
    return ordered(stage.frame).filter((message) => this.included(message, ids, this.boundary.anchor === null ? undefined : stage.frame.messages.get(this.boundary.anchor)?.depth)).map(projectMessage).filter((message): message is MessageView => message !== null);
  }
  private async publish(stage: Stage, mark?: Watermark): Promise<void> {
    this.validate(stage);
    const views = this.views(stage);
    // Validate ALL identities and layouts before the first irreversible body or invalidation write.
    for (const previous of this.output.emitted.values()) {
      if (this.retired.has(previous.id)) continue;
      const current = stage.frame.messages.get(previous.id);
      if (!current || !projectMessage(current)) throw timelineChanged();
      assertSameRecord(this.frame.messages.get(previous.id) ?? { ...previous, replacesMessageId: null }, current);
    }
    for (const id of this.output.emitted.keys()) if (this.retired.has(id)) await this.output.supersedeDraft(id);
    for (const message of views) await this.output.message(message, this.initialized ? "follow" : "history");
    this.historyIds = this.selectedIds(stage);
    if (this.autoHead !== null) this.autoHead = this.mapped(this.autoHead);
    this.initialized = true;
    if (mark) { this.frame = stage.frame; this.committed = mark; this.observed.clear(); this.retired.clear(); this.candidates.clear(); }
    // A FinalDrain never advertises unconsumed r2 rows as a complete global cursor.
  }
  async initialize(api: AgentApi, probe?: RunProbe): Promise<void> {
    const stage: Stage = { frame: cloneFrame(this.frame), start: this.committed,
      startHead: this.initialHead === null ? undefined : this.frame.messages.get(this.initialHead), paged: false, relocate: false, fenceDepth: this.initialDepth };
    await this.finishOrdinary(api, stage, probe);
  }
  private async finishOrdinary(api: AgentApi, first: Stage, probe?: RunProbe): Promise<void> {
    let stage = first;
    for (;;) {
      await this.build(api, stage, probe);
      if (!stage.paged && !stage.relocate) { this.validate(stage); await this.publish(stage, stage.start); return; }
      const close = await this.delta(api, stage.start);
      const structural = close.timelineReset || !sameHead(watermark(close), stage.start);
      if (structural) await this.yieldRun(probe);
      const checked = this.close(stage, close, false);
      if (!checked.relocate) { await this.publish(checked, watermark(close)); return; }
      // This is structural reconciliation, not HTTP retry. Every moving response yields above.
      stage = this.stage(close, stage.start, stage.frame, stage.startHead);
      if (!structural) await this.yieldRun(probe);
    }
  }
  async refresh(api: AgentApi, probe: RunProbe): Promise<void> {
    const source = this.committed.head === null ? undefined : this.frame.messages.get(this.committed.head);
    const page = await this.delta(api, this.committed);
    const stage = this.stage(page, this.committed, this.frame, source);
    if (page.timelineReset) await this.yieldRun(probe);
    await this.finishOrdinary(api, stage, probe);
  }
  /** Exactly two OPENs at most; each pass has precisely one CHECK and no reads after it. */
  async finalDrain(api: AgentApi, publish = true): Promise<HistoryFrame> {
    const frozen = { ...this.committed };
    // Each OPEN reuses this actual committed observation, not the latest raw bound.
    const source = frozen.head === null ? undefined : this.frame.messages.get(frozen.head);
    for (let passNo = 1; passNo <= 2; passNo++) {
      const open = await this.delta(api, frozen);
      const stage = this.stage(open, frozen, this.frame, source);
      await this.build(api, stage);
      // closeUsed is structural: delta internally owns HTTP attempts but cannot restart this pass.
      const close = await this.delta(api, stage.start);
      const checked = this.close(stage, close, true, !publish);
      if (checked.relocate) continue;
      const views = this.views(checked);
      assertFinal(views);
      for (const message of checked.frame.messages.values()) if (this.target(message) && message.status === "streaming") throw incomplete();
      if (publish) await this.publish(checked);
      return checked.frame;
    }
    throw incomplete();
  }
  /** Idle without a trusted native source has one H0 closing read, never a future-Run loop. */
  async closeIdle(api: AgentApi): Promise<HistoryFrame> {
    const source = this.committed.head === null ? undefined : this.frame.messages.get(this.committed.head);
    const page = await this.delta(api, this.committed);
    const stage = this.stage(page, this.committed, this.frame, source);
    await this.build(api, stage);
    if (stage.relocate || [...stage.frame.messages.values()].some((message) => isMessageAheadOfSession(message, page.session))) throw incomplete();
    this.validate(stage);
    return stage.frame;
  }
}
