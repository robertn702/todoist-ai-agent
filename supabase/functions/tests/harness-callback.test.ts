import { assert, assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// Env + dynamic import setup
// ---------------------------------------------------------------------------

const RUNNER_SECRET = "callback-secret-0123456789-0123456789-abcdef";
Deno.env.set("HARNESS_RUNNER_SECRET", RUNNER_SECRET);
Deno.env.set("SUPABASE_URL", "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
Deno.env.set("ENCRYPTION_KEY", btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));

const { harnessCallbackHandler: handler, formatHarnessResult } = await import("../harness-callback/handler.ts");
const { encrypt } = await import("../_shared/crypto.ts");
const { signHarnessRequest } = await import("../_shared/harness-auth.ts");
const { ERROR_PREFIX } = await import("../_shared/constants.ts");

const ENCRYPTED_MOCK_TOKEN = await encrypt("test-todoist-token");

const JOB_ID = `job_${"a1".repeat(16)}`;
const USER_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const TODOIST_USER_ID = "12345";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Disable sanitizers — Supabase client starts token refresh intervals
function t(name: string, fn: () => Promise<void>) {
  Deno.test({ name, fn, sanitizeOps: false, sanitizeResources: false });
}

const JSON_HEADERS = { "Content-Type": "application/json" };

interface Call {
  url: string;
  method: string;
  body: string;
  host: string;
  path: string;
}

interface FlowOptions {
  /** Row returned for the harness_jobs lookup; null → unknown job. */
  job?: Record<string, unknown> | null;
  /** Todoist user that owns the job. */
  todoistUserId?: string;
  /** Result of the submitted → terminal claim; [] simulates a duplicate callback. */
  claimResult?: unknown[];
  /** try_claim_event result: false simulates a replayed nonce. */
  nonceFresh?: boolean;
  /** Status for Todoist comment writes (default 200). */
  todoistStatus?: number;
}

function defaultJob(): Record<string, unknown> {
  return {
    id: JOB_ID,
    user_id: USER_UUID,
    todoist_task_id: "task-1",
    progress_comment_id: "progress-9",
    status: "submitted",
  };
}

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
  if (url.includes("/rest/v1/rpc/try_claim_event")) {
    return new Response(String(options.nonceFresh ?? true), { status: 200, headers: JSON_HEADERS });
  }
  if (url.includes("/rest/v1/rpc/increment_ai_requests")) {
    return new Response("null", { status: 200, headers: JSON_HEADERS });
  }
  if (url.includes("/rest/v1/harness_jobs")) {
    if (method === "GET") {
      const job = options.job === undefined ? defaultJob() : options.job;
      return new Response(JSON.stringify(job), { status: 200, headers: JSON_HEADERS });
    }
    // PATCH: re-open (status → submitted) vs. claim (submitted → terminal)
    if (JSON.parse(call.body || "{}").status === "submitted") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(options.claimResult ?? [{ id: JOB_ID }]), {
      status: 200,
      headers: JSON_HEADERS,
    });
  }
  if (url.includes("/rest/v1/users_config")) {
    return new Response(
      JSON.stringify({
        id: USER_UUID,
        todoist_token: ENCRYPTED_MOCK_TOKEN,
        todoist_user_id: options.todoistUserId ?? TODOIST_USER_ID,
      }),
      { status: 200, headers: JSON_HEADERS },
    );
  }
  if (host === "api.todoist.com") {
    const status = options.todoistStatus ?? 200;
    if (status !== 200) return new Response("{}", { status });
    if (path.endsWith("/comments")) {
      return new Response(JSON.stringify({ id: "new-comment" }), { status: 200, headers: JSON_HEADERS });
    }
    return new Response("{}", { status: 200, headers: JSON_HEADERS });
  }
  return new Response("{}", { status: 200, headers: JSON_HEADERS });
}

const isTodoist = (c: Call) => c.host === "api.todoist.com";
const isCommentUpdate = (c: Call) => isTodoist(c) && c.method === "POST" && c.path.includes("/comments/");
const isCommentCreate = (c: Call) => isTodoist(c) && c.method === "POST" && c.path.endsWith("/comments");
const isJobPatch = (c: Call) => c.url.includes("/rest/v1/harness_jobs") && c.method === "PATCH";
const isIncrement = (c: Call) => c.url.includes("/rest/v1/rpc/increment_ai_requests");

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: JOB_ID,
    status: "completed",
    todoist_user_id: TODOIST_USER_ID,
    output: "All done.",
    ...overrides,
  };
}

