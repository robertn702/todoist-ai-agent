// Live smoke test against a real local harness (OpenCode `opencode serve` or
// the Hermes API server). Runs the real runner HTTP handler on an ephemeral
// loopback port, sends signed jobs exactly as the Edge Function does, and
// receives signed callbacks on a second loopback port. Nothing is exposed
// beyond 127.0.0.1 and no credential is printed.
//
//   OPENCODE_BASE_URL=http://127.0.0.1:4096 OPENCODE_SERVER_PASSWORD=... \
//     deno run --allow-net=127.0.0.1 --allow-env runner/smoke.ts opencode
//
//   HERMES_BASE_URL=http://127.0.0.1:8642/p/todoist HERMES_API_KEY=... \
//     deno run --allow-net=127.0.0.1 --allow-env runner/smoke.ts hermes
//
// Optional: SMOKE_TIMEOUT_SECONDS (default 300), SMOKE_SKIP_TOOL_CHECK=1 (skip the tool-blocking check),
// SMOKE_SKIP_CANCEL=1, plus the runner's OPENCODE_* settings (directory,
// agent, model, permissions). See docs/external-harness.md.

import { signHarnessRequest, verifyHarnessRequest } from "../supabase/functions/_shared/harness-auth.ts";
import { HermesAdapter } from "./adapters/hermes.ts";
import { OpenCodeAdapter } from "./adapters/opencode.ts";
import type { HarnessAdapter, HarnessBackend } from "./adapters/types.ts";
import { loadRunnerConfig } from "./config.ts";
import { JobManager, sessionKeyFor } from "./jobs.ts";
import { createCallbackNotifier, createRunnerHandler, ROUTE_CALLBACK } from "./server.ts";
import { MemoryStore } from "./store.ts";

const backend = Deno.args[0] as HarnessBackend;
if (backend !== "opencode" && backend !== "hermes") {
  console.error("usage: runner/smoke.ts opencode|hermes");
  Deno.exit(2);
}

const USER = "990001";
const OTHER_USER = "990002";
const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
const timeoutSeconds = Number(Deno.env.get("SMOKE_TIMEOUT_SECONDS") ?? "300");

// Reuse the runner's own config validation for the harness settings.
const harnessEnv: Record<string, string> = {
  HARNESS_RUNNER_SECRET: secret,
  RUNNER_ALLOWED_TODOIST_USER_IDS: USER,
  HARNESS_CALLBACK_URL: "http://127.0.0.1:1/unused",
};
const config = loadRunnerConfig((k) => harnessEnv[k] ?? (k.startsWith(backend === "opencode" ? "OPENCODE_" : "HERMES_") ? Deno.env.get(k) : undefined));
const adapter: HarnessAdapter = backend === "opencode"
  ? new OpenCodeAdapter(config.opencode!)
  : new HermesAdapter(config.hermes!);

// --- callback receiver -------------------------------------------------------
type Result = { status: string; output: string | null; error_code: string | null; denied_approvals: number };
const results = new Map<string, Result>();
const waiters = new Map<string, (r: Result) => void>();
const callbackServer = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
  const body = await req.text();
  const v = await verifyHarnessRequest({ secret, direction: "runner-to-edge", route: ROUTE_CALLBACK, body, headers: req.headers });
  if (!v.ok) return new Response("unauthorized", { status: 401 });
  const payload = JSON.parse(body);
  results.set(payload.job_id, payload);
  waiters.get(payload.job_id)?.(payload);
  return new Response("{}", { status: 200 });
});

// --- runner -------------------------------------------------------------------
const store = new MemoryStore();
const jobs = new JobManager({
  store,
  adapters: { [backend]: adapter },
  notify: createCallbackNotifier({ url: `http://127.0.0.1:${callbackServer.addr.port}/harness-callback`, secret }),
  timeoutMs: timeoutSeconds * 1000,
  pollIntervalMs: 1000,
});
const runnerServer = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  createRunnerHandler({ secret, allowedTodoistUserIds: config.allowedTodoistUserIds, jobs }),
);
const runnerUrl = `http://127.0.0.1:${runnerServer.addr.port}`;

// --- helpers --------------------------------------------------------------------
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

