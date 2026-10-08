import type { ScheduledTaskService } from "./scheduled-task.service.js";

/** One API process owns the in-memory timer; the claim transaction/SQL indexes own correctness. */
export class ScheduledTaskScheduler {
  private phase: "starting" | "running" = "starting";
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private pending: Promise<void> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;
  constructor(private readonly service: ScheduledTaskService,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => {}) {}

  start() {
    if (this.stopped || this.timer) return;
    this.initialize();
    this.timer = setInterval(() => {
      if (this.phase === "starting") this.initialize();
      else void this.tick();
    }, 1000);
    this.timer.unref?.();
  }
  private initialize() {
    try {
      this.service.reconcileActive(true);
      this.service.silentCatchUp(this.now());
      this.phase = "running";
    } catch (error) { this.onError(error); }
  }

  tick(): Promise<void> {
    if (this.stopped || this.phase !== "running" || this.busy) return Promise.resolve();
    this.busy = true;
    const pending = this.scan().finally(() => {
      this.busy = false;
      this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
  private async scan() {
    try {
      this.service.reconcileActive();
      const scanNow = this.now();
      const due = this.service.due(scanNow);
      const claimed = [] as Array<NonNullable<ReturnType<ScheduledTaskService["claim"]>>>;
      // Claims are short transactions. Do not wait for one Agent startup before
      // claiming the other due tasks (or permitting the next timer scan).
      for (const item of due) {
        if (this.stopped) return;
        try {
          const execution = this.service.claim(item.workspaceId, item.taskId, item.scheduledFor, scanNow);
          if (execution?.status === "starting") claimed.push(execution);
        } catch (error) { this.onError(error); }
      }
      for (const execution of claimed) {
        if (this.stopped) return;
        let work!: Promise<void>;
        work = Promise.resolve().then(() => this.service.execute(execution))
          .then(() => {}, (error) => { this.onError(error); })
          .finally(() => { this.inFlight.delete(work); });
        this.inFlight.add(work);
      }
    } catch (error) { this.onError(error); }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending;
    // Do not close the database while an accepted startup is still running.
    await Promise.allSettled([...this.inFlight]);
  }
}
