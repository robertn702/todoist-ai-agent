// OpenCode adapter — drives an authenticated `opencode serve` (v2 HTTP API).
//
// Lifecycle used:
//   POST /api/session                       create (or idempotently re-get) a session
//   GET  /api/session/{id}                  verify a mapped session still exists
//   POST /api/session/{id}/prompt           durably admit the turn (async; returns immediately)
//   GET  /api/session/{id}/permission       pending permission requests (denied by policy)
//   POST /api/session/{id}/permission/{p}/reply  reject a permission request
//   GET  /api/session/{id}/message          find the turn's `idle` marker and assistant output
//   POST /api/session/{id}/interrupt        abort the running turn
//
// Session and message IDs are derived from the Todoist job, and OpenCode treats
// a repeated create/prompt with the same ID as a no-op, so retries never start
// a second turn.

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

export interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** Fail-closed default: every tool call asks, and the runner rejects every ask. */
export const OPENCODE_DEFAULT_PERMISSIONS: OpenCodePermissionRule[] = [
  { action: "*", resource: "*", effect: "ask" },
];

export interface OpenCodeConfig {
  baseUrl: string;
  username: string;
  password: string;
  directory?: string;
  agent?: string;
  model?: { providerID: string; id: string };
  permissions: OpenCodePermissionRule[];
  requestTimeoutMs?: number;
}

interface OpenCodeMessage {
  id: string;
  type: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  error?: { type?: string; message?: string };
  content?: Array<{ type: string; text?: string }>;
}

const MAX_MESSAGE_PAGES = 20;

export class OpenCodeAdapter implements HarnessAdapter {
  readonly backend = "opencode" as const;
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(private readonly config: OpenCodeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${btoa(`${config.username}:${config.password}`)}`;
  }

  private async request(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses: number[] = [],
  ): Promise<{ status: number; json: any }> {
    const res = await harnessFetch(
      `${this.baseUrl}${path}`,
      {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      this.config.requestTimeoutMs ?? 30_000,
    );
    const text = await res.text();
    if (!res.ok && !okStatuses.includes(res.status)) {
      throw new HarnessHttpError("opencode", res.status, operation);
    }
    let json: any = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        // `opencode serve` answers unknown routes with its web UI; treat as protocol error.
        throw new HarnessHttpError("opencode", res.status, `${operation} (non-JSON response)`);
      }
    }
    return { status: res.status, json };
  }

  private async createSession(id: string, title: string): Promise<string> {
    const { json } = await this.request("create session", "POST", "/api/session", {
      id,
      title,
      ...(this.config.directory ? { location: { directory: this.config.directory } } : {}),
      ...(this.config.agent ? { agent: this.config.agent } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      permissions: this.config.permissions,
    });
    const sessionId = json?.data?.id;
    if (typeof sessionId !== "string") throw new Error("opencode create session returned no id");
    return sessionId;
  }

  async startTurn(req: StartTurnRequest): Promise<TurnHandle> {
    let sessionId: string | undefined;
    let createdSession = false;

    if (req.sessionId) {
      const { status } = await this.request(
        "get session",
        "GET",
        `/api/session/${encodeURIComponent(req.sessionId)}`,
        undefined,
        [404],
      );
      if (status !== 404) sessionId = req.sessionId;
    }
    if (!sessionId) {
      // Deterministic per task; a vanished mapped session gets a fresh, job-scoped ID.
      const id = req.sessionId
        ? await stableId("ses_td", req.sessionKey, req.jobId)
        : await stableId("ses_td", req.sessionKey);
      sessionId = await this.createSession(id, req.title);
      createdSession = true;
    }

    const turnId = await stableId("msg_td", req.jobId);
    await this.request("submit prompt", "POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      id: turnId,
      text: req.text,
    });
    return { sessionId, turnId, createdSession };
  }

  async poll(handle: TurnHandle): Promise<TurnStatus> {
    const sid = encodeURIComponent(handle.sessionId);
    const { json: perms } = await this.request("list permissions", "GET", `/api/session/${sid}/permission`);
    const pending: PendingApproval[] = (perms?.data ?? [])
      .filter((p: any) => typeof p?.id === "string")
      .map((p: any) => ({
        id: p.id,
        description: [p.action, ...(Array.isArray(p.resources) ? p.resources : [])].filter(Boolean).join(" "),
      }));
    if (pending.length > 0) return { state: "waiting_approval", approvals: pending };

    // Walk newest → oldest until we reach this turn's user message.
    const newer: OpenCodeMessage[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
      const query: string = cursor ? `cursor=${encodeURIComponent(cursor)}` : "order=desc&limit=50";
      const { json } = await this.request("list messages", "GET", `/api/session/${sid}/message?${query}`);
      const messages: OpenCodeMessage[] = json?.data ?? [];
      for (const m of messages) {
        if (m.id === handle.turnId) return this.summarize(newer.reverse());
        newer.push(m);
      }
      cursor = json?.cursor?.next ?? null;
      if (!cursor || messages.length === 0) break;
    }
    // Not yet moved from the inbox into the transcript.
    return { state: "running" };
  }

  /** `messages` are in chronological order, all after this turn's user message. */
  private summarize(messages: OpenCodeMessage[]): TurnStatus {
    const idleIndex = messages.findIndex((m) => m.type === "idle");
    if (idleIndex === -1) return { state: "running" };
    const idle = messages[idleIndex];
    const turn = messages.slice(0, idleIndex);

    if (idle.outcome === "interrupted") return { state: "cancelled" };
    if (idle.outcome === "failed") {
      const err = idle.error ?? [...turn].reverse().find((m) => m.error)?.error;
      return { state: "failed", error: err?.type ?? "opencode turn failed" };
    }
    const output = [...turn]
      .reverse()
      .filter((m) => m.type === "assistant")
      .map((m) => (m.content ?? []).filter((c) => c.type === "text" && c.text).map((c) => c.text).join("\n\n"))
      .find((t) => t.trim().length > 0);
    return { state: "completed", output: output ?? "" };
  }

  async deny(handle: TurnHandle, approval: PendingApproval): Promise<void> {
    await this.request(
      "reject permission",
      "POST",
      `/api/session/${encodeURIComponent(handle.sessionId)}/permission/${encodeURIComponent(approval.id)}/reply`,
      { decision: "reject", message: "Denied: unattended Todoist runs cannot approve actions." },
      [404],
    );
  }

  async cancel(handle: TurnHandle): Promise<void> {
    await this.request(
      "interrupt",
      "POST",
      `/api/session/${encodeURIComponent(handle.sessionId)}/interrupt`,
      undefined,
      [404],
    );
  }
}
