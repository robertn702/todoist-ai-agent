// Shared test fixtures: a JobManager wired to the mock harnesses.

import { type HermesConfig, HermesAdapter } from "../adapters/hermes.ts";
import { OPENCODE_DEFAULT_PERMISSIONS, OpenCodeAdapter, type OpenCodeConfig } from "../adapters/opencode.ts";
import type { HarnessAdapter, HarnessBackend } from "../adapters/types.ts";
import { type JobRequest, JobManager } from "../jobs.ts";
import { type JobRecord, type JobResult, MemoryStore, type RunnerStore } from "../store.ts";
import { type InstalledFetch, installFetch, MockHermes, MockOpenCode } from "./mock-harness.ts";

export function jobId(n: number): string {
  return `job_${n.toString(16).padStart(32, "0")}`;
}

export function jobReq(n: number, over: Partial<JobRequest> = {}): JobRequest {
  return {
    jobId: jobId(n),
    backend: "opencode",
    todoistUserId: "1001",
    taskId: "task1",
    taskContent: "Buy milk",
    taskDescription: "2% please",
    prompt: `prompt ${n}`,
    ...over,
  };
}

export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Silence the runner's operational logging while a test runs. Returns a restore fn. */
export function silenceConsole(): () => void {
  const saved = { info: console.info, warn: console.warn, error: console.error };
  console.info = console.warn = console.error = () => {};
  return () => Object.assign(console, saved);
}

export interface HarnessOptions {
  opencode?: MockOpenCode;
  hermes?: MockHermes;
  /** Which backends the JobManager has adapters for (default both). */
  enable?: Partial<Record<HarnessBackend, boolean>>;
  opencodeConfig?: Partial<OpenCodeConfig>;
  hermesConfig?: Partial<HermesConfig>;
  store?: RunnerStore;
  timeoutMs?: number;
  pollIntervalMs?: number;
  callbackRetryDelaysMs?: number[];
  maxConsecutivePollErrors?: number;
  maxDenials?: number;
  /** Called on every notify attempt (1-based); throw to simulate a failed callback. */
  onNotify?: (attempt: number) => void | Promise<void>;
}

export function createHarness(opts: HarnessOptions = {}) {
  const opencode = opts.opencode ?? new MockOpenCode();
  const hermes = opts.hermes ?? new MockHermes();
  const fetchMock: InstalledFetch = installFetch({
    [opencode.origin]: opencode.handler,
    [hermes.origin]: hermes.handler,
  });
  const store = opts.store ?? new MemoryStore();

  const adapters: Partial<Record<HarnessBackend, HarnessAdapter>> = {};
  if (opts.enable?.opencode !== false) {
    adapters.opencode = new OpenCodeAdapter({
      baseUrl: opencode.origin,
      username: opencode.username,
      password: opencode.password,
      permissions: OPENCODE_DEFAULT_PERMISSIONS,
      requestTimeoutMs: 1000,
      ...opts.opencodeConfig,
    });
  }
  if (opts.enable?.hermes !== false) {
    adapters.hermes = new HermesAdapter({
      baseUrl: hermes.origin,
      apiKey: hermes.apiKey,
      requestTimeoutMs: 1000,
      ...opts.hermesConfig,
    });
  }

  const attempts: Array<{ job: JobRecord; result: JobResult }> = [];
  const notified: Array<{ job: JobRecord; result: JobResult }> = [];
  const jobs = new JobManager({
    store,
    adapters,
    notify: async (job, result) => {
      attempts.push({ job: { ...job }, result });
      await opts.onNotify?.(attempts.length);
      notified.push({ job: { ...job }, result });
    },
    timeoutMs: opts.timeoutMs ?? 5000,
    pollIntervalMs: opts.pollIntervalMs ?? 5,
    callbackRetryDelaysMs: opts.callbackRetryDelaysMs ?? [],
    maxConsecutivePollErrors: opts.maxConsecutivePollErrors,
    maxDenials: opts.maxDenials,
  });

  const resultFor = (id: string): JobResult | undefined => notified.findLast((n) => n.job.jobId === id)?.result;

  return {
    opencode,
    hermes,
    store,
    jobs,
    attempts,
    notified,
    fetch: fetchMock,
    resultFor,
    /** Submit a job, wait for everything in flight to settle, return its delivered result. */
    async run(req: JobRequest): Promise<JobResult | undefined> {
      await jobs.submit(req);
      await jobs.idle();
      return resultFor(req.jobId);
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;

/** Run `fn` against a fresh harness with quiet logs; always settles jobs and restores globals. */
export async function withHarness(opts: HarnessOptions, fn: (h: Harness) => Promise<void>): Promise<void> {
  const restoreConsole = silenceConsole();
  const h = createHarness(opts);
  try {
    await fn(h);
  } finally {
    await h.jobs.idle();
    h.fetch.restore();
    restoreConsole();
  }
}
