import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  HARNESS_HEADER_NONCE,
  type HarnessDirection,
  signHarnessRequest,
  verifyHarnessRequest,
} from "../../supabase/functions/_shared/harness-auth.ts";
import {
  createCallbackNotifier,
  createRunnerHandler,
  MAX_REQUEST_BYTES,
  NonceCache,
  ROUTE_CALLBACK,
  ROUTE_CANCEL,
  ROUTE_SUBMIT,
} from "../server.ts";
import type { JobRecord, JobResult } from "../store.ts";
import { type Harness, type HarnessOptions, jobId, silenceConsole, waitFor, withHarness } from "./helpers.ts";
import { installFetch, json } from "./mock-harness.ts";

const SECRET = "test-secret-".repeat(4);

interface SignOpts {
  secret?: string;
  direction?: HarnessDirection;
  route?: string;
  nowSeconds?: number;
  nonce?: string;
  /** Send this body instead of the signed one. */
  sendBody?: string;
}

async function signed(path: string, payload: unknown, o: SignOpts = {}): Promise<Request> {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = await signHarnessRequest({
    secret: o.secret ?? SECRET,
    direction: o.direction ?? "edge-to-runner",
    route: o.route ?? (path === "/v1/jobs/cancel" ? ROUTE_CANCEL : ROUTE_SUBMIT),
    body,
    nowSeconds: o.nowSeconds,
    nonce: o.nonce,
  });
  return new Request(`http://runner.test${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: o.sendBody ?? body,
  });
}

function submitPayload(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    job_id: jobId(n),
    todoist_user_id: "1001",
    backend: "opencode",
    task_id: "task1",
    task: { content: "Buy milk", description: "2%" },
    prompt: "do it",
    ...over,
  };
}

interface Ctx {
  h: Harness;
  handler: (req: Request) => Promise<Response>;
  submits: () => number;
}

async function withServer(
  fn: (c: Ctx) => Promise<void>,
  opts: HarnessOptions & { allowed?: string[] } = {},
): Promise<void> {
  await withHarness(opts, async (h) => {
    let submits = 0;
    const original = h.jobs.submit.bind(h.jobs);
    h.jobs.submit = (r) => {
      submits++;
      return original(r);
    };
    const handler = createRunnerHandler({
      secret: SECRET,
      allowedTodoistUserIds: new Set(opts.allowed ?? ["1001"]),
      jobs: h.jobs,
    });
    await fn({ h, handler, submits: () => submits });
  });
}

Deno.test("server: GET /healthz is open and reveals nothing; unknown routes are 404", async () => {
  await withServer(async ({ handler }) => {
    const ok = await handler(new Request("http://runner.test/healthz"));
    assertEquals(ok.status, 200);
    assertEquals(await ok.json(), { ok: true });

    for (const [method, path] of [["GET", "/nope"], ["GET", "/v1/jobs"], ["POST", "/v1/other"], ["POST", "/healthz"]]) {
      const res = await handler(new Request(`http://runner.test${path}`, { method }));
      assertEquals(res.status, 404, `${method} ${path}`);
      await res.body?.cancel();
    }
  });
});

Deno.test("server: authentication failures are all 401 and never submit a job", async () => {
  await withServer(async ({ handler, submits }) => {
    const payload = submitPayload(1);
    const now = Math.floor(Date.now() / 1000);
    const cases: Record<string, Request> = {
      unsigned: new Request("http://runner.test/v1/jobs", { method: "POST", body: JSON.stringify(payload) }),
      "wrong secret": await signed("/v1/jobs", payload, { secret: "another-secret-".repeat(3) }),
      "reflected runner-to-edge": await signed("/v1/jobs", payload, { direction: "runner-to-edge" }),
      "stale timestamp": await signed("/v1/jobs", payload, { nowSeconds: now - 1000 }),
      "future timestamp": await signed("/v1/jobs", payload, { nowSeconds: now + 1000 }),
      "body tampered": await signed("/v1/jobs", payload, {
        sendBody: JSON.stringify({ ...payload, prompt: "rm -rf /" }),
      }),
      "signed for the cancel route, sent to submit": await signed("/v1/jobs", payload, { route: ROUTE_CANCEL }),
      "signed for the callback route": await signed("/v1/jobs", payload, { route: ROUTE_CALLBACK }),
    };
    for (const [name, req] of Object.entries(cases)) {
      const res = await handler(req);
      assertEquals(res.status, 401, name);
      await res.body?.cancel();
    }
    assertEquals(submits(), 0);
  });
});

