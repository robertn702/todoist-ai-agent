import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { OPENCODE_DEFAULT_PERMISSIONS } from "../adapters/opencode.ts";
import { MAX_OUTPUT_CHARS, sessionKeyFor } from "../jobs.ts";
import { jobId, jobReq, waitFor, withHarness } from "./helpers.ts";
import { json } from "./mock-harness.ts";

const KEY = sessionKeyFor("opencode", "1001", "task1");

Deno.test("opencode: first job creates a session with default permissions and delivers output", async () => {
  await withHarness({}, async (h) => {
    const req = jobReq(1);
    const result = await h.run(req);

    assertEquals(result, { status: "completed", output: "reply 1", denied_approvals: 0 });
    assertEquals(h.opencode.sessions.size, 1);
    const [session] = [...h.opencode.sessions.values()];
    assertEquals(session.createBody.permissions, [{ action: "*", resource: "*", effect: "deny" }]);
    assertEquals(session.createBody.permissions, OPENCODE_DEFAULT_PERMISSIONS);
    assertEquals(session.createBody.title, "Todoist: Buy milk");

    assertEquals(h.opencode.prompts.length, 1);
    const text = h.opencode.prompts[0].text;
    assertStringIncludes(text, "Todoist task: Buy milk");
    assertStringIncludes(text, "Task description:\n2% please");
    assertStringIncludes(text, "Request:\nprompt 1");

    assertEquals(h.store.getSession(KEY)?.sessionId, session.id);
    assertEquals(h.notified.length, 1);
    assertEquals(h.store.getJob(req.jobId)?.callbackDelivered, true);
    assertEquals(h.store.getJob(req.jobId)?.state, "completed");
  });
});

Deno.test("opencode: configured directory, agent, model and permissions are passed through", async () => {
  const permissions = [
    { action: "read", resource: "*", effect: "allow" as const },
    { action: "*", resource: "*", effect: "ask" as const },
  ];
  await withHarness({
    opencodeConfig: {
      directory: "/srv/work",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-x" },
      permissions,
    },
  }, async (h) => {
    await h.run(jobReq(1));
    const [session] = [...h.opencode.sessions.values()];
    assertEquals(session.createBody.permissions, permissions);
    assertEquals(session.createBody.location, { directory: "/srv/work" });
    assertEquals(session.createBody.agent, "build");
    assertEquals(session.createBody.model, { providerID: "anthropic", id: "claude-x" });
  });
});

Deno.test("opencode: follow-up on the same task reuses the session and sends only the prompt", async () => {
  await withHarness({}, async (h) => {
    const first = jobReq(1);
    const second = jobReq(2);
    await h.run(first);
    const result = await h.run(second);

    assertEquals(result?.output, "reply 2"); // second turn of the same session
    assertEquals(h.opencode.sessions.size, 1);
    assertEquals(h.opencode.prompts.length, 2);
    assertEquals(h.opencode.prompts[1].sessionId, h.opencode.prompts[0].sessionId);
    assertEquals(h.opencode.prompts[1].text, "prompt 2");
    const creates = h.fetch.calls.filter((c) => c.method === "POST" && c.path === "/api/session");
    assertEquals(creates.length, 1);
  });
});

Deno.test("opencode: a different task gets a different session", async () => {
  await withHarness({}, async (h) => {
    await h.run(jobReq(1, { taskId: "task1" }));
    await h.run(jobReq(2, { taskId: "task2" }));
    assertEquals(h.opencode.sessions.size, 2);
    const [a, b] = h.opencode.prompts;
    assertNotEquals(a.sessionId, b.sessionId);
    // Both are first turns, so both carry the task context.
    assertStringIncludes(b.text, "Todoist task:");
  });
});

Deno.test("sessions are keyed per backend: same task on hermes maps to a different session", async () => {
  await withHarness({}, async (h) => {
    await h.run(jobReq(1));
    await h.run(jobReq(2, { backend: "hermes" }));

    const oc = h.store.getSession(sessionKeyFor("opencode", "1001", "task1"));
    const hm = h.store.getSession(sessionKeyFor("hermes", "1001", "task1"));
    assert(oc && hm);
    assertNotEquals(oc.sessionId, hm.sessionId);
    // Hermes had no mapping of its own, so it got first-turn context.
    assertStringIncludes([...h.hermes.runs.values()][0].input, "Todoist task:");
  });
});

