import { assert, assertEquals, assertMatch } from "@std/assert";

// ---------------------------------------------------------------------------
// Env + dynamic import setup
// ---------------------------------------------------------------------------

const CLIENT_SECRET = "test-client-secret";
Deno.env.set("TODOIST_CLIENT_SECRET", CLIENT_SECRET);
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
Deno.env.set("ENCRYPTION_KEY", btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));

const { webhookHandler: handler } = await import("../webhook/handler.ts");
const { encrypt } = await import("../_shared/crypto.ts");
const { harnessJobId } = await import("../_shared/harness.ts");
const { verifyHarnessRequest } = await import("../_shared/harness-auth.ts");

const ENCRYPTED_MOCK_TOKEN = await encrypt("test-todoist-token");

const RUNNER_URL = "https://runner.example.com";
const RUNNER_SECRET = "runner-secret-0123456789-0123456789-abcdef";
const USER_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TODOIST_USER_ID = "12345";
const EVENT_KEY = `${TODOIST_USER_ID}:note:added:comment-1`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Disable sanitizers — Supabase client starts token refresh intervals
function t(name: string, fn: () => Promise<void>) {
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });
}

async function computeHmac(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function makePayload(content = "@ai Do X", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_name: "note:added",
    user_id: TODOIST_USER_ID,
    initiator: { id: TODOIST_USER_ID },
    event_data: { id: "comment-1", content, item_id: "task-1" },
    ...overrides,
  };
}

async function signedRequest(body: string): Promise<Request> {
  const sig = await computeHmac(CLIENT_SECRET, body);
  return new Request("http://localhost/webhook/12345", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-todoist-hmac-sha256": sig },
    body,
  });
}

/** Deliver a webhook and wait for the detached background processing to finish. */
async function deliver(payload: Record<string, unknown>): Promise<Response> {
  const res = await handler(await signedRequest(JSON.stringify(payload)));
  await new Promise((r) => setTimeout(r, 300));
  return res;
}

const ENV_KEYS = ["HARNESS_RUNNER_URL", "HARNESS_RUNNER_SECRET", "HARNESS_ALLOWED_TODOIST_USER_IDS"] as const;
const HARNESS_ENV = {
  HARNESS_RUNNER_URL: RUNNER_URL,
  HARNESS_RUNNER_SECRET: RUNNER_SECRET,
  HARNESS_ALLOWED_TODOIST_USER_IDS: `${TODOIST_USER_ID},777`,
};

