// deno-lint-ignore-file no-explicit-any -- harness responses are untrusted JSON, validated field by field
// In-process mock harness servers for the runner tests.
//
// Each mock is a `(req: Request) => Promise<Response>` handler that models the
// real HTTP API exactly as the adapters call it. `installFetch` routes
// `globalThis.fetch` by origin to these handlers, so no network is needed.

export type Handler = (req: Request) => Response | Promise<Response>;
/** Fault-injection hook: return a Response to short-circuit the mock's own routing. */
export type Override = (req: Request, path: string) => Response | Promise<Response> | undefined;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// fetch installer
// ---------------------------------------------------------------------------

export interface RecordedCall {
  method: string;
  url: string;
  origin: string;
  path: string;
  search: string;
  headers: Headers;
  body: string;
}

export interface InstalledFetch {
  calls: RecordedCall[];
  restore: () => void;
}

/** Replace `globalThis.fetch`, routing by URL origin. Unknown origins throw like a network error. */
export function installFetch(routes: Record<string, Handler>): InstalledFetch {
  const original = globalThis.fetch;
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const handler = routes[url.origin];
    if (!handler) throw new TypeError(`mock fetch: no route for ${url.origin}`);
    calls.push({
      method: req.method,
      url: req.url,
      origin: url.origin,
      path: url.pathname,
      search: url.search,
      headers: req.headers,
      body: await req.clone().text(),
    });
    return await handler(req);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------------------------------------------------------------------------
// MockOpenCode  (`opencode serve` v2 API)
// ---------------------------------------------------------------------------

export type OpenCodeMode = "reply" | "permission" | "hang" | "fail";

interface OcMessage {
  id: string;
  type: "user" | "assistant" | "idle";
  text?: string;
  content?: Array<{ type: string; text: string }>;
  finish?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  error?: { type: string };
}

interface OcPermission {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
}

interface OcTurn {
  messageId: string;
  n: number;
  text: string;
  mode: OpenCodeMode;
  pollsLeft: number;
}

export interface OcSession {
  id: string;
  title: string;
  /** Raw body of the create request (permissions, location, agent, model…). */
  createBody: Record<string, any>;
  /** Chronological transcript. */
  messages: OcMessage[];
  permissions: OcPermission[];
  promptIds: Map<string, OcMessage>;
  turnCount: number;
  turn?: OcTurn;
}

export class MockOpenCode {
  readonly username = "opencode";
  /** Behaviour for turns started from now on. */
  mode: OpenCodeMode = "reply";
  /** `reply` / `fail` turns finish after this many message-list polls (0 = on prompt). */
  afterPolls = 0;
  /** Extra intermediate assistant messages emitted before the final one. */
  fillerMessages = 0;
  /** Page size of the message list (exercises cursor pagination). */
  pageSize = 50;
  /** Status returned by the permission reply route; 204 = success. */
  permissionReplyStatus = 204;
  reply: (text: string, sessionTurnCount: number) => string = (_text, n) => `reply ${n}`;
  override?: Override;

  // Recorded state for assertions.
  readonly sessions = new Map<string, OcSession>();
  readonly prompts: Array<{ sessionId: string; id: string; text: string }> = [];
  promptRequests = 0;
  readonly decisions: Array<
    { sessionId: string; permissionId: string; decision: string; message?: string; status: number }
  > = [];
  readonly interrupts: string[] = [];
  /** Ordered `prompt:n` / `complete:n` markers, for ordering assertions. */
  readonly events: string[] = [];

  private seq = 0;

  constructor(readonly password = "oc-secret", readonly origin = "http://opencode.test") {}

  readonly handler: Handler = (req) => this.handle(req);

  /** Simulate a session that disappeared from the server (e.g. server data wiped). */
  forgetSession(id: string): void {
    this.sessions.delete(id);
  }

  private nextId(prefix: string): string {
    return `${prefix}_mock${String(++this.seq).padStart(4, "0")}`;
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.headers.get("authorization") !== `Basic ${btoa(`${this.username}:${this.password}`)}`) {
      return json({ error: "unauthorized" }, 401);
    }
    const forced = await this.override?.(req, path);
    if (forced) return forced;

    if (req.method === "POST" && path === "/api/session") {
      return this.createSession(await readJson(req));
    }
    const m = path.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/);
    if (!m) return html();
    const sessionId = decodeURIComponent(m[1]);
    const rest = m[2] ?? "";

    if (req.method === "POST" && rest === "interrupt") {
      this.interrupts.push(sessionId);
      const s = this.sessions.get(sessionId);
      if (!s) return json({ _tag: "SessionNotFoundError" }, 404);
      if (s.turn) {
        s.turn = undefined;
        s.permissions = [];
        s.messages.push({ id: this.nextId("msg"), type: "idle", outcome: "interrupted" });
      }
      return json({ interrupted: true });
    }

    const s = this.sessions.get(sessionId);
    const known = ["", "prompt", "permission", "message"].includes(rest) || /^permission\/[^/]+\/reply$/.test(rest);
    if (!known) return html();
    if (!s) return json({ _tag: "SessionNotFoundError" }, 404);

    if (req.method === "GET" && rest === "") return json({ data: { id: s.id, title: s.title } });
    if (req.method === "POST" && rest === "prompt") return this.prompt(s, await readJson(req));
    if (req.method === "GET" && rest === "permission") return json({ data: s.permissions });
    const reply = rest.match(/^permission\/([^/]+)\/reply$/);
    if (req.method === "POST" && reply) {
      return this.permissionReply(s, decodeURIComponent(reply[1]), await readJson(req));
    }
    if (req.method === "GET" && rest === "message") return this.messages(s, url);
    return html();
  }

  private createSession(body: Record<string, any>): Response {
    const id = String(body.id ?? this.nextId("ses"));
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        title: String(body.title ?? ""),
        createBody: body,
        messages: [],
        permissions: [],
        promptIds: new Map(),
        turnCount: 0,
      };
      this.sessions.set(id, s);
    }
    return json({ data: { id: s.id, title: s.title } });
  }

  private prompt(s: OcSession, body: Record<string, any>): Response {
    this.promptRequests++;
    const id = String(body.id);
    const text = String(body.text ?? "");
    let msg = s.promptIds.get(id);
    if (!msg) {
      msg = { id, type: "user", text };
      s.promptIds.set(id, msg);
      s.messages.push(msg);
      s.turnCount++;
      this.prompts.push({ sessionId: s.id, id, text });
      this.events.push(`prompt:${s.turnCount}`);
      s.turn = { messageId: id, n: s.turnCount, text, mode: this.mode, pollsLeft: this.afterPolls };
      if (this.mode === "permission") {
        s.permissions = [{ id: "per_x", sessionID: s.id, action: "bash", resources: ["rm -rf /"] }];
      } else if ((this.mode === "reply" || this.mode === "fail") && this.afterPolls === 0) {
        this.finish(s);
      }
    }
    return json({ data: { id: msg.id, sessionID: s.id, type: "user", payload: { text: msg.text } } });
  }

  private permissionReply(s: OcSession, permissionId: string, body: Record<string, any>): Response {
    const pending = s.permissions.find((p) => p.id === permissionId);
    if (!pending) return json({ _tag: "PermissionNotFoundError" }, 404);
    this.decisions.push({
      sessionId: s.id,
      permissionId,
      decision: String(body.decision),
      message: body.message,
      status: this.permissionReplyStatus,
    });
    if (this.permissionReplyStatus !== 204) return json({ error: "boom" }, this.permissionReplyStatus);
    s.permissions = s.permissions.filter((p) => p.id !== permissionId);
    if (s.turn && s.permissions.length === 0) this.finish(s);
    return new Response(null, { status: 204 });
  }

  private messages(s: OcSession, url: URL): Response {
    const newestFirst = [...s.messages].reverse();
    const cursor = url.searchParams.get("cursor");
    const offset = cursor ? Number(cursor) : 0;
    const requested = cursor ? this.pageSize : Number(url.searchParams.get("limit") ?? this.pageSize);
    const size = Math.max(1, Math.min(requested || this.pageSize, this.pageSize));
    const page = newestFirst.slice(offset, offset + size);
    const body = {
      data: page,
      cursor: {
        previous: offset > 0 ? String(Math.max(0, offset - size)) : null,
        next: offset + size < newestFirst.length ? String(offset + size) : null,
      },
    };
    // Time passes between polls: let timed turns advance after serving this poll.
    const turn = s.turn;
    if (turn && (turn.mode === "reply" || turn.mode === "fail") && turn.pollsLeft > 0) {
      turn.pollsLeft--;
      if (turn.pollsLeft === 0) this.finish(s);
    }
    return json(body);
  }

  private finish(s: OcSession): void {
    const turn = s.turn;
    if (!turn) return;
    s.turn = undefined;
    if (turn.mode === "fail") {
      s.messages.push({ id: this.nextId("msg"), type: "idle", outcome: "failed", error: { type: "provider.auth" } });
    } else {
      for (let i = 0; i < this.fillerMessages; i++) {
        s.messages.push({
          id: this.nextId("msg"),
          type: "assistant",
          content: [{ type: "text", text: `thinking ${i}` }],
        });
      }
      s.messages.push({
        id: this.nextId("msg"),
        type: "assistant",
        content: [{ type: "text", text: this.reply(turn.text, turn.n) }],
        finish: "stop",
      });
      s.messages.push({ id: this.nextId("msg"), type: "idle", outcome: "succeeded" });
    }
    this.events.push(`complete:${turn.n}`);
  }
}