Deno.test("opencode: a mapped session that vanished (404) is replaced by a new one", async () => {
  await withHarness({}, async (h) => {
    await h.run(jobReq(1));
    const oldId = h.store.getSession(KEY)!.sessionId;
    h.opencode.forgetSession(oldId);

    const result = await h.run(jobReq(2));
    assertEquals(result?.status, "completed");
    const newId = h.store.getSession(KEY)!.sessionId;
    assertNotEquals(newId, oldId);
    assertEquals([...h.opencode.sessions.keys()], [newId]);
    assertEquals(h.opencode.prompts[1].sessionId, newId);
  });
});

Deno.test("duplicate submit of the same jobId is a no-op and only one prompt is sent", async () => {
  await withHarness({}, async (h) => {
    h.opencode.afterPolls = 2;
    const req = jobReq(1);
    assertEquals(await h.jobs.submit(req), { duplicate: false });
    assertEquals(await h.jobs.submit(req), { duplicate: true });
    await h.jobs.idle();
    assertEquals(await h.jobs.submit(req), { duplicate: true }); // still a duplicate after completion

    assertEquals(h.opencode.prompts.length, 1);
    assertEquals(h.opencode.promptRequests, 1);
    assertEquals(h.notified.length, 1);
  });
});

Deno.test("opencode: permission requests are rejected, never approved", async () => {
  await withHarness({}, async (h) => {
    h.opencode.mode = "permission";
    const result = await h.run(jobReq(1));

    assertEquals(result?.status, "completed");
    assert(result!.denied_approvals >= 1);
    assertEquals(h.opencode.decisions.length, 1);
    assertEquals(h.opencode.decisions[0].decision, "reject");
    assertEquals(h.opencode.decisions[0].permissionId, "per_x");
    for (const d of h.opencode.decisions) assert(!["once", "always", "allow"].includes(d.decision));
    assertEquals(h.opencode.interrupts.length, 0);
  });
});

Deno.test("opencode: if rejecting a permission fails, the run is stopped and fails approval_required", async () => {
  await withHarness({}, async (h) => {
    h.opencode.mode = "permission";
    h.opencode.permissionReplyStatus = 500;
    const result = await h.run(jobReq(1));

    assertEquals(result?.status, "failed");
    assertEquals(result?.error_code, "approval_required");
    assertEquals(result?.denied_approvals, 0);
    assertEquals(h.opencode.interrupts.length, 1);
    assertEquals(h.opencode.decisions[0].decision, "reject");
  });
});

Deno.test("opencode: timeout interrupts the harness and reports timed_out", async () => {
  await withHarness({ timeoutMs: 60 }, async (h) => {
    h.opencode.mode = "hang";
    const result = await h.run(jobReq(1));

    assertEquals(result?.status, "timed_out");
    assertEquals(h.opencode.interrupts.length, 1);
    assertEquals(h.store.getJob(jobId(1))?.state, "timed_out");
  });
});

Deno.test("opencode: cancel interrupts the harness; wrong user and finished jobs are reported", async () => {
  await withHarness({}, async (h) => {
    h.opencode.mode = "hang";
    const req = jobReq(1);
    await h.jobs.submit(req);
    await waitFor(() => !!h.store.getJob(req.jobId)?.handle);

    assertEquals(h.jobs.cancel(req.jobId, "9999"), "not_found"); // different Todoist user
    assertEquals(h.jobs.cancel(jobId(404), "1001"), "not_found"); // unknown job
    assertEquals(h.opencode.interrupts.length, 0);

    assertEquals(h.jobs.cancel(req.jobId, "1001"), "cancelling");
    await h.jobs.idle();
    assertEquals(h.opencode.interrupts.length, 1);
    assertEquals(h.resultFor(req.jobId)?.status, "cancelled");
    assertEquals(h.jobs.cancel(req.jobId, "1001"), "finished");
  });
});

Deno.test("opencode: harness-side failure maps to failed / harness_error", async () => {
  await withHarness({}, async (h) => {
    h.opencode.mode = "fail";
    const result = await h.run(jobReq(1));
    assertEquals(result, { status: "failed", error_code: "harness_error", denied_approvals: 0 });
  });
});