/** Run fn with the given harness env (undefined deletes), restoring previous values afterwards. */
async function withHarnessEnv(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = ENV_KEYS.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of ENV_KEYS) {
    const v = vars[k];
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

interface Call {
  url: string;
  method: string;
  body: string;
  headers: Headers;
  host: string;
  path: string;
}

interface FlowOptions {
  agentBackend?: string | null;
  /** Response for the harness_jobs insert (default 201). */
  insertResponse?: () => Response;
  /** Rows returned for harness_jobs GET (stop command lookup). */
  activeJobs?: unknown[];
  /** Runner behaviour; may throw to simulate an unreachable runner. Default 202. */
  runner?: (call: Call) => Response;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function mockFlow(options: FlowOptions = {}): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = String(input);
    const parsed = new URL(url);
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
      headers: new Headers(init?.headers),
      host: parsed.hostname,
      path: parsed.pathname,
    };
    calls.push(call);
    return Promise.resolve(route(call, options));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function route(call: Call, options: FlowOptions): Response {
  const { url, method, host, path } = call;
  if (url.includes("/rest/v1/users_config")) {
    return new Response(
      JSON.stringify({
        id: USER_UUID,
        todoist_token: ENCRYPTED_MOCK_TOKEN,
        todoist_user_id: TODOIST_USER_ID,
        trigger_word: "@ai",
        custom_ai_base_url: null,
        custom_ai_api_key: null,
        custom_ai_model: null,
        custom_brave_key: null,
        max_messages: 20,
        custom_prompt: null,
        agent_backend: options.agentBackend === undefined ? "opencode" : options.agentBackend,
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  }
  if (url.includes("/rest/v1/rpc/try_claim_event")) {
    return new Response("true", { status: 200, headers: JSON_HEADERS });
  }
  if (url.includes("/rest/v1/rpc/check_rate_limit")) {
    return new Response(JSON.stringify({ allowed: true, blocked: false, retry_after: 0 }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  if (url.includes("/rest/v1/rpc/increment_ai_requests")) {
    return new Response("null", { status: 200, headers: JSON_HEADERS });
  }
  if (url.includes("/rest/v1/harness_jobs")) {
    if (method === "POST") return options.insertResponse?.() ?? new Response(null, { status: 201 });
    if (method === "GET") {
      return new Response(JSON.stringify(options.activeJobs ?? []), { status: 200, headers: JSON_HEADERS });
    }
    return new Response(null, { status: 204 });
  }
  if (host === "api.todoist.com") {
    if (path.endsWith("/comments") && method === "POST") {
      return new Response(JSON.stringify({ id: "progress-1" }), { status: 200, headers: JSON_HEADERS });
    }
    if (path.includes("/comments/") && method === "POST") {
      return new Response("{}", { status: 200, headers: JSON_HEADERS });
    }
    if (path.endsWith("/comments")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: JSON_HEADERS });
    }
    if (path.includes("/tasks/")) {
      return new Response(JSON.stringify({ content: "Ship the report", description: "Q3 numbers" }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    }
  }
  if (host === "runner.example.com") {
    return options.runner ? options.runner(call) : new Response(null, { status: 202 });
  }
  if (host === "api.openai.com") {
    return new Response(JSON.stringify({ choices: [{ message: { content: "AI response", role: "assistant" } }] }), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  return new Response("{}", { status: 200, headers: JSON_HEADERS });
}

const isJobInsert = (c: Call) => c.url.includes("/rest/v1/harness_jobs") && c.method === "POST";
const isJobPatch = (c: Call) => c.url.includes("/rest/v1/harness_jobs") && c.method === "PATCH";
const isProgressCreate = (c: Call) => c.host === "api.todoist.com" && c.method === "POST" && c.path.endsWith("/comments");
const isCommentUpdate = (c: Call) => c.host === "api.todoist.com" && c.method === "POST" && c.path.includes("/comments/");
const isRunnerCall = (c: Call) => c.host === "runner.example.com";
const isAiProviderCall = (c: Call) => c.host === "api.openai.com" || c.host === "api.anthropic.com";
const isIncrement = (c: Call) => c.url.includes("/rest/v1/rpc/increment_ai_requests");

function runnerCalls(calls: Call[]): Call[] {
  return calls.filter(isRunnerCall);
}

function commentUpdateContent(calls: Call[]): string {
  const updates = calls.filter(isCommentUpdate);
  assertEquals(updates.length, 1, "expected exactly one progress comment update");
  return JSON.parse(updates[0].body).content;
}

function assertJobFailed(calls: Call[], jobId: string) {
  const failed = calls.filter((c) => isJobPatch(c) && JSON.parse(c.body).status === "failed");
  assertEquals(failed.length, 1, "job should be marked failed exactly once");
  assert(failed[0].url.includes(`id=eq.${jobId}`));
  assert(failed[0].url.includes("status=eq.submitted"));
}

// ============================================================================
// Routing to the runner
// ============================================================================

t("webhook harness: opencode user is routed to the runner, not the AI provider", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow();
    try {
      const res = await deliver(makePayload("@ai Do X"));
      assertEquals(res.status, 200);

      // Job claimed before side effects
      const inserts = calls.filter(isJobInsert);
      assertEquals(inserts.length, 1);
      const row = JSON.parse(inserts[0].body);
      assertMatch(row.id, /^job_[a-f0-9]{32}$/);
      assertEquals(row.id, await harnessJobId(EVENT_KEY));
      assertEquals(row.backend, "opencode");
      assertEquals(row.todoist_task_id, "task-1");
      assertEquals(row.user_id, USER_UUID);

      // Progress comment posted and linked to the job
      assertEquals(calls.filter(isProgressCreate).length, 1);
      const linked = calls.filter((c) => isJobPatch(c) && JSON.parse(c.body).progress_comment_id === "progress-1");
      assertEquals(linked.length, 1);

      // Signed submit to the runner
      const submits = runnerCalls(calls);
      assertEquals(submits.length, 1);
      assertEquals(submits[0].url, "https://runner.example.com/v1/jobs");
      assertEquals(submits[0].method, "POST");
      const verified = await verifyHarnessRequest({
        secret: RUNNER_SECRET,
        direction: "edge-to-runner",
        route: "POST /v1/jobs",
        body: submits[0].body,
        headers: submits[0].headers,
      });
      assert(verified.ok, "runner request signature should verify");
      const submitted = JSON.parse(submits[0].body);
      assertEquals(submitted.job_id, row.id);
      assertEquals(submitted.backend, "opencode");
      assertEquals(submitted.todoist_user_id, TODOIST_USER_ID);
      assertEquals(submitted.task_id, "task-1");
      assertEquals(submitted.task, { content: "Ship the report", description: "Q3 numbers" });
      assertEquals(submitted.prompt, "@ai Do X");

      // Provider path untouched; job is not finalized by Edge (the runner calls back)
      assertEquals(calls.filter(isAiProviderCall).length, 0);
      assertEquals(calls.filter(isIncrement).length, 0);
      assertEquals(calls.filter(isCommentUpdate).length, 0);
      assertEquals(calls.filter((c) => isJobPatch(c) && "status" in JSON.parse(c.body)).length, 0);
    } finally {
      restore();
    }
  });
});

t("webhook harness: hermes user is routed with backend hermes", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow({ agentBackend: "hermes" });
    try {
      await deliver(makePayload());
      assertEquals(JSON.parse(calls.filter(isJobInsert)[0].body).backend, "hermes");
      const submits = runnerCalls(calls);
      assertEquals(submits.length, 1);
      assertEquals(JSON.parse(submits[0].body).backend, "hermes");
      assertEquals(calls.filter(isAiProviderCall).length, 0);
    } finally {
      restore();
    }
  });
});

t("webhook harness: item events are routed to the runner too", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow();
    try {
      await deliver({
        event_name: "item:added",
        user_id: TODOIST_USER_ID,
        initiator: { id: TODOIST_USER_ID },
    initiator: { id: TODOIST_USER_ID },
        event_data: { id: "task-1", content: "@ai Plan the week", description: "", labels: [] },
      });
      const submits = runnerCalls(calls);
      assertEquals(submits.length, 1);
      assertEquals(JSON.parse(submits[0].body).prompt, "@ai Plan the week");
      assertEquals(JSON.parse(calls.filter(isJobInsert)[0].body).id, await harnessJobId(`${TODOIST_USER_ID}:item:added:task-1`));
      assertEquals(calls.filter(isAiProviderCall).length, 0);
    } finally {
      restore();
    }
  });
});