async function callbackRequest(
  payload: Record<string, unknown> | string,
  sign: Partial<Parameters<typeof signHarnessRequest>[0]> | false = {},
): Promise<Request> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sign !== false) {
    Object.assign(
      headers,
      await signHarnessRequest({
        secret: RUNNER_SECRET,
        direction: "runner-to-edge",
        route: "POST /harness-callback",
        body,
        ...sign,
      }),
    );
  }
  return new Request("http://localhost/harness-callback", { method: "POST", headers, body });
}

async function post(
  payload: Record<string, unknown> | string,
  options: FlowOptions = {},
): Promise<{ res: Response; body: Record<string, unknown>; calls: Call[] }> {
  const { calls, restore } = mockFlow(options);
  try {
    const res = await handler(await callbackRequest(payload));
    return { res, body: await res.json(), calls };
  } finally {
    restore();
  }
}

function updatedCommentContent(calls: Call[]): string {
  const updates = calls.filter(isCommentUpdate);
  assertEquals(updates.length, 1, "expected exactly one progress comment update");
  return JSON.parse(updates[0].body).content;
}

// ============================================================================
// Request authentication
// ============================================================================

t("harnessCallbackHandler: rejects non-POST with 405", async () => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    const res = await handler(new Request("http://localhost/harness-callback", { method }));
    assertEquals(res.status, 405);
    assertEquals((await res.json()).error, "Method not allowed");
  }
});

t("harnessCallbackHandler: rejects unsigned request with 401", async () => {
  const { calls, restore } = mockFlow();
  try {
    const res = await handler(await callbackRequest(validPayload(), false));
    assertEquals(res.status, 401);
    assertEquals(calls.length, 0, "no backend calls before authentication");
  } finally {
    restore();
  }
});

