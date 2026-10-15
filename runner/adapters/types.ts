export type HarnessBackend = "opencode" | "hermes";

export const HARNESS_BACKENDS: readonly HarnessBackend[] = ["opencode", "hermes"];

export interface StartTurnRequest {
  /** Previously mapped harness session for this Todoist task, if any. */
  sessionId?: string;
  /** Stable per-(backend, Todoist user, task) key. */
  sessionKey: string;
  /** Stable job ID derived from the Todoist event; used for harness idempotency. */
  jobId: string;
  title: string;
  text: string;
}

export interface TurnHandle {
  sessionId: string;
  /** Harness-side identifier for this turn (OpenCode message ID or Hermes run ID). */
  turnId: string;
  /** True when this turn started a new harness session. */
  createdSession: boolean;
}

export interface PendingApproval {
  id: string;
  generation?: number;
  description?: string;
}

export type TurnStatus =
  | { state: "running" }
  | { state: "waiting_approval"; approvals: PendingApproval[] }
  | { state: "completed"; output: string }
  | { state: "failed"; error: string }
  | { state: "cancelled" };

/**
 * A harness adapter drives one external agent harness through its real
 * session/run lifecycle. The generic job driver handles polling, timeouts,
 * cancellation and the fail-closed approval policy.
 */
export interface HarnessAdapter {
  readonly backend: HarnessBackend;
  startTurn(req: StartTurnRequest): Promise<TurnHandle>;
  poll(handle: TurnHandle): Promise<TurnStatus>;
  /** Deny a pending approval/permission request. Never approves. */
  deny(handle: TurnHandle, approval: PendingApproval): Promise<void>;
  cancel(handle: TurnHandle): Promise<void>;
}

export class HarnessHttpError extends Error {
  constructor(
    readonly backend: HarnessBackend,
    readonly status: number,
    readonly operation: string,
  ) {
    super(`${backend} ${operation} failed with HTTP ${status}`);
  }
}

export async function stableId(prefix: string, ...parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\u0000")),
  );
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${hex.slice(0, 26)}`;
}

/**
 * fetch with a per-request timeout that also covers reading the body (a harness
 * that sends headers and then stalls cannot hang a job); never follows redirects.
 */
export async function harnessFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, redirect: "manual", signal: controller.signal });
    const text = await res.text();
    const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(nullBody ? null : text, { status: res.status, headers: res.headers });
  } finally {
    clearTimeout(timer);
  }
}