// ============================================================================
// Idempotency
// ============================================================================

t("webhook harness: the same event delivered twice yields the same job id", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow();
    try {
      await deliver(makePayload());
      await deliver(makePayload());
      const ids = calls.filter(isJobInsert).map((c) => JSON.parse(c.body).id);
      assertEquals(ids.length, 2);
      assertEquals(ids[0], ids[1]);
      assertEquals(ids[0], await harnessJobId(EVENT_KEY));
    } finally {
      restore();
    }
  });
});

t("webhook harness: different events yield different job ids", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow();
    try {
      await deliver(makePayload());
      await deliver(makePayload("@ai Do X", { event_data: { id: "comment-2", content: "@ai Do X", item_id: "task-1" } }));
      const ids = calls.filter(isJobInsert).map((c) => JSON.parse(c.body).id);
      assertEquals(ids.length, 2);
      assert(ids[0] !== ids[1]);
    } finally {
      restore();
    }
  });
});

t("webhook harness: duplicate job insert (23505) posts no comment and calls no runner", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow({
      insertResponse: () =>
        new Response(
          JSON.stringify({ code: "23505", message: 'duplicate key value violates unique constraint "harness_jobs_pkey"' }),
          { status: 409, headers: JSON_HEADERS },
        ),
    });
    try {
      const res = await deliver(makePayload());
      assertEquals(res.status, 200);
      assertEquals(calls.filter(isJobInsert).length, 1);
      assertEquals(calls.filter(isProgressCreate).length, 0);
      assertEquals(calls.filter(isCommentUpdate).length, 0);
      assertEquals(runnerCalls(calls).length, 0);
      assertEquals(calls.filter(isAiProviderCall).length, 0);
      assertEquals(calls.filter(isJobPatch).length, 0);
    } finally {
      restore();
    }
  });
});

// ============================================================================
// Fail-closed configuration
// ============================================================================

t("webhook harness: user not in allowlist → 'not enabled' error, job failed, no runner call", async () => {
  await withHarnessEnv({ ...HARNESS_ENV, HARNESS_ALLOWED_TODOIST_USER_IDS: "777,888" }, async () => {
    const { calls, restore } = mockFlow();
    try {
      await deliver(makePayload());
      assertEquals(runnerCalls(calls).length, 0);
      assertEquals(calls.filter(isAiProviderCall).length, 0);
      const content = commentUpdateContent(calls);
      assert(content.includes("not enabled"), content);
      assert(content.includes("AI agent error"), content);
      assertJobFailed(calls, await harnessJobId(EVENT_KEY));
    } finally {
      restore();
    }
  });
});