Deno.test("server: a replayed request (same nonce) is rejected the second time", async () => {
  await withServer(async ({ handler, submits, h }) => {
    const nonce = "n".repeat(24);
    const payload = submitPayload(1);
    const first = await handler(await signed("/v1/jobs", payload, { nonce }));
    assertEquals(first.status, 202);
    await first.body?.cancel();
    const second = await handler(await signed("/v1/jobs", payload, { nonce }));
    assertEquals(second.status, 401);
    await second.body?.cancel();
    await h.jobs.idle();
    assertEquals(submits(), 1);
  });
});

Deno.test("server: a non-allowlisted Todoist user gets 403 and no job is submitted", async () => {
  await withServer(async ({ handler, submits, h }) => {
    const res = await handler(await signed("/v1/jobs", submitPayload(1, { todoist_user_id: "6666" })));
    assertEquals(res.status, 403);
    await res.body?.cancel();
    const cancel = await handler(
      await signed("/v1/jobs/cancel", { job_id: jobId(1), todoist_user_id: "6666" }),
    );
    assertEquals(cancel.status, 403);
    await cancel.body?.cancel();
    assertEquals(submits(), 0);
    assertEquals(h.store.listJobs().length, 0);
    assertEquals(h.fetch.calls.length, 0);
  });
});

Deno.test("server: malformed requests are 400", async () => {
  await withServer(async ({ handler, submits }) => {
    const bad: Record<string, unknown> = {
      "invalid job_id format": submitPayload(1, { job_id: "job_ABC" }),
      "job_id wrong prefix": submitPayload(1, { job_id: `x${jobId(1).slice(1)}` }),
      "missing job_id": submitPayload(1, { job_id: undefined }),
      "missing prompt": submitPayload(1, { prompt: undefined }),
      "blank prompt": submitPayload(1, { prompt: "   " }),
      "oversize prompt": submitPayload(1, { prompt: "x".repeat(20_001) }),
      "unknown backend": submitPayload(1, { backend: "claude" }),
      "missing backend": submitPayload(1, { backend: undefined }),
      "missing task_id": submitPayload(1, { task_id: undefined }),
      "bad task_id": submitPayload(1, { task_id: "../etc" }),
      "bad todoist_user_id": submitPayload(1, { todoist_user_id: "1001;drop" }),
      "task content not a string": submitPayload(1, { task: { content: 5, description: "" } }),
      "not json": "not json at all",
      "json array": "[1,2,3]",
    };
    for (const [name, payload] of Object.entries(bad)) {
      const res = await handler(await signed("/v1/jobs", payload));
      assertEquals(res.status, 400, name);
      await res.body?.cancel();
    }
    assertEquals(submits(), 0);
  });
});

Deno.test("server: a disabled backend is 409", async () => {
  await withServer(async ({ handler, submits }) => {
    const res = await handler(await signed("/v1/jobs", submitPayload(1, { backend: "hermes" })));
    assertEquals(res.status, 409);
    await res.body?.cancel();
    assertEquals(submits(), 0);
  }, { enable: { hermes: false } });
});

