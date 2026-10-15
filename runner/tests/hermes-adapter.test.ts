import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { HermesAdapter } from "../adapters/hermes.ts";
import { sessionKeyFor } from "../jobs.ts";
import { jobId, jobReq, waitFor, withHarness } from "./helpers.ts";

const hermesReq = (n: number, over = {}) => jobReq(n, { backend: "hermes", ...over });

Deno.test("hermes: Idempotency-Key is the job id; first turn carries task context", async () => {
  await withHarness({}, async (h) => {
    const req = hermesReq(1);
    const result = await h.run(req);

    assertEquals(h.hermes.startRequests.length, 1);
    const start = h.hermes.startRequests[0];
    assertEquals(start.idempotencyKey, req.jobId);
    assertStringIncludes(start.input, "Todoist task: Buy milk");
    assertStringIncludes(start.input, "Request:\nprompt 1");
    assertEquals(result?.status, "completed");
    assertEquals(result?.output, `turn 1 in ${start.session_id}`);
    assertEquals(h.store.getSession(sessionKeyFor("hermes", "1001", "task1"))?.sessionId, start.session_id);
  });
});

Deno.test("hermes: session_id is stable across turns of a task, different across tasks, output proves continuity", async () => {
  await withHarness({}, async (h) => {
    const r1 = await h.run(hermesReq(1));
    const r2 = await h.run(hermesReq(2));
    const r3 = await h.run(hermesReq(3, { taskId: "task2" }));

    const [s1, s2, s3] = h.hermes.startRequests;
    assertEquals(s1.session_id, s2.session_id);
    assertNotEquals(s1.session_id, s3.session_id);
    assertEquals(s2.input, "prompt 2"); // follow-up sends only the prompt
    assertEquals(r1?.output, `turn 1 in ${s1.session_id}`);
    assertEquals(r2?.output, `turn 2 in ${s1.session_id}`);
    assertEquals(r3?.output, `turn 1 in ${s3.session_id}`);
    assertEquals(h.hermes.transcripts.get(s1.session_id)?.length, 2);
    assertEquals(h.hermes.transcripts.get(s3.session_id)?.length, 1);
    // Idempotency keys are unique per job.
    assertEquals(h.hermes.startRequests.map((s) => s.idempotencyKey), [jobId(1), jobId(2), jobId(3)]);
  });
});

Deno.test("hermes: replaying a start with the same Idempotency-Key returns the same run and starts nothing new", async () => {
  await withHarness({}, async (h) => {
    const adapter = new HermesAdapter({ baseUrl: h.hermes.origin, apiKey: h.hermes.apiKey });
    const req = { sessionKey: "hermes:1001:task1", jobId: jobId(1), title: "t", text: "hello" };
    const a = await adapter.startTurn(req);
    const b = await adapter.startTurn({ ...req, sessionId: a.sessionId });

    assertEquals(b.turnId, a.turnId);
    assertEquals(h.hermes.runs.size, 1);
    assertEquals(h.hermes.startRequests.map((s) => s.replayed), [false, true]);
    assertEquals(h.hermes.transcripts.get(a.sessionId)?.length, 1);
  });
});

Deno.test("hermes: output arrives only once the run reports completed", async () => {
  await withHarness({}, async (h) => {
    h.hermes.afterPolls = 3;
    const result = await h.run(hermesReq(1));
    assertEquals(result?.status, "completed");
    const gets = h.fetch.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/runs/"));
    assertEquals(gets.length, 4);
  });
});

for (const shape of ["legacy", "controls"] as const) {
  Deno.test(`hermes: approval (${shape} shape) is denied, never approved`, async () => {
    await withHarness({}, async (h) => {
      h.hermes.mode = "approval";
      h.hermes.approvalShape = shape;
      const result = await h.run(hermesReq(1));

      assertEquals(result?.status, "completed");
      assert(result!.denied_approvals >= 1);
      assertEquals(h.hermes.approvals.length, 1);
      const a = h.hermes.approvals[0];
      assertEquals(a.choice, "deny");
      assertEquals(a.request_id, "apr_1");
      assertEquals(a.execution_generation, shape === "controls" ? 3 : undefined);
      for (const x of h.hermes.approvals) assert(!["once", "session", "always", "allow", "approve"].includes(x.choice));
      assertEquals(h.hermes.stops.length, 0);
    });
  });
}

