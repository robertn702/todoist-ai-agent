// Generic job driver: one Todoist event → one harness turn.
//
// - Idempotent: a job ID is accepted once; replays return `duplicate`.
// - Serialized per task: turns for the same (backend, user, task) run in order
//   on that task's harness session; other tasks run concurrently.
// - Bounded: every job has a wall-clock timeout and can be cancelled.
// - Fail closed: approval/permission requests are always denied, never granted.

import type {
  HarnessAdapter,
  HarnessBackend,
  TurnHandle,
} from "./adapters/types.ts";
import { HarnessHttpError } from "./adapters/types.ts";
import type { JobRecord, JobResult, RunnerStore } from "./store.ts";

export interface JobRequest {
  jobId: string;
  backend: HarnessBackend;
  todoistUserId: string;
  taskId: string;
  taskContent: string;
  taskDescription: string;
  prompt: string;
}

export interface JobManagerOptions {
  store: RunnerStore;
  adapters: Partial<Record<HarnessBackend, HarnessAdapter>>;
  /** Deliver a terminal result to the Edge callback. Throws on failure. */
  notify: (job: JobRecord, result: JobResult) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs: number;
  callbackRetryDelaysMs?: number[];
  maxConsecutivePollErrors?: number;
  maxDenials?: number;
}

export const MAX_OUTPUT_CHARS = 14_000;

export function sessionKeyFor(backend: string, todoistUserId: string, taskId: string): string {
  return `${backend}:${todoistUserId}:${taskId}`;
}