t("harnessCallbackHandler: rejects request signed with the wrong secret with 401", async () => {
  const { calls, restore } = mockFlow();
  try {
    const res = await handler(await callbackRequest(validPayload(), { secret: "x".repeat(40) }));
    assertEquals(res.status, 401);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

t("harnessCallbackHandler: rejects reflected edge-to-runner request with 401", async () => {
  const { calls, restore } = mockFlow();
  try {
    const res = await handler(await callbackRequest(validPayload(), { direction: "edge-to-runner" }));
    assertEquals(res.status, 401);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

t("harnessCallbackHandler: rejects request signed for a different route with 401", async () => {
  const { restore } = mockFlow();
  try {
    const res = await handler(await callbackRequest(validPayload(), { route: "POST /v1/jobs" }));
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

t("harnessCallbackHandler: rejects tampered body with 401", async () => {
  const { restore } = mockFlow();
  try {
    const signed = await callbackRequest(validPayload());
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify(validPayload({ output: "tampered" })),
    });
    const res = await handler(tampered);
    assertEquals(res.status, 401);
  } finally {
    restore();
  }
});

t("harnessCallbackHandler: rejects stale timestamp with 401", async () => {
  const { calls, restore } = mockFlow();
  try {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const res = await handler(await callbackRequest(validPayload(), { nowSeconds: stale }));
    assertEquals(res.status, 401);
    assertEquals(calls.length, 0);
  } finally {
    restore();
  }
});

t("harnessCallbackHandler: rejects replayed nonce with 401 and does not touch the job", async () => {
  const { res, calls } = await post(validPayload(), { nonceFresh: false });
  assertEquals(res.status, 401);
  assertEquals(calls.filter(isJobPatch).length, 0);
  assertEquals(calls.filter(isTodoist).length, 0);
});

t("harnessCallbackHandler: claims the nonce with a callback-scoped event id", async () => {
  const nonce = "n".repeat(24);
  const { calls, restore } = mockFlow();
  try {
    const res = await handler(await callbackRequest(validPayload(), { nonce }));
    assertEquals(res.status, 200);
    const claim = calls.find((c) => c.url.includes("/rpc/try_claim_event"));
    assert(claim);
    assertEquals(JSON.parse(claim.body), { p_event_id: `harness-callback-nonce:${nonce}` });
  } finally {
    restore();
  }
});

t("harnessCallbackHandler: returns 503 when HARNESS_RUNNER_SECRET is not configured", async () => {
  const original = Deno.env.get("HARNESS_RUNNER_SECRET");
  Deno.env.delete("HARNESS_RUNNER_SECRET");
  try {
    const res = await handler(await callbackRequest(validPayload()));
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error, "Not configured");
  } finally {
    if (original) Deno.env.set("HARNESS_RUNNER_SECRET", original);
  }
});

t("harnessCallbackHandler: returns 503 when HARNESS_RUNNER_SECRET is too short", async () => {
  const original = Deno.env.get("HARNESS_RUNNER_SECRET");
  Deno.env.set("HARNESS_RUNNER_SECRET", "short");
  try {
    const res = await handler(await callbackRequest(validPayload()));
    assertEquals(res.status, 503);
  } finally {
    if (original) Deno.env.set("HARNESS_RUNNER_SECRET", original);
  }
});

t("harnessCallbackHandler: rejects oversized payload with 413", async () => {
  const { restore } = mockFlow();
  try {
    const res = await handler(await callbackRequest(validPayload({ output: "x".repeat(64 * 1024 + 1) })));
    assertEquals(res.status, 413);
  } finally {
    restore();
  }
});

// ============================================================================
// Payload validation
// ============================================================================

t("harnessCallbackHandler: rejects invalid JSON (signed) with 400", async () => {
  const { res, body } = await post("not-json{{{");
  assertEquals(res.status, 400);
  assertEquals(body.error, "Invalid JSON");
});

t("harnessCallbackHandler: rejects malformed job_id with 400", async () => {
  for (const jobId of ["job_123", "../etc/passwd", `JOB_${"a".repeat(32)}`, `job_${"g".repeat(32)}`, 42, undefined]) {
    const { res, body, calls } = await post(validPayload({ job_id: jobId }));
    assertEquals(res.status, 400, `job_id ${String(jobId)}`);
    assertEquals(body.error, "Invalid payload");
    assertEquals(calls.filter(isTodoist).length, 0);
    assertEquals(calls.filter(isJobPatch).length, 0);
  }
});

t("harnessCallbackHandler: rejects non-terminal or unknown status with 400", async () => {
  for (const status of ["submitted", "running", "queued", "", 1, undefined]) {
    const { res, body, calls } = await post(validPayload({ status }));
    assertEquals(res.status, 400, `status ${String(status)}`);
    assertEquals(body.error, "Invalid payload");
    assertEquals(calls.filter(isJobPatch).length, 0);
  }
});

t("harnessCallbackHandler: rejects non-string todoist_user_id with 400", async () => {
  const { res } = await post(validPayload({ todoist_user_id: 12345 }));
  assertEquals(res.status, 400);
});

t("harnessCallbackHandler: rejects non-object JSON body with 400", async () => {
  for (const raw of ["[]", "null", '"str"', "7"]) {
    const { res } = await post(raw);
    assertEquals(res.status, 400, raw);
  }
});

// ============================================================================
// Job ownership
// ============================================================================

t("harnessCallbackHandler: unknown job returns 404", async () => {
  const { res, body, calls } = await post(validPayload(), { job: null });
  assertEquals(res.status, 404);
  assertEquals(body.error, "Unknown job");
  assertEquals(calls.filter(isTodoist).length, 0);
  assertEquals(calls.filter(isJobPatch).length, 0);
});

t("harnessCallbackHandler: todoist_user_id not matching the job owner returns 404 without Todoist calls", async () => {
  const { res, body, calls } = await post(validPayload(), { todoistUserId: "99999" });
  assertEquals(res.status, 404);
  assertEquals(body.error, "Unknown job");
  assertEquals(calls.filter(isTodoist).length, 0);
  assertEquals(calls.filter(isJobPatch).length, 0);
  assertEquals(calls.filter(isIncrement).length, 0);
});

// ============================================================================
// Finalization
// ============================================================================

t("harnessCallbackHandler: completed finalizes the job, updates the progress comment, counts the request", async () => {
  const { res, body, calls } = await post(validPayload({ output: "Here is the **result**." }));
  assertEquals(res.status, 200);
  assertEquals(body, { ok: true });

  // Atomic submitted → completed transition
  const patches = calls.filter(isJobPatch);
  assertEquals(patches.length, 1);
  assert(patches[0].url.includes("status=eq.submitted"), patches[0].url);
  assert(patches[0].url.includes(`id=eq.${JOB_ID}`), patches[0].url);
  assertEquals(JSON.parse(patches[0].body), { status: "completed" });

  // Progress comment (not a new one) carries the output
  const content = updatedCommentContent(calls);
  assert(content.includes("Here is the **result**."), content);
  assert(!content.includes(ERROR_PREFIX));
  assert(calls.find(isCommentUpdate)!.path.endsWith("/comments/progress-9"));
  assertEquals(calls.filter(isCommentCreate).length, 0);

  // Usage counted for the Todoist user
  const increments = calls.filter(isIncrement);
  assertEquals(increments.length, 1);
  assertEquals(JSON.parse(increments[0].body), { p_todoist_user_id: TODOIST_USER_ID });
});

t("harnessCallbackHandler: uses the user's Todoist token for the update", async () => {
  const { calls, restore } = mockFlow();
  const seen: string[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    if (String(input).includes("api.todoist.com")) {
      seen.push(new Headers(init?.headers).get("Authorization") ?? "");
    }
    return inner(input as string, init);
  }) as typeof fetch;
  try {
    await handler(await callbackRequest(validPayload()));
    assertEquals(seen, ["Bearer test-todoist-token"]);
    assertEquals(calls.filter(isCommentUpdate).length, 1);
  } finally {
    restore();
  }
});

t("harnessCallbackHandler: completed without a progress comment posts a new comment on the task", async () => {
  const { res, calls } = await post(validPayload(), { job: { ...defaultJob(), progress_comment_id: null } });
  assertEquals(res.status, 200);
  assertEquals(calls.filter(isCommentUpdate).length, 0);
  const creates = calls.filter(isCommentCreate);
  assertEquals(creates.length, 1);
  const sent = JSON.parse(creates[0].body);
  assertEquals(sent.task_id, "task-1");
  assert(sent.content.includes("All done."));
});

t("harnessCallbackHandler: duplicate callback returns duplicate:true without touching Todoist", async () => {
  const { res, body, calls } = await post(validPayload(), { claimResult: [] });
  assertEquals(res.status, 200);
  assertEquals(body, { ok: true, duplicate: true });
  assertEquals(calls.filter(isTodoist).length, 0);
  assertEquals(calls.filter(isIncrement).length, 0);
  assertEquals(calls.filter(isJobPatch).length, 1);
});

t("harnessCallbackHandler: failed with approval_required mentions approval and does not count usage", async () => {
  const { res, calls } = await post(validPayload({ status: "failed", output: null, error_code: "approval_required" }));
  assertEquals(res.status, 200);
  const content = updatedCommentContent(calls);
  assert(content.includes(ERROR_PREFIX), content);
  assert(content.includes("approval"), content);
  assertEquals(JSON.parse(calls.filter(isJobPatch)[0].body), { status: "failed" });
  assertEquals(calls.filter(isIncrement).length, 0);
});

t("harnessCallbackHandler: timed_out reports a timeout", async () => {
  const { res, calls } = await post(validPayload({ status: "timed_out", output: null }));
  assertEquals(res.status, 200);
  const content = updatedCommentContent(calls);
  assert(content.includes(ERROR_PREFIX), content);
  assert(content.includes("timed out"), content);
  assertEquals(JSON.parse(calls.filter(isJobPatch)[0].body), { status: "timed_out" });
  assertEquals(calls.filter(isIncrement).length, 0);
});

t("harnessCallbackHandler: cancelled reports cancellation without an error prefix", async () => {
  const { res, calls } = await post(validPayload({ status: "cancelled", output: null }));
  assertEquals(res.status, 200);
  const content = updatedCommentContent(calls);
  assert(content.includes("cancelled"), content);
  assert(!content.includes(ERROR_PREFIX), content);
  assertEquals(JSON.parse(calls.filter(isJobPatch)[0].body), { status: "cancelled" });
  assertEquals(calls.filter(isIncrement).length, 0);
});

t("harnessCallbackHandler: denied approvals note is appended", async () => {
  const { calls } = await post(validPayload({ denied_approvals: 2 }));
  const content = updatedCommentContent(calls);
  assert(content.includes("All done."), content);
  assert(content.includes("2 action(s)"), content);
  assert(content.includes("denied"), content);
});

t("harnessCallbackHandler: ignores invalid denied_approvals values", async () => {
  for (const denied of [-3, 1.5, "2", null]) {
    const { calls } = await post(validPayload({ denied_approvals: denied }));
    assert(!updatedCommentContent(calls).includes("denied"), `denied_approvals ${String(denied)}`);
  }
});

t("harnessCallbackHandler: Todoist update failure returns 502 and re-opens the job", async () => {
  const { res, body, calls } = await post(validPayload(), { todoistStatus: 500 });
  assertEquals(res.status, 502);
  assertEquals(body.error, "Failed to update Todoist");

  const patches = calls.filter(isJobPatch);
  assertEquals(patches.length, 2);
  assertEquals(JSON.parse(patches[0].body), { status: "completed" });
  assertEquals(JSON.parse(patches[1].body), { status: "submitted" });
  assert(patches[1].url.includes("status=eq.completed"), patches[1].url);
  assert(patches[1].url.includes(`id=eq.${JOB_ID}`), patches[1].url);
  assertEquals(calls.filter(isIncrement).length, 0);
});

// ============================================================================
// formatHarnessResult
// ============================================================================

t("formatHarnessResult: completed returns trimmed output", () => {
  assertEquals(formatHarnessResult("completed", "  hello \n", null, 0), "hello");
  return Promise.resolve();
});

t("formatHarnessResult: completed with empty output uses a placeholder", () => {
  assert(formatHarnessResult("completed", null, null, 0).includes("without a text response"));
  assert(formatHarnessResult("completed", "   ", null, 0).includes("without a text response"));
  return Promise.resolve();
});

t("formatHarnessResult: output at the 14000 char limit is not truncated", () => {
  const exact = "a".repeat(14_000);
  assertEquals(formatHarnessResult("completed", exact, null, 0), exact);
  return Promise.resolve();
});

t("formatHarnessResult: output over 14000 chars is truncated with a marker", () => {
  const result = formatHarnessResult("completed", "a".repeat(20_000), null, 0);
  assert(result.startsWith("a".repeat(14_000)));
  assert(!result.startsWith("a".repeat(14_001)));
  assert(result.endsWith("(response truncated)"));
  assertEquals(result.length, 14_000 + "\n\n…(response truncated)".length);
  return Promise.resolve();
});

t("formatHarnessResult: denied note is kept after truncated output", () => {
  const result = formatHarnessResult("completed", "a".repeat(20_000), null, 1);
  assert(result.includes("(response truncated)"));
  assert(result.endsWith("unattended Todoist runs cannot approve actions._"));
  return Promise.resolve();
});

t("formatHarnessResult: failure messages by error code", () => {
  const cases: Array<[string | null, string]> = [
    ["approval_required", "approval"],
    ["harness_auth_failed", "authenticate"],
    ["harness_unreachable", "unavailable"],
    ["harness_busy", "unavailable"],
    ["runner_restarted", "restarted"],
    ["something_else", "The agent run failed."],
    [null, "The agent run failed."],
  ];
  for (const [code, expected] of cases) {
    const result = formatHarnessResult("failed", "ignored output", code, 0);
    assert(result.startsWith(ERROR_PREFIX), `${code}: ${result}`);
    assert(result.includes(expected), `${code}: ${result}`);
    assert(result.includes("Retry by adding a comment."), `${code}: ${result}`);
    assert(!result.includes("ignored output"), `${code}: ${result}`);
  }
  return Promise.resolve();
});

t("formatHarnessResult: timed_out and cancelled", () => {
  const timedOut = formatHarnessResult("timed_out", null, null, 0);
  assert(timedOut.startsWith(ERROR_PREFIX) && timedOut.includes("timed out"));
  const cancelled = formatHarnessResult("cancelled", null, null, 0);
  assert(cancelled.includes("cancelled") && !cancelled.includes(ERROR_PREFIX));
  assert(formatHarnessResult("cancelled", null, null, 3).includes("3 action(s)"));
  return Promise.resolve();
});
