import { assert, assertEquals, assertRejects } from "@std/assert";
import { sessionKeyFor } from "../jobs.ts";
import { type JobRecord, MemoryStore } from "../store.ts";
import { jobId, jobReq, withHarness } from "./helpers.ts";

function seedJob(n: number, over: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: jobId(n),
    backend: "opencode",
    todoistUserId: "1001",
    taskId: "task1",
    sessionKey: sessionKeyFor("opencode", "1001", "task1"),
    state: "running",
    callbackDelivered: false,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

Deno.test("sessionKeyFor includes backend, user and task", () => {
  assertEquals(sessionKeyFor("opencode", "1001", "t1"), "opencode:1001:t1");
  assertEquals(sessionKeyFor("hermes", "1001", "t1"), "hermes:1001:t1");
});

Deno.test("submit rejects a backend that is not enabled", async () => {
  await withHarness({ enable: { hermes: false } }, async (h) => {
    assertEquals(h.jobs.isBackendEnabled("opencode"), true);
    assertEquals(h.jobs.isBackendEnabled("hermes"), false);
    await assertRejects(() => h.jobs.submit(jobReq(1, { backend: "hermes" })), Error, "not enabled");
    assertEquals(h.store.getJob(jobId(1)), undefined);
  });
});

Deno.test("recover: a job left running by a restart is cancelled on the harness and reported runner_restarted", async () => {
  const store = new MemoryStore();
  await store.putJob(seedJob(1, { handle: { sessionId: "ses_old", turnId: "msg_old", createdSession: true } }));
  await store.putJob(seedJob(2, {
    backend: "hermes",
    sessionKey: sessionKeyFor("hermes", "1001", "task1"),
    handle: { sessionId: "todoist-old", turnId: "run_old", createdSession: true },
  }));
  await withHarness({ store }, async (h) => {
    await h.jobs.recover();

    assertEquals(h.opencode.interrupts, ["ses_old"]);
    assertEquals(h.hermes.stops, ["run_old"]);
    assertEquals(h.notified.length, 2);
    for (const n of h.notified) {
      assertEquals(n.result, { status: "failed", error_code: "runner_restarted", denied_approvals: 0 });
    }
    assertEquals(store.getJob(jobId(1))?.state, "failed");
    assertEquals(store.getJob(jobId(1))?.callbackDelivered, true);
  });
});

Deno.test("recover: a running job with no harness handle is failed without touching the harness", async () => {
  const store = new MemoryStore();
  await store.putJob(seedJob(1));
  await withHarness({ store }, async (h) => {
    await h.jobs.recover();
    assertEquals(h.fetch.calls.length, 0);
    assertEquals(h.resultFor(jobId(1))?.error_code, "runner_restarted");
  });
});

Deno.test("recover: a finished-but-undelivered job is redelivered; delivered ones are not", async () => {
  const store = new MemoryStore();
  await store.putJob(seedJob(1, {
    state: "completed",
    result: { status: "completed", output: "done", denied_approvals: 0 },
  }));
  await store.putJob(seedJob(2, {
    state: "completed",
    callbackDelivered: true,
    result: { status: "completed", output: "already sent", denied_approvals: 0 },
  }));
  await withHarness({ store }, async (h) => {
    await h.jobs.recover();

    assertEquals(h.notified.length, 1);
    assertEquals(h.notified[0].job.jobId, jobId(1));
    assertEquals(h.notified[0].result.output, "done");
    assertEquals(store.getJob(jobId(1))?.callbackDelivered, true);
    assertEquals(h.fetch.calls.length, 0); // no harness traffic
    // Redelivery is idempotent from the runner's side: a second recover sends nothing more.
    await h.jobs.recover();
    assertEquals(h.notified.length, 1);
  });
});

Deno.test("callback delivery is retried with the configured delays", async () => {
  await withHarness({
    callbackRetryDelaysMs: [1, 1],
    onNotify: (attempt) => {
      if (attempt <= 2) throw new Error("edge down");
    },
  }, async (h) => {
    const req = jobReq(1);
    await h.run(req);
    assertEquals(h.attempts.length, 3);
    assertEquals(h.notified.length, 1);
    assertEquals(h.store.getJob(req.jobId)?.callbackDelivered, true);
  });
});

Deno.test("callback delivery gives up when exhausted and is redelivered on the next recover()", async () => {
  let edgeUp = false;
  await withHarness({
    callbackRetryDelaysMs: [1],
    onNotify: () => {
      if (!edgeUp) throw new Error("edge down");
    },
  }, async (h) => {
    const req = jobReq(1);
    await h.run(req);
    assertEquals(h.attempts.length, 2);
    assertEquals(h.notified.length, 0);
    assertEquals(h.store.getJob(req.jobId)?.callbackDelivered, false);
    assertEquals(h.store.getJob(req.jobId)?.state, "completed"); // result is durable

    edgeUp = true;
    await h.jobs.recover();
    assertEquals(h.notified.length, 1);
    assert(h.store.getJob(req.jobId)?.callbackDelivered);
    assertEquals(h.opencode.prompts.length, 1); // redelivery never re-runs the turn
  });
});