class Cancelled extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n…(response truncated)`;
}

function composeText(req: JobRequest, firstTurn: boolean): string {
  if (!firstTurn) return req.prompt;
  const parts = [`Todoist task: ${req.taskContent}`];
  if (req.taskDescription.trim()) parts.push(`Task description:\n${req.taskDescription}`);
  parts.push(`Request:\n${req.prompt}`);
  return parts.join("\n\n");
}

function errorCode(e: unknown): string {
  if (e instanceof HarnessHttpError) {
    if (e.status === 401 || e.status === 403) return "harness_auth_failed";
    if (e.status === 429 || e.status === 503) return "harness_busy";
    return "harness_error";
  }
  return "harness_unreachable";
}

export class JobManager {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly opts: JobManagerOptions) {}

  isBackendEnabled(backend: HarnessBackend): boolean {
    return !!this.opts.adapters[backend];
  }

  async submit(req: JobRequest): Promise<{ duplicate: boolean }> {
    if (this.opts.store.getJob(req.jobId)) return { duplicate: true };
    const adapter = this.opts.adapters[req.backend];
    if (!adapter) throw new Error(`backend ${req.backend} is not enabled`);

    const now = Date.now();
    const job: JobRecord = {
      jobId: req.jobId,
      backend: req.backend,
      todoistUserId: req.todoistUserId,
      taskId: req.taskId,
      sessionKey: sessionKeyFor(req.backend, req.todoistUserId, req.taskId),
      state: "running",
      callbackDelivered: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.opts.store.putJob(job);

    const controller = new AbortController();
    this.controllers.set(job.jobId, controller);
    const previous = this.queues.get(job.sessionKey) ?? Promise.resolve();
    const run = previous
      .then(() => this.execute(job, req, adapter, controller.signal))
      .catch((e) => console.error("job execution crashed", { jobId: job.jobId, error: String(e) }))
      .finally(() => {
        this.controllers.delete(job.jobId);
        if (this.queues.get(job.sessionKey) === run) this.queues.delete(job.sessionKey);
        this.inflight.delete(run);
      });
    this.queues.set(job.sessionKey, run);
    this.inflight.add(run);
    return { duplicate: false };
  }

  cancel(jobId: string, todoistUserId: string): "cancelling" | "not_found" | "finished" {
    const job = this.opts.store.getJob(jobId);
    if (!job || job.todoistUserId !== todoistUserId) return "not_found";
    const controller = this.controllers.get(jobId);
    if (job.state !== "running" || !controller) return "finished";
    controller.abort(new Cancelled());
    return "cancelling";
  }

  /** Startup recovery: settle jobs orphaned by a restart and redeliver callbacks. */
  async recover(): Promise<void> {
    for (const job of this.opts.store.listJobs()) {
      if (job.state === "running" && !this.controllers.has(job.jobId)) {
        if (job.handle) await this.safeCancel(job.backend, job.handle);
        await this.finish(job, { status: "failed", error_code: "runner_restarted", denied_approvals: 0 });
      } else if (job.state !== "running" && !job.callbackDelivered && job.result) {
        await this.deliver(job, job.result);
      }
    }
  }

  /** Resolve once all in-flight jobs have settled (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private async execute(
    job: JobRecord,
    req: JobRequest,
    adapter: HarnessAdapter,
    cancelSignal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + this.opts.timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.opts.timeoutMs);
    const wake = AbortSignal.any([cancelSignal, timeout.signal]);
    let denied = 0;
    let handle: TurnHandle | undefined;

    try {
      if (cancelSignal.aborted) throw new Cancelled();

      const mapped = this.opts.store.getSession(job.sessionKey);
      try {
        handle = await adapter.startTurn({
          sessionId: mapped?.sessionId,
          sessionKey: job.sessionKey,
          jobId: job.jobId,
          title: `Todoist: ${req.taskContent}`.slice(0, 120),
          text: composeText(req, !mapped),
        });
      } catch (e) {
        console.error("harness start failed", { jobId: job.jobId, backend: job.backend, error: String(e) });
        return await this.finish(job, { status: "failed", error_code: errorCode(e), denied_approvals: 0 });
      }
      job.handle = handle;
      await this.opts.store.putJob(job);
      await this.opts.store.setSession(job.sessionKey, handle.sessionId);

      let pollErrors = 0;
      while (true) {
        if (cancelSignal.aborted) throw new Cancelled();
        if (Date.now() >= deadline || timeout.signal.aborted) {
          await this.safeCancel(job.backend, handle);
          return await this.finish(job, { status: "timed_out", denied_approvals: denied });
        }

        let status;
        try {
          status = await adapter.poll(handle);
          pollErrors = 0;
        } catch (e) {
          pollErrors++;
          console.warn("harness poll failed", { jobId: job.jobId, attempt: pollErrors, error: String(e) });
          if (pollErrors >= (this.opts.maxConsecutivePollErrors ?? 5)) {
            await this.safeCancel(job.backend, handle);
            return await this.finish(job, { status: "failed", error_code: errorCode(e), denied_approvals: denied });
          }
          await sleep(this.opts.pollIntervalMs, wake);
          continue;
        }

        switch (status.state) {
          case "completed":
            return await this.finish(job, {
              status: "completed",
              output: truncate(status.output),
              denied_approvals: denied,
            });
          case "failed":
            console.warn("harness turn failed", { jobId: job.jobId, error: status.error });
            return await this.finish(job, { status: "failed", error_code: "harness_error", denied_approvals: denied });
          case "cancelled":
            return await this.finish(job, { status: "cancelled", denied_approvals: denied });
          case "waiting_approval": {
            for (const approval of status.approvals) {
              if (denied >= (this.opts.maxDenials ?? 10)) {
                await this.safeCancel(job.backend, handle);
                return await this.finish(job, {
                  status: "failed",
                  error_code: "approval_required",
                  denied_approvals: denied,
                });
              }
              try {
                await adapter.deny(handle, approval);
                denied++;
                console.info("denied harness approval request", { jobId: job.jobId, backend: job.backend });
              } catch (e) {
                console.warn("could not deny approval; stopping run", { jobId: job.jobId, error: String(e) });
                await this.safeCancel(job.backend, handle);
                return await this.finish(job, {
                  status: "failed",
                  error_code: "approval_required",
                  denied_approvals: denied,
                });
              }
            }
            break;
          }
          case "running":
            break;
        }
        await sleep(this.opts.pollIntervalMs, wake);
      }
    } catch (e) {
      if (e instanceof Cancelled || cancelSignal.aborted) {
        if (handle) await this.safeCancel(job.backend, handle);
        return await this.finish(job, { status: "cancelled", denied_approvals: denied });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeCancel(backend: HarnessBackend, handle: TurnHandle): Promise<void> {
    try {
      await this.opts.adapters[backend]?.cancel(handle);
    } catch (e) {
      console.warn("harness cancel failed", { backend, error: String(e) });
    }
  }

  private async finish(job: JobRecord, result: JobResult): Promise<void> {
    job.state = result.status;
    job.result = result;
    await this.opts.store.putJob(job);
    await this.deliver(job, result);
  }

  private async deliver(job: JobRecord, result: JobResult): Promise<void> {
    const delays = this.opts.callbackRetryDelaysMs ?? [1_000, 5_000, 15_000, 60_000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await this.opts.notify(job, result);
        job.callbackDelivered = true;
        await this.opts.store.putJob(job);
        return;
      } catch (e) {
        console.warn("callback delivery failed", { jobId: job.jobId, attempt, error: String(e) });
        if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
    console.error("callback delivery gave up; will retry on restart", { jobId: job.jobId });
  }
}
