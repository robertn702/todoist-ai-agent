// Hermes adapter — drives the authenticated Hermes API server `/v1/runs` lifecycle.
//
// Lifecycle used:
//   POST /v1/runs                  start a run (Idempotency-Key = Todoist job ID)
//   GET  /v1/runs/{id}             poll status / output / pending approval
//   POST /v1/runs/{id}/approval    deny a pending approval (never approves)
//   POST /v1/runs/{id}/stop        interrupt the run
//
// Session continuity uses `session_id`: the same Todoist task always sends the
// same Hermes session ID, so Hermes loads that session's transcript.
// Point HERMES_BASE_URL at a dedicated profile prefix (…/p/<profile>) so the
// runner never touches the operator's default profile.

import {
  type HarnessAdapter,
  HarnessHttpError,
  type PendingApproval,
  type StartTurnRequest,
  type TurnHandle,
  type TurnStatus,
  harnessFetch,
  stableId,
} from "./types.ts";

export interface HermesConfig {
  baseUrl: string;
  apiKey: string;
  requestTimeoutMs?: number;
}

const RUNNING = new Set(["queued", "started", "running", "stopping"]);

export class HermesAdapter implements HarnessAdapter {
  readonly backend = "hermes" as const;
  private readonly baseUrl: string;

  constructor(private readonly config: HermesConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  private async request(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    okStatuses: number[] = [],
  ): Promise<{ status: number; json: any }> {
    const res = await harnessFetch(
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      this.config.requestTimeoutMs ?? 30_000,
    );
    const text = await res.text();
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new HarnessHttpError("hermes", res.status, operation);
    }
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new HarnessHttpError("hermes", res.status, `${operation} (non-JSON response)`);
    }
    return { status: res.status, json };
  }

  async startTurn(req: StartTurnRequest): Promise<TurnHandle> {
    const sessionId = req.sessionId ?? (await stableId("todoist-", req.sessionKey));
    const { json } = await this.request(
      "start run",
      "POST",
      "/v1/runs",
      { input: req.text, session_id: sessionId },
      { "Idempotency-Key": req.jobId },
    );
    const runId = json?.run_id;
    if (typeof runId !== "string" || !runId) throw new Error("hermes start run returned no run_id");
    return { sessionId, turnId: runId, createdSession: !req.sessionId };
  }

  async poll(handle: TurnHandle): Promise<TurnStatus> {
    const { status: httpStatus, json } = await this.request(
      "get run",
      "GET",
      `/v1/runs/${encodeURIComponent(handle.turnId)}`,
      undefined,
      {},
      [404],
    );
    if (httpStatus === 404) return { state: "failed", error: "run_not_found" };

    const status = String(json?.status ?? "");
    if (status === "waiting_for_approval") {
      return { state: "waiting_approval", approvals: extractApprovals(json) };
    }
    if (RUNNING.has(status)) return { state: "running" };
    if (status === "completed") {
      // A run is never reported completed with completed:false, but be strict anyway.
      if (json?.completed === false || json?.partial === true) {
        return { state: "failed", error: "incomplete_run" };
      }
      return { state: "completed", output: typeof json?.output === "string" ? json.output : "" };
    }
    if (status === "cancelled") return { state: "cancelled" };
    if (status === "failed" || status === "interrupted") {
      return { state: "failed", error: `run_${status}` };
    }
    if (status === "unknown") return { state: "failed", error: "run_outcome_unknown" };
    return { state: "running" };
  }

  async deny(handle: TurnHandle, approval: PendingApproval): Promise<void> {
    await this.request(
      "deny approval",
      "POST",
      `/v1/runs/${encodeURIComponent(handle.turnId)}/approval`,
      {
        choice: "deny",
        ...(approval.id ? { request_id: approval.id } : {}),
        ...(approval.generation !== undefined ? { execution_generation: approval.generation } : {}),
      },
    );
  }

  async cancel(handle: TurnHandle): Promise<void> {
    // 409 = already settled / not active; 404 = expired. Both mean nothing left to stop.
    await this.request("stop run", "POST", `/v1/runs/${encodeURIComponent(handle.turnId)}/stop`, undefined, {}, [
      404,
      409,
    ]);
  }
}

/** Hermes exposes the pending approval as `approval` (legacy) or `pending_controls` (canonical). */
function extractApprovals(json: any): PendingApproval[] {
  const approvals: PendingApproval[] = [];
  const controls = Array.isArray(json?.pending_controls) ? json.pending_controls : [];
  for (const c of controls) {
    const kind = String(c?.kind ?? c?.type ?? c?.method ?? "approval");
    if (!kind.includes("approval")) continue;
    const id = c?.prompt_id ?? c?.request_id ?? c?.id;
    if (typeof id !== "string") continue;
    approvals.push({
      id,
      generation: Number.isInteger(c?.execution_generation) ? c.execution_generation : undefined,
      description: typeof c?.description === "string" ? c.description : undefined,
    });
  }
  if (approvals.length === 0 && json?.approval && typeof json.approval === "object") {
    const a = json.approval;
    const id = a.request_id ?? a.prompt_id ?? a.id;
    approvals.push({
      id: typeof id === "string" ? id : "",
      generation: Number.isInteger(a.execution_generation) ? a.execution_generation : undefined,
      description: typeof a.description === "string" ? a.description : undefined,
    });
  }
  if (approvals.length === 0) approvals.push({ id: "" });
  return approvals;
}