Deno.test("hermes: if denying fails, the run is stopped and fails approval_required", async () => {
  await withHarness({}, async (h) => {
    h.hermes.mode = "approval";
    h.hermes.approvalStatus = 500;
    const result = await h.run(hermesReq(1));

    assertEquals(result?.status, "failed");
    assertEquals(result?.error_code, "approval_required");
    assertEquals(h.hermes.approvals[0].choice, "deny");
    assertEquals(h.hermes.stops.length, 1);
  });
});

Deno.test("hermes: timeout stops the run and reports timed_out", async () => {
  await withHarness({ timeoutMs: 60 }, async (h) => {
    h.hermes.mode = "hang";
    const result = await h.run(hermesReq(1));
    assertEquals(result?.status, "timed_out");
    assertEquals(h.hermes.stops.length, 1);
    assertEquals([...h.hermes.runs.values()][0].status, "stopping");
  });
});

Deno.test("hermes: cancel stops the run; wrong user and finished jobs are reported", async () => {
  await withHarness({}, async (h) => {
    h.hermes.mode = "hang";
    const req = hermesReq(1);
    await h.jobs.submit(req);
    await waitFor(() => !!h.store.getJob(req.jobId)?.handle);

    assertEquals(h.jobs.cancel(req.jobId, "9999"), "not_found");
    assertEquals(h.hermes.stops.length, 0);
    assertEquals(h.jobs.cancel(req.jobId, "1001"), "cancelling");
    await h.jobs.idle();

    assertEquals(h.hermes.stops.length, 1);
    assertEquals(h.resultFor(req.jobId)?.status, "cancelled");
    assertEquals(h.jobs.cancel(req.jobId, "1001"), "finished");
  });
});

Deno.test("hermes: failed and unknown run outcomes map to failed / harness_error", async () => {
  for (const mode of ["fail", "unknown"] as const) {
    await withHarness({}, async (h) => {
      h.hermes.mode = mode;
      const result = await h.run(hermesReq(1));
      assertEquals(result, { status: "failed", error_code: "harness_error", denied_approvals: 0 });
    });
  }
});

Deno.test("hermes: a run that disappears (404) fails the job", async () => {
  await withHarness({}, async (h) => {
    h.hermes.mode = "hang";
    const req = hermesReq(1);
    await h.jobs.submit(req);
    await waitFor(() => h.hermes.runs.size === 1 && !!h.store.getJob(req.jobId)?.handle);
    h.hermes.forgetRuns();
    await h.jobs.idle();
    assertEquals(h.resultFor(req.jobId), { status: "failed", error_code: "harness_error", denied_approvals: 0 });
  });
});

Deno.test("hermes: bad API key at start maps to failed / harness_auth_failed", async () => {
  await withHarness({ hermesConfig: { apiKey: "wrong-key" } }, async (h) => {
    const result = await h.run(hermesReq(1));
    assertEquals(result, { status: "failed", error_code: "harness_auth_failed", denied_approvals: 0 });
    assertEquals(h.hermes.runs.size, 0);
  });
});

Deno.test("hermes: cancel on an already-finished run is tolerated (409)", async () => {
  await withHarness({}, async (h) => {
    const req = hermesReq(1);
    await h.run(req);
    const handle = h.store.getJob(req.jobId)!.handle!;
    const adapter = new HermesAdapter({ baseUrl: h.hermes.origin, apiKey: h.hermes.apiKey });
    await adapter.cancel(handle); // must not throw
    assertEquals(h.hermes.stops, [handle.turnId]);
  });
});