t("webhook harness: runner env missing → 'not enabled' error, job failed, no runner call", async () => {
  await withHarnessEnv({}, async () => {
    const { calls, restore } = mockFlow();
    try {
      await deliver(makePayload());
      assertEquals(runnerCalls(calls).length, 0);
      assertEquals(calls.filter(isAiProviderCall).length, 0);
      assert(commentUpdateContent(calls).includes("not enabled"));
      assertJobFailed(calls, await harnessJobId(EVENT_KEY));
    } finally {
      restore();
    }
  });
});

t("webhook harness: runner secret too short → treated as not enabled", async () => {
  await withHarnessEnv({ ...HARNESS_ENV, HARNESS_RUNNER_SECRET: "too-short" }, async () => {
    const { calls, restore } = mockFlow();
    try {
      await deliver(makePayload());
      assertEquals(runnerCalls(calls).length, 0);
      assert(commentUpdateContent(calls).includes("not enabled"));
      assertJobFailed(calls, await harnessJobId(EVENT_KEY));
    } finally {
      restore();
    }
  });
});

// ============================================================================
// Runner failures
// ============================================================================

t("webhook harness: unreachable runner → error comment and job failed", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow({
      runner: () => {
        throw new TypeError("connection refused");
      },
    });
    try {
      await deliver(makePayload());
      assertEquals(runnerCalls(calls).length, 1);
      const content = commentUpdateContent(calls);
      assert(content.includes("AI agent error"), content);
      assert(content.includes("Could not reach the agent runner"), content);
      assertJobFailed(calls, await harnessJobId(EVENT_KEY));
      assertEquals(calls.filter(isAiProviderCall).length, 0);
    } finally {
      restore();
    }
  });
});

for (const status of [401, 403]) {
  t(`webhook harness: runner returns ${status} → error comment and job failed`, async () => {
    await withHarnessEnv(HARNESS_ENV, async () => {
      const { calls, restore } = mockFlow({ runner: () => new Response("{}", { status }) });
      try {
        await deliver(makePayload());
        assertEquals(runnerCalls(calls).length, 1);
        const content = commentUpdateContent(calls);
        assert(content.includes("AI agent error"), content);
        assert(content.includes("rejected"), content);
        assertJobFailed(calls, await harnessJobId(EVENT_KEY));
      } finally {
        restore();
      }
    });
  });
}

t("webhook harness: runner 5xx → treated as unreachable, job failed", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow({ runner: () => new Response("{}", { status: 503 }) });
    try {
      await deliver(makePayload());
      assert(commentUpdateContent(calls).includes("Could not reach the agent runner"));
      assertJobFailed(calls, await harnessJobId(EVENT_KEY));
    } finally {
      restore();
    }
  });
});

// ============================================================================
// Stop command
// ============================================================================

t("webhook harness: '@ai stop' cancels the active job via a signed runner request", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const activeJobId = `job_${"a".repeat(32)}`;
    const { calls, restore } = mockFlow({ activeJobs: [{ id: activeJobId }] });
    try {
      await deliver(makePayload("@ai stop"));

      const cancels = runnerCalls(calls);
      assertEquals(cancels.length, 1);
      assertEquals(cancels[0].url, "https://runner.example.com/v1/jobs/cancel");
      const verified = await verifyHarnessRequest({
        secret: RUNNER_SECRET,
        direction: "edge-to-runner",
        route: "POST /v1/jobs/cancel",
        body: cancels[0].body,
        headers: cancels[0].headers,
      });
      assert(verified.ok, "cancel request signature should verify");
      assertEquals(JSON.parse(cancels[0].body), { job_id: activeJobId, todoist_user_id: TODOIST_USER_ID });

      // Looked up only submitted jobs of this task
      const lookup = calls.find((c) => c.url.includes("/rest/v1/harness_jobs") && c.method === "GET");
      assert(lookup, "expected active job lookup");
      assert(lookup.url.includes("status=eq.submitted"));
      assert(lookup.url.includes("todoist_task_id=eq.task-1"));

      // No new job, no new progress comment, no provider call
      assertEquals(calls.filter(isJobInsert).length, 0);
      assertEquals(calls.filter(isProgressCreate).length, 0);
      assertEquals(calls.filter(isAiProviderCall).length, 0);
    } finally {
      restore();
    }
  });
});