Deno.test("server: oversize bodies are 413 (streamed and declared)", async () => {
  await withServer(async ({ handler, submits }) => {
    const big = "x".repeat(MAX_REQUEST_BYTES + 1);
    const streamed = await handler(new Request("http://runner.test/v1/jobs", { method: "POST", body: big }));
    assertEquals(streamed.status, 413);
    await streamed.body?.cancel();

    const declared = await handler(
      new Request("http://runner.test/v1/jobs", {
        method: "POST",
        headers: { "content-length": String(MAX_REQUEST_BYTES + 1) },
        body: "{}",
      }),
    );
    assertEquals(declared.status, 413);
    await declared.body?.cancel();

    // Even a correctly signed oversize body is refused.
    const signedBig = await handler(await signed("/v1/jobs", big));
    assertEquals(signedBig.status, 413);
    await signedBig.body?.cancel();
    assertEquals(submits(), 0);
  });
});

Deno.test("server: a valid request is accepted once; a replay with a new nonce is a duplicate", async () => {
  await withServer(async ({ handler, h }) => {
    const payload = submitPayload(1);
    const first = await handler(await signed("/v1/jobs", payload));
    assertEquals(first.status, 202);
    assertEquals(await first.json(), { accepted: true, job_id: jobId(1), duplicate: false });

    const second = await handler(await signed("/v1/jobs", payload)); // fresh nonce
    assertEquals(second.status, 202);
    assertEquals(await second.json(), { accepted: true, job_id: jobId(1), duplicate: true });

    await h.jobs.idle();
    assertEquals(h.opencode.prompts.length, 1);
    assertEquals(h.resultFor(jobId(1))?.status, "completed");
    const text = h.opencode.prompts[0].text;
    assert(text.includes("Todoist task: Buy milk") && text.includes("Request:\ndo it"));
  });
});

Deno.test("server: cancel is user-scoped and works on a running job", async () => {
  await withServer(async ({ handler, h }) => {
    h.opencode.mode = "hang";
    const accepted = await handler(await signed("/v1/jobs", submitPayload(1)));
    assertEquals(accepted.status, 202);
    await accepted.body?.cancel();
    await waitFor(() => !!h.store.getJob(jobId(1))?.handle);

    const cancel = (user: string, id = jobId(1)) =>
      signed("/v1/jobs/cancel", { job_id: id, todoist_user_id: user }).then(handler);

    // Another allowlisted user cannot see or cancel this job.
    const other = await cancel("1002");
    assertEquals(other.status, 404);
    assertEquals(await other.json(), { job_id: jobId(1), result: "not_found" });
    assertEquals(h.opencode.interrupts.length, 0);

    const unknown = await cancel("1001", jobId(2));
    assertEquals(unknown.status, 404);
    await unknown.body?.cancel();

    const mine = await cancel("1001");
    assertEquals(mine.status, 202);
    assertEquals(await mine.json(), { job_id: jobId(1), result: "cancelling" });
    await h.jobs.idle();
    assertEquals(h.opencode.interrupts.length, 1);
    assertEquals(h.resultFor(jobId(1))?.status, "cancelled");

    const again = await cancel("1001");
    assertEquals(again.status, 202);
    assertEquals(await again.json(), { job_id: jobId(1), result: "finished" });
  }, { allowed: ["1001", "1002"] });
});

Deno.test("NonceCache: rejects reuse inside the TTL, allows it after, and fails closed when flooded", () => {
  const cache = new NonceCache(1000, 2);
  assertEquals(cache.claim("a", 0), true);
  assertEquals(cache.claim("a", 500), false);
  assertEquals(cache.claim("b", 600), true);
  assertEquals(cache.claim("c", 700), false); // full of live entries → refuse
  assertEquals(cache.claim("a", 1001), true); // expired
  assertEquals(cache.claim("c", 1700), true); // expired entries are evicted to make room
});

// ---------------------------------------------------------------------------
// Callback notifier (runner → Edge)
// ---------------------------------------------------------------------------

const EDGE = "https://edge.test";
const CALLBACK_URL = `${EDGE}/functions/v1/harness-callback`;

