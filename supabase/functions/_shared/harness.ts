// Edge-side client for the external harness runner (OpenCode / Hermes).
// The runner is operator-hosted; Edge only ever sends signed, allowlisted
// "run this Todoist turn" and "cancel this job" requests to it.

import { parseAllowlist, sha256Hex, signHarnessRequest } from "./harness-auth.ts";

export type HarnessBackend = "opencode" | "hermes";
export type AgentBackend = "provider" | HarnessBackend;

export const AGENT_BACKENDS: readonly AgentBackend[] = ["provider", "opencode", "hermes"];
export const HARNESS_BACKENDS: readonly HarnessBackend[] = ["opencode", "hermes"];

export const RUNNER_ROUTE_SUBMIT = "POST /v1/jobs";
export const RUNNER_ROUTE_CANCEL = "POST /v1/jobs/cancel";
export const CALLBACK_ROUTE = "POST /harness-callback";

const RUNNER_TIMEOUT_MS = 15_000;
const MAX_PROMPT_CHARS = 20_000;

export function isHarnessBackend(value: unknown): value is HarnessBackend {
  return HARNESS_BACKENDS.includes(value as HarnessBackend);
}

export interface HarnessEdgeConfig {
  runnerUrl: string;
  secret: string;
  allowedTodoistUserIds: Set<string>;
}

/** Returns null (feature disabled) unless every required setting is present. */
export function getHarnessEdgeConfig(): HarnessEdgeConfig | null {
  const runnerUrl = Deno.env.get("HARNESS_RUNNER_URL")?.trim().replace(/\/+$/, "");
  const secret = Deno.env.get("HARNESS_RUNNER_SECRET")?.trim();
  const allowed = parseAllowlist(Deno.env.get("HARNESS_ALLOWED_TODOIST_USER_IDS"));
  if (!runnerUrl || !secret || secret.length < 32 || allowed.size === 0) return null;
  try {
    const url = new URL(runnerUrl);
    // Plain HTTP only for local development (`supabase functions serve` → host runner).
    const local = ["localhost", "127.0.0.1", "host.docker.internal"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
    if (url.username || url.password) return null;
  } catch {
    return null;
  }
  return { runnerUrl, secret, allowedTodoistUserIds: allowed };
}

/** Whether this Todoist user may use external harness backends at all. */
export function isHarnessAllowed(todoistUserId: string, config = getHarnessEdgeConfig()): boolean {
  return !!config && config.allowedTodoistUserIds.has(String(todoistUserId));
}

export async function harnessJobId(eventKey: string): Promise<string> {
  return `job_${(await sha256Hex(`todoist-event:${eventKey}`)).slice(0, 32)}`;
}

/** "@ai stop" / "@ai cancel" (any trigger word) cancels the task's running harness job. */
export function isStopCommand(content: string, triggerWord: string): boolean {
  const escaped = triggerWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rest = content.replace(new RegExp(escaped, "ig"), "").trim().toLowerCase();
  return rest === "stop" || rest === "cancel" || rest === "/stop" || rest === "/cancel";
}

async function postToRunner(
  config: HarnessEdgeConfig,
  route: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers = await signHarnessRequest({
    secret: config.secret,
    direction: "edge-to-runner",
    route,
    body,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNNER_TIMEOUT_MS);
  try {
    return await fetch(`${config.runnerUrl}${path}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
      redirect: "error",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export interface SubmitHarnessJob {
  jobId: string;
  backend: HarnessBackend;
  todoistUserId: string;
  taskId: string;
  taskContent: string;
  taskDescription: string;
  prompt: string;
}

export class HarnessSubmitError extends Error {
  constructor(readonly code: "runner_unreachable" | "runner_rejected" | "backend_disabled", status?: number) {
    super(`Harness runner submit failed: ${code}${status ? ` (${status})` : ""}`);
  }
}

export async function submitHarnessJob(config: HarnessEdgeConfig, job: SubmitHarnessJob): Promise<void> {
  let res: Response;
  try {
    res = await postToRunner(config, RUNNER_ROUTE_SUBMIT, "/v1/jobs", {
      job_id: job.jobId,
      backend: job.backend,
      todoist_user_id: job.todoistUserId,
      task_id: job.taskId,
      task: {
        content: job.taskContent.slice(0, MAX_PROMPT_CHARS),
        description: job.taskDescription.slice(0, MAX_PROMPT_CHARS),
      },
      prompt: job.prompt.slice(0, MAX_PROMPT_CHARS),
    });
  } catch {
    throw new HarnessSubmitError("runner_unreachable");
  }
  await res.body?.cancel();
  if (res.status === 202) return;
  if (res.status === 409) throw new HarnessSubmitError("backend_disabled", res.status);
  if (res.status >= 500) throw new HarnessSubmitError("runner_unreachable", res.status);
  throw new HarnessSubmitError("runner_rejected", res.status);
}

export async function cancelHarnessJob(
  config: HarnessEdgeConfig,
  jobId: string,
  todoistUserId: string,
): Promise<boolean> {
  try {
    const res = await postToRunner(config, RUNNER_ROUTE_CANCEL, "/v1/jobs/cancel", {
      job_id: jobId,
      todoist_user_id: todoistUserId,
    });
    await res.body?.cancel();
    return res.status === 202;
  } catch {
    return false;
  }
}