/** Real `opencode serve` answers unknown routes with its web UI. */
function html(): Response {
  return new Response("<!doctype html><html><body>opencode</body></html>", {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

// ---------------------------------------------------------------------------
// MockHermes  (Hermes API server /v1/runs)
// ---------------------------------------------------------------------------

export type HermesMode = "complete" | "approval" | "hang" | "fail" | "unknown";

interface HermesRun {
  run_id: string;
  session_id: string;
  input: string;
  turn: number;
  status: string;
  mode: HermesMode;
  pollsLeft: number;
  output?: string;
  error?: string;
}

const HERMES_TERMINAL = new Set(["completed", "failed", "cancelled", "unknown"]);

export class MockHermes {
  mode: HermesMode = "complete";
  /** `complete` runs report `running` for this many polls before completing. */
  afterPolls = 0;
  /** `legacy` → `approval` object; `controls` → canonical `pending_controls` list. */
  approvalShape: "legacy" | "controls" = "legacy";
  /** Status returned by the approval route; 200 = success. */
  approvalStatus = 200;
  override?: Override;

  readonly runs = new Map<string, HermesRun>();
  /** Per-session user inputs; the run output proves which transcript it ran against. */
  readonly transcripts = new Map<string, string[]>();
  readonly startRequests: Array<
    { idempotencyKey: string | null; input: string; session_id: string; replayed: boolean }
  > = [];
  readonly approvals: Array<
    {
      runId: string;
      choice: string;
      request_id?: string;
      execution_generation?: number;
      status: number;
    }
  > = [];
  readonly stops: string[] = [];

  private readonly byKey = new Map<string, string>();
  private seq = 0;

  constructor(readonly apiKey = "hermes-key", readonly origin = "http://hermes.test") {}

  readonly handler: Handler = (req) => this.handle(req);

  /** Simulate runs expiring from the server. */
  forgetRuns(): void {
    this.runs.clear();
  }

  private async handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (req.headers.get("authorization") !== `Bearer ${this.apiKey}`) {
      return json({ error: { code: "gateway_auth_failed" } }, 401);
    }
    const forced = await this.override?.(req, path);
    if (forced) return forced;

    if (req.method === "POST" && path === "/v1/runs") return this.start(req, await readJson(req));
    const m = path.match(/^\/v1\/runs\/([^/]+)(?:\/(approval|stop))?$/);
    if (!m) return json({ error: { code: "not_found" } }, 404);
    const runId = decodeURIComponent(m[1]);
    const run = this.runs.get(runId);
    if (!run) {
      if (req.method === "POST" && m[2] === "stop") this.stops.push(runId); // recorded even if the run expired
      return json({ error: { code: "run_not_found" } }, 404);
    }

    if (req.method === "GET" && !m[2]) return json(this.view(run));
    if (req.method === "POST" && m[2] === "approval") return this.approve(run, await readJson(req));
    if (req.method === "POST" && m[2] === "stop") return this.stop(run);
    return json({ error: { code: "not_found" } }, 404);
  }

  private start(req: Request, body: Record<string, any>): Response {
    if (typeof body.input !== "string" || typeof body.session_id !== "string") {
      return json({ error: { code: "invalid_request" } }, 400);
    }
    const key = req.headers.get("idempotency-key");
    const existing = key ? this.byKey.get(key) : undefined;
    this.startRequests.push({
      idempotencyKey: key,
      input: body.input,
      session_id: body.session_id,
      replayed: !!existing,
    });
    if (existing) return json({ run_id: existing, status: "started", replayed: true }, 202);

    const transcript = this.transcripts.get(body.session_id) ?? [];
    transcript.push(body.input);
    this.transcripts.set(body.session_id, transcript);

    const run: HermesRun = {
      run_id: `run_mock${String(++this.seq).padStart(4, "0")}`,
      session_id: body.session_id,
      input: body.input,
      turn: transcript.length,
      status: "queued",
      mode: this.mode,
      pollsLeft: this.afterPolls,
    };
    this.runs.set(run.run_id, run);
    if (key) this.byKey.set(key, run.run_id);
    return json({ run_id: run.run_id, status: "started" }, 202);
  }

  /** Advance the run one poll and return its public representation. */
  private view(run: HermesRun): Record<string, unknown> {
    if (run.status === "stopping") run.status = "cancelled";
    else if (!HERMES_TERMINAL.has(run.status)) {
      switch (run.mode) {
        case "hang":
          run.status = "running";
          break;
        case "complete":
          if (run.pollsLeft > 0) {
            run.pollsLeft--;
            run.status = "running";
          } else {
            this.complete(run);
          }
          break;
        case "approval":
          run.status = "waiting_for_approval";
          break;
        case "fail":
          run.status = "failed";
          run.error = "boom";
          break;
        case "unknown":
          run.status = "unknown";
          break;
      }
    }
    const out: Record<string, unknown> = {
      object: "hermes.run",
      run_id: run.run_id,
      status: run.status,
      session_id: run.session_id,
    };
    if (run.output !== undefined) out.output = run.output;
    if (run.error !== undefined) out.error = run.error;
    if (run.status === "waiting_for_approval") {
      if (this.approvalShape === "controls") {
        out.pending_controls = [{
          kind: "approval",
          prompt_id: "apr_1",
          execution_generation: 3,
          description: "rm -rf /",
        }];
      } else {
        out.approval = { request_id: "apr_1", description: "rm -rf /" };
      }
    }
    return out;
  }

  private complete(run: HermesRun): void {
    run.status = "completed";
    run.output = `turn ${run.turn} in ${run.session_id}`;
  }

  private approve(run: HermesRun, body: Record<string, any>): Response {
    this.approvals.push({
      runId: run.run_id,
      choice: String(body.choice),
      request_id: body.request_id,
      execution_generation: body.execution_generation,
      status: run.status === "waiting_for_approval" ? this.approvalStatus : 409,
    });
    if (run.status !== "waiting_for_approval") return json({ error: { code: "no_pending_approval" } }, 409);
    if (this.approvalStatus !== 200) return json({ error: { code: "boom" } }, this.approvalStatus);
    this.complete(run);
    return json({ run_id: run.run_id, status: "running" });
  }

  private stop(run: HermesRun): Response {
    this.stops.push(run.run_id);
    if (HERMES_TERMINAL.has(run.status)) return json({ error: { code: "run_not_active" } }, 409);
    run.status = "stopping";
    return json({ run_id: run.run_id, status: "stopping" });
  }
}
