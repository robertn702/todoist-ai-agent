// Runner HTTP surface. Only two signed, allowlisted operations exist:
//   POST /v1/jobs         start one harness turn for a Todoist event
//   POST /v1/jobs/cancel  cancel a job owned by the same Todoist user
// plus an unauthenticated GET /healthz that reveals nothing.
// There is deliberately no endpoint that accepts commands, paths, URLs,
// models or permissions from the caller.

import {
  signHarnessRequest,
  verifyHarnessRequest,
} from "../supabase/functions/_shared/harness-auth.ts";
import { HARNESS_BACKENDS, type HarnessBackend } from "./adapters/types.ts";
import type { JobManager } from "./jobs.ts";
import type { JobRecord, JobResult } from "./store.ts";

export const ROUTE_SUBMIT = "POST /v1/jobs";
export const ROUTE_CANCEL = "POST /v1/jobs/cancel";
export const ROUTE_CALLBACK = "POST /harness-callback";

export const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_PROMPT_CHARS = 20_000;
const MAX_TASK_CHARS = 20_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const JOB_ID_PATTERN = /^job_[a-f0-9]{32}$/;

/** Remembers nonces for longer than the signature freshness window. */
export class NonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 15 * 60 * 1000, private readonly maxEntries = 100_000) {}

  /** Returns false if the nonce was already used. */
  claim(nonce: string, now = Date.now()): boolean {
    if (this.seen.size >= this.maxEntries) {
      for (const [n, exp] of this.seen) if (exp <= now) this.seen.delete(n);
      if (this.seen.size >= this.maxEntries) return false; // fail closed under flood
    }
    const exp = this.seen.get(nonce);
    if (exp !== undefined && exp > now) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
}

export interface RunnerHandlerOptions {
  secret: string;
  allowedTodoistUserIds: Set<string>;
  jobs: JobManager;
  nonces?: NonceCache;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function readBody(req: Request): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared && parseInt(declared, 10) > MAX_REQUEST_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}

export function createRunnerHandler(opts: RunnerHandlerOptions): (req: Request) => Promise<Response> {
  const nonces = opts.nonces ?? new NonceCache();

  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (req.method === "GET" && path === "/healthz") return json({ ok: true });

    const route = req.method === "POST" && path === "/v1/jobs"
      ? ROUTE_SUBMIT
      : req.method === "POST" && path === "/v1/jobs/cancel"
      ? ROUTE_CANCEL
      : null;
    if (!route) return json({ error: "not_found" }, 404);

    const body = await readBody(req);
    if (body === null) return json({ error: "payload_too_large" }, 413);

    const verified = await verifyHarnessRequest({
      secret: opts.secret,
      direction: "edge-to-runner",
      route,
      body,
      headers: req.headers,
    });
    if (!verified.ok) {
      console.warn("rejected unsigned or invalid runner request", { reason: verified.reason });
      return json({ error: "unauthorized" }, 401);
    }
    if (!nonces.claim(verified.nonce)) {
      console.warn("rejected replayed runner request");
      return json({ error: "replayed" }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const todoistUserId = str(payload.todoist_user_id, 64);
    const jobId = str(payload.job_id, 64);
    if (!todoistUserId || !ID_PATTERN.test(todoistUserId) || !jobId || !JOB_ID_PATTERN.test(jobId)) {
      return json({ error: "invalid_request" }, 400);
    }
    // Authorization: only explicitly allowlisted Todoist users may reach a harness.
    if (!opts.allowedTodoistUserIds.has(todoistUserId)) {
      console.warn("rejected job for non-allowlisted Todoist user");
      return json({ error: "forbidden" }, 403);
    }

    if (route === ROUTE_CANCEL) {
      const result = opts.jobs.cancel(jobId, todoistUserId);
      return json({ job_id: jobId, result }, result === "not_found" ? 404 : 202);
    }

    const backend = payload.backend as HarnessBackend;
    const taskId = str(payload.task_id, 64);
    const prompt = str(payload.prompt, MAX_PROMPT_CHARS);
    const task = (payload.task ?? {}) as Record<string, unknown>;
    const taskContent = str(task.content ?? "", MAX_TASK_CHARS);
    const taskDescription = str(task.description ?? "", MAX_TASK_CHARS);
    if (
      !HARNESS_BACKENDS.includes(backend) || !taskId || !ID_PATTERN.test(taskId) || !prompt?.trim() ||
      taskContent === null || taskDescription === null
    ) {
      return json({ error: "invalid_request" }, 400);
    }
    if (!opts.jobs.isBackendEnabled(backend)) return json({ error: "backend_disabled" }, 409);

    const { duplicate } = await opts.jobs.submit({
      jobId,
      backend,
      todoistUserId,
      taskId,
      taskContent,
      taskDescription,
      prompt,
    });
    return json({ accepted: true, job_id: jobId, duplicate }, 202);
  };
}

/** Build the notifier that reports terminal job results to the Edge callback. */
export function createCallbackNotifier(opts: {
  url: string;
  secret: string;
  timeoutMs?: number;
}): (job: JobRecord, result: JobResult) => Promise<void> {
  return async (job, result) => {
    const body = JSON.stringify({
      job_id: job.jobId,
      todoist_user_id: job.todoistUserId,
      status: result.status,
      output: result.output ?? null,
      error_code: result.error_code ?? null,
      denied_approvals: result.denied_approvals,
    });
    const headers = await signHarnessRequest({
      secret: opts.secret,
      direction: "runner-to-edge",
      route: ROUTE_CALLBACK,
      body,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(opts.url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      await res.body?.cancel();
      if (res.ok) return;
      // Permanent rejections (bad signature, unknown job) will not succeed on retry.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        console.error("callback permanently rejected", { jobId: job.jobId, status: res.status });
        return;
      }
      throw new Error(`callback HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