Deno.test("opencode: an interrupted turn surfaces as cancelled", async () => {
  await withHarness({}, async (h) => {
    h.opencode.mode = "hang";
    const req = jobReq(1);
    await h.jobs.submit(req);
    await waitFor(() => !!h.store.getJob(req.jobId)?.handle);
    // Someone interrupts the session out-of-band.
    await fetch(`${h.opencode.origin}/api/session/${h.store.getSession(KEY)!.sessionId}/interrupt`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`opencode:${h.opencode.password}`)}` },
    });
    await h.jobs.idle();
    assertEquals(h.resultFor(req.jobId)?.status, "cancelled");
  });
});

Deno.test("opencode: wrong credentials at start map to failed / harness_auth_failed", async () => {
  await withHarness({ opencodeConfig: { password: "wrong" } }, async (h) => {
    const result = await h.run(jobReq(1));
    assertEquals(result, { status: "failed", error_code: "harness_auth_failed", denied_approvals: 0 });
    assertEquals(h.opencode.sessions.size, 0);
    assertEquals(h.opencode.prompts.length, 0);
  });
});

Deno.test("opencode: a non-JSON (web UI) response is a protocol error, not a success", async () => {
  // A wrong base path hits unknown routes, which real opencode answers with 200 text/html.
  await withHarness({ opencodeConfig: { baseUrl: "http://opencode.test/not-the-api" } }, async (h) => {
    const result = await h.run(jobReq(1));
    assertEquals(result?.status, "failed");
    assertEquals(result?.error_code, "harness_error");
    assertEquals(h.opencode.prompts.length, 0);
  });
});

Deno.test("opencode: unreachable harness maps to harness_unreachable", async () => {
  await withHarness({ opencodeConfig: { baseUrl: "http://nowhere.test" } }, async (h) => {
    const result = await h.run(jobReq(1));
    assertEquals(result?.error_code, "harness_unreachable");
  });
});

Deno.test("opencode: transient poll errors are retried; persistent ones fail and stop the run", async () => {
  await withHarness({}, async (h) => {
    h.opencode.afterPolls = 1;
    let failures = 2;
    h.opencode.override = (req, path) =>
      req.method === "GET" && path.endsWith("/message") && failures-- > 0 ? json({ error: "x" }, 500) : undefined;
    const result = await h.run(jobReq(1));
    assertEquals(result?.status, "completed");
  });

  await withHarness({ maxConsecutivePollErrors: 2 }, async (h) => {
    h.opencode.mode = "hang";
    h.opencode.override = (req, path) =>
      req.method === "GET" && path.endsWith("/message") ? json({ error: "x" }, 500) : undefined;
    const result = await h.run(jobReq(1));
    assertEquals(result?.status, "failed");
    assertEquals(result?.error_code, "harness_error");
    assertEquals(h.opencode.interrupts.length, 1);
  });
});

Deno.test("opencode: message history is paged until the turn's user message is found", async () => {
  await withHarness({}, async (h) => {
    h.opencode.pageSize = 2;
    h.opencode.fillerMessages = 5;
    const result = await h.run(jobReq(1));
    assertEquals(result, { status: "completed", output: "reply 1", denied_approvals: 0 });
    assert(h.fetch.calls.some((c) => c.path.endsWith("/message") && c.search.includes("cursor=")));
    assert(h.fetch.calls.some((c) => c.path.endsWith("/message") && c.search === "?order=desc&limit=50"));
  });
});

Deno.test("opencode: output is truncated at MAX_OUTPUT_CHARS", async () => {
  await withHarness({}, async (h) => {
    h.opencode.reply = (_t, n) => (n === 1 ? "x".repeat(MAX_OUTPUT_CHARS + 500) : "y".repeat(MAX_OUTPUT_CHARS));
    const long = await h.run(jobReq(1));
    assertEquals(long?.status, "completed");
    assert(long!.output!.startsWith("x".repeat(MAX_OUTPUT_CHARS)));
    assertEquals(long!.output, `${"x".repeat(MAX_OUTPUT_CHARS)}\n\n…(response truncated)`);

    const exact = await h.run(jobReq(2)); // exactly at the limit is left alone
    assertEquals(exact?.output, "y".repeat(MAX_OUTPUT_CHARS));
  });
});

Deno.test("per-task serialization: back-to-back jobs on one task run strictly in order", async () => {
  await withHarness({}, async (h) => {
    h.opencode.afterPolls = 3;
    await h.jobs.submit(jobReq(1));
    await h.jobs.submit(jobReq(2));
    await h.jobs.idle();

    assertEquals(h.opencode.events, ["prompt:1", "complete:1", "prompt:2", "complete:2"]);
    assertEquals(h.notified.map((n) => n.job.jobId), [jobId(1), jobId(2)]);
    assertEquals(h.notified.map((n) => n.result.output), ["reply 1", "reply 2"]);
  });
});

Deno.test("different tasks run concurrently", async () => {
  await withHarness({}, async (h) => {
    h.opencode.mode = "hang";
    const a = jobReq(1, { taskId: "taskA" });
    const b = jobReq(2, { taskId: "taskB" });
    await h.jobs.submit(a);
    await h.jobs.submit(b);
    // Both prompts arrive although neither has finished.
    await waitFor(() => h.opencode.prompts.length === 2);
    h.jobs.cancel(a.jobId, "1001");
    h.jobs.cancel(b.jobId, "1001");
    await h.jobs.idle();
  });
});