const job: JobRecord = {
  jobId: jobId(1),
  backend: "opencode",
  todoistUserId: "1001",
  taskId: "task1",
  sessionKey: "opencode:1001:task1",
  state: "completed",
  callbackDelivered: false,
  createdAt: 1,
  updatedAt: 1,
};
const result: JobResult = { status: "completed", output: "all done", denied_approvals: 2 };

Deno.test("callback notifier: request is signed runner-to-edge for POST /harness-callback", async () => {
  const restoreConsole = silenceConsole();
  let seen: { headers: Headers; body: string; method: string; redirect: string } | undefined;
  const fetchMock = installFetch({
    [EDGE]: async (req) => {
      seen = { headers: req.headers, body: await req.text(), method: req.method, redirect: req.redirect };
      return json({ ok: true });
    },
  });
  try {
    await createCallbackNotifier({ url: CALLBACK_URL, secret: SECRET })(job, result);
    assert(seen);
    assertEquals(seen.method, "POST");
    assertEquals(ROUTE_CALLBACK, "POST /harness-callback");
    assertEquals(JSON.parse(seen.body), {
      job_id: jobId(1),
      todoist_user_id: "1001",
      status: "completed",
      output: "all done",
      error_code: null,
      denied_approvals: 2,
    });

    const verify = (direction: HarnessDirection, route: string, secret = SECRET) =>
      verifyHarnessRequest({ secret, direction, route, body: seen!.body, headers: seen!.headers });
    assertEquals((await verify("runner-to-edge", "POST /harness-callback")).ok, true);
    // Not usable as a request in the other direction, on another route, or with another secret.
    assertEquals((await verify("edge-to-runner", "POST /harness-callback")).ok, false);
    assertEquals((await verify("runner-to-edge", ROUTE_SUBMIT)).ok, false);
    assertEquals((await verify("runner-to-edge", ROUTE_CALLBACK, "z".repeat(40))).ok, false);
    assert(seen.headers.get(HARNESS_HEADER_NONCE));
    assertEquals(fetchMock.calls.length, 1);
  } finally {
    fetchMock.restore();
    restoreConsole();
  }
});

Deno.test("callback notifier: every attempt uses a fresh nonce", async () => {
  const restoreConsole = silenceConsole();
  const nonces: string[] = [];
  const fetchMock = installFetch({
    [EDGE]: (req) => {
      nonces.push(req.headers.get(HARNESS_HEADER_NONCE)!);
      return json({ ok: true });
    },
  });
  try {
    const notify = createCallbackNotifier({ url: CALLBACK_URL, secret: SECRET });
    await notify(job, result);
    await notify(job, result);
    assertEquals(new Set(nonces).size, 2);
  } finally {
    fetchMock.restore();
    restoreConsole();
  }
});

Deno.test("callback notifier: 5xx/408/429 throw (retryable); other 4xx do not (permanent)", async () => {
  const restoreConsole = silenceConsole();
  let status = 200;
  const fetchMock = installFetch({ [EDGE]: () => json({ error: "x" }, status) });
  try {
    const notify = createCallbackNotifier({ url: CALLBACK_URL, secret: SECRET });
    for (const s of [500, 502, 503, 408, 429]) {
      status = s;
      await assertRejects(() => notify(job, result), Error, `HTTP ${s}`);
    }
    for (const s of [200, 202, 400, 401, 403, 404, 409]) {
      status = s;
      await notify(job, result); // resolves
    }
  } finally {
    fetchMock.restore();
    restoreConsole();
  }
});

Deno.test("callback notifier: network errors propagate so delivery is retried", async () => {
  const restoreConsole = silenceConsole();
  const fetchMock = installFetch({}); // no route for the edge origin → fetch rejects
  try {
    const notify = createCallbackNotifier({ url: CALLBACK_URL, secret: SECRET });
    await assertRejects(() => notify(job, result), TypeError);
  } finally {
    fetchMock.restore();
    restoreConsole();
  }
});