function newJobId(): string {
  return `job_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function post(path: string, route: string, payload: Record<string, unknown>, sign = true): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers = sign ? await signHarnessRequest({ secret, direction: "edge-to-runner", route, body }) : {};
  return await fetch(`${runnerUrl}${path}`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body });
}

async function submit(jobId: string, taskId: string, prompt: string, user = USER): Promise<Response> {
  return await post("/v1/jobs", "POST /v1/jobs", {
    job_id: jobId,
    backend,
    todoist_user_id: user,
    task_id: taskId,
    task: { content: `Smoke test task ${taskId}`, description: "" },
    prompt,
  });
}

function waitFor(jobId: string): Promise<Result> {
  const existing = results.get(jobId);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve) => waiters.set(jobId, resolve));
}

async function turn(taskId: string, prompt: string): Promise<{ jobId: string; result: Result }> {
  const jobId = newJobId();
  const res = await submit(jobId, taskId, prompt);
  await res.body?.cancel();
  if (res.status !== 202) throw new Error(`submit returned ${res.status}`);
  return { jobId, result: await waitFor(jobId) };
}

// --- scenario --------------------------------------------------------------------
const run = crypto.randomUUID().slice(0, 8);
const taskA = `smokeA${run}`;
const taskB = `smokeB${run}`;
const codeword = `PELICAN${Math.floor(Math.random() * 9000 + 1000)}`;
console.log(`backend=${backend} run=${run}`);

try {
  // Security: unsigned and non-allowlisted requests never reach the harness.
  const unsigned = await post("/v1/jobs", "POST /v1/jobs", { job_id: newJobId() }, false);
  await unsigned.body?.cancel();
  check("unsigned request rejected", unsigned.status === 401, `HTTP ${unsigned.status}`);
  const foreign = await submit(newJobId(), taskA, "hello", OTHER_USER);
  await foreign.body?.cancel();
  check("non-allowlisted Todoist user rejected", foreign.status === 403, `HTTP ${foreign.status}`);

  const t1 = await turn(taskA, `Remember this codeword for later: ${codeword}. Reply with just OK.`);
  check("task A turn 1 completed", t1.result.status === "completed", t1.result.status);

  const dup = await submit(t1.jobId, taskA, "duplicate delivery");
  const dupBody = await dup.json();
  check("duplicate job is not re-run", dup.status === 202 && dupBody.duplicate === true);

  const t2 = await turn(taskA, "What codeword did I ask you to remember? Reply with only the codeword.");
  check("task A turn 2 completed", t2.result.status === "completed", t2.result.status);
  check("same task continues its session", (t2.result.output ?? "").includes(codeword));

  const t3 = await turn(taskB, "Did I ask you to remember a codeword in this conversation? If not, reply NONE.");
  check("task B completed", t3.result.status === "completed", t3.result.status);
  check("different task has a separate session", !(t3.result.output ?? "").includes(codeword));
  const sa = store.getSession(sessionKeyFor(backend, USER, taskA))?.sessionId;
  const sb = store.getSession(sessionKeyFor(backend, USER, taskB))?.sessionId;
  check("session mapping is per task", !!sa && !!sb && sa !== sb);

  if (Deno.env.get("SMOKE_SKIP_TOOL_CHECK") !== "1") {
    const t4 = await turn(
      taskB,
      "Use your shell/terminal tool to run `cat /proc/sys/kernel/random/uuid` and reply with its exact output. If the tool is unavailable or denied, reply DENIED.",
    );
    // A UUID in the reply means the command actually ran on the host.
    const ranTool = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t4.result.output ?? "");
    check(
      "tool execution blocked (fail closed)",
      !ranTool,
      `status=${t4.result.status} denied_approvals=${t4.result.denied_approvals}`,
    );
  }

  if (Deno.env.get("SMOKE_SKIP_CANCEL") !== "1") {
    const jobId = newJobId();
    const res = await submit(
      jobId,
      `smokeC${run}`,
      "Write a detailed 3000-word essay about the history of task management software.",
    );
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 4000));
    const cancel = await post("/v1/jobs/cancel", "POST /v1/jobs/cancel", { job_id: jobId, todoist_user_id: USER });
    await cancel.body?.cancel();
    const result = await waitFor(jobId);
    check("cancellation stops the run", result.status === "cancelled" || result.status === "completed", result.status);
  }
} catch (e) {
  check("scenario", false, e instanceof Error ? e.message : String(e));
} finally {
  await jobs.idle();
  await runnerServer.shutdown();
  await callbackServer.shutdown();
}

console.log(failures === 0 ? "SMOKE OK" : `SMOKE FAILED (${failures})`);
Deno.exit(failures === 0 ? 0 : 1);