t("webhook harness: '@ai cancel' is also a stop command", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow({ activeJobs: [{ id: `job_${"b".repeat(32)}` }] });
    try {
      await deliver(makePayload("@ai Cancel"));
      assertEquals(runnerCalls(calls).length, 1);
      assertEquals(calls.filter(isJobInsert).length, 0);
    } finally {
      restore();
    }
  });
});

t("webhook harness: '@ai stop' with no active job posts a notice and calls no runner", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow({ activeJobs: [] });
    try {
      await deliver(makePayload("@ai stop"));
      assertEquals(runnerCalls(calls).length, 0);
      const posts = calls.filter(isProgressCreate);
      assertEquals(posts.length, 1);
      assert(JSON.parse(posts[0].body).content.includes("No running agent job to stop"));
      assertEquals(calls.filter(isJobInsert).length, 0);
    } finally {
      restore();
    }
  });
});

t("webhook harness: '@ai stop' rejected by runner posts a could-not-stop notice", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow({
      activeJobs: [{ id: `job_${"c".repeat(32)}` }],
      runner: () => new Response("{}", { status: 404 }),
    });
    try {
      await deliver(makePayload("@ai stop"));
      assertEquals(runnerCalls(calls).length, 1);
      const posts = calls.filter(isProgressCreate);
      assertEquals(posts.length, 1);
      assert(JSON.parse(posts[0].body).content.includes("Could not stop the running agent job"));
    } finally {
      restore();
    }
  });
});

t("webhook harness: a prompt merely containing 'stop' is not a stop command", async () => {
  await withHarnessEnv(HARNESS_ENV, async () => {
    const { calls, restore } = mockFlow({ activeJobs: [{ id: `job_${"d".repeat(32)}` }] });
    try {
      await deliver(makePayload("@ai please stop the build and summarize"));
      assertEquals(calls.filter(isJobInsert).length, 1);
      const submits = runnerCalls(calls);
      assertEquals(submits.length, 1);
      assertEquals(submits[0].url, "https://runner.example.com/v1/jobs");
    } finally {
      restore();
    }
  });
});

// ============================================================================
// Regression: provider path
// ============================================================================

for (const backend of ["provider", null] as const) {
  t(`webhook harness: agent_backend ${JSON.stringify(backend)} still uses the AI provider`, async () => {
    const previous = ["DEFAULT_AI_BASE_URL", "DEFAULT_AI_API_KEY", "DEFAULT_AI_MODEL"].map((k) =>
      [k, Deno.env.get(k)] as const
    );
    Deno.env.set("DEFAULT_AI_BASE_URL", "https://api.openai.com/v1");
    Deno.env.set("DEFAULT_AI_API_KEY", "test-key");
    Deno.env.set("DEFAULT_AI_MODEL", "gpt-4o-mini");
    await withHarnessEnv(HARNESS_ENV, async () => {
      const { calls, restore } = mockFlow({ agentBackend: backend });
      try {
        await deliver(makePayload("@ai What is 2+2?"));
        assertEquals(calls.filter(isAiProviderCall).length, 1);
        assertEquals(calls.filter(isIncrement).length, 1);
        assertEquals(runnerCalls(calls).length, 0);
        assertEquals(calls.filter(isJobInsert).length, 0);
        assertEquals(calls.filter(isJobPatch).length, 0);
      } finally {
        restore();
        for (const [k, v] of previous) {
          if (v === undefined) Deno.env.delete(k);
          else Deno.env.set(k, v);
        }
      }
    });
  });
}

// ============================================================================
// Collaborator-initiated events (shared projects)
// ============================================================================

for (const [name, initiator] of [
  ["a collaborator", { id: "99999" }],
  ["an unknown initiator", undefined],
] as const) {
  t(`webhook harness: events initiated by ${name} never reach the runner`, async () => {
    await withHarnessEnv(HARNESS_ENV, async () => {
      const { calls, restore } = mockFlow();
      try {
        const payload = makePayload("@ai run something");
        if (initiator) payload.initiator = initiator;
        else delete payload.initiator;
        const res = await deliver(payload);
        assertEquals(res.status, 200);
        assertEquals(runnerCalls(calls).length, 0);
        assertEquals(calls.filter(isJobInsert).length, 0);
        assertEquals(calls.filter(isProgressCreate).length, 0);
        assertEquals(calls.filter(isAiProviderCall).length, 0);
      } finally {
        restore();
      }
    });
  });
}
