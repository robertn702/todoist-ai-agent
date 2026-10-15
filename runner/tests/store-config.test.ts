import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { OPENCODE_DEFAULT_PERMISSIONS } from "../adapters/opencode.ts";
import { loadRunnerConfig } from "../config.ts";
import { FileStore, type JobRecord } from "../store.ts";
import { jobId } from "./helpers.ts";

// ---------------------------------------------------------------------------
// FileStore
// ---------------------------------------------------------------------------

const job: JobRecord = {
  jobId: jobId(1),
  backend: "hermes",
  todoistUserId: "1001",
  taskId: "task1",
  sessionKey: "hermes:1001:task1",
  state: "completed",
  handle: { sessionId: "todoist-abc", turnId: "run_1", createdSession: true },
  result: { status: "completed", output: "hi", denied_approvals: 1 },
  callbackDelivered: true,
  createdAt: 10,
  updatedAt: 10,
};

Deno.test("FileStore: sessions and jobs persist across reopen; files are private", async () => {
  const dir = await Deno.makeTempDir({ prefix: "runner-store-" });
  try {
    const path = `${dir}/state/state.json`;
    const store = await FileStore.open(path);
    await store.setSession("hermes:1001:task1", "todoist-abc");
    await store.putJob(job);
    await store.putJob({ ...job, jobId: jobId(2), state: "running", result: undefined, callbackDelivered: false });

    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(`${dir}/state`)).mode! & 0o777, 0o700);
    await assertRejects(() => Deno.stat(`${path}.tmp`), Deno.errors.NotFound); // atomic rename left no temp file

    const reopened = await FileStore.open(path);
    assertEquals(reopened.getSession("hermes:1001:task1")?.sessionId, "todoist-abc");
    assertEquals(reopened.getSession("unknown"), undefined);
    const restored = reopened.getJob(jobId(1));
    assertEquals({ ...restored, updatedAt: 0 }, { ...job, updatedAt: 0 });
    assertEquals(reopened.getJob(jobId(2))?.state, "running");
    assertEquals(reopened.listJobs().length, 2);

    // Subsequent writes keep the permissions.
    await reopened.setSession("opencode:1001:task1", "ses_1");
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    const again = await FileStore.open(path);
    assertEquals(again.getSession("opencode:1001:task1")?.sessionId, "ses_1");
    assertEquals(again.getSession("hermes:1001:task1")?.sessionId, "todoist-abc");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FileStore: opening a missing file starts empty; concurrent writes all land", async () => {
  const dir = await Deno.makeTempDir({ prefix: "runner-store-" });
  try {
    const path = `${dir}/state.json`;
    const store = await FileStore.open(path);
    assertEquals(store.listJobs(), []);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.setSession(`k${i}`, `s${i}`)));
    const reopened = await FileStore.open(path);
    for (let i = 0; i < 20; i++) assertEquals(reopened.getSession(`k${i}`)?.sessionId, `s${i}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// loadRunnerConfig
// ---------------------------------------------------------------------------

const SECRET = "s".repeat(32);

function env(over: Record<string, string | undefined> = {}): (k: string) => string | undefined {
  const base: Record<string, string | undefined> = {
    HARNESS_RUNNER_SECRET: SECRET,
    RUNNER_ALLOWED_TODOIST_USER_IDS: "1001",
    HARNESS_CALLBACK_URL: "https://edge.example.com/functions/v1/harness-callback",
    OPENCODE_BASE_URL: "http://127.0.0.1:4096",
    OPENCODE_SERVER_PASSWORD: "pw",
    HOME: "/home/test",
    ...over,
  };
  return (k) => base[k];
}

Deno.test("config: valid minimal config applies defaults", () => {
  const c = loadRunnerConfig(env());
  assertEquals(c.secret, SECRET);
  assertEquals([...c.allowedTodoistUserIds], ["1001"]);
  assertEquals(c.callbackUrl, "https://edge.example.com/functions/v1/harness-callback");
  assertEquals(c.host, "127.0.0.1");
  assertEquals(c.port, 8787);
  assertEquals(c.jobTimeoutMs, 900_000);
  assertEquals(c.pollIntervalMs, 2000);
  assertEquals(c.stateFile, "/home/test/.local/state/todoist-harness-runner/state.json");
  assertEquals(c.hermes, undefined);
  assertEquals(c.opencode?.baseUrl, "http://127.0.0.1:4096");
  assertEquals(c.opencode?.username, "opencode");
  assertEquals(c.opencode?.password, "pw");
  assertEquals(c.opencode?.permissions, OPENCODE_DEFAULT_PERMISSIONS);
  assertEquals(c.opencode?.model, undefined);
});

Deno.test("config: overrides, multiple allowlisted users and a hermes-only setup", () => {
  const c = loadRunnerConfig(env({
    OPENCODE_BASE_URL: undefined,
    OPENCODE_SERVER_PASSWORD: undefined,
    HERMES_BASE_URL: "http://127.0.0.1:8642/p/todoist/",
    HERMES_API_KEY: "k",
    RUNNER_ALLOWED_TODOIST_USER_IDS: "1001, 1002 ,bad id",
    RUNNER_PORT: "9000",
    RUNNER_JOB_TIMEOUT_SECONDS: "60",
    RUNNER_POLL_INTERVAL_MS: "250",
    RUNNER_STATE_FILE: "/tmp/x.json",
  }));
  assertEquals([...c.allowedTodoistUserIds], ["1001", "1002"]);
  assertEquals(c.opencode, undefined);
  assertEquals(c.hermes, { baseUrl: "http://127.0.0.1:8642/p/todoist", apiKey: "k" });
  assertEquals([c.port, c.jobTimeoutMs, c.pollIntervalMs, c.stateFile], [9000, 60_000, 250, "/tmp/x.json"]);
});

Deno.test("config: OPENCODE_MODEL provider/model is parsed; extra slashes stay in the model id", () => {
  assertEquals(
    loadRunnerConfig(env({ OPENCODE_MODEL: "anthropic/claude-sonnet" })).opencode?.model,
    { providerID: "anthropic", id: "claude-sonnet" },
  );
  assertEquals(
    loadRunnerConfig(env({ OPENCODE_MODEL: "openrouter/anthropic/claude" })).opencode?.model,
    { providerID: "openrouter", id: "anthropic/claude" },
  );
});

Deno.test("config: valid OPENCODE_PERMISSIONS, directory and agent are accepted", () => {
  const rules = [{ action: "read", resource: "*", effect: "allow" }, { action: "*", resource: "*", effect: "ask" }];
  const c = loadRunnerConfig(env({
    OPENCODE_PERMISSIONS: JSON.stringify(rules),
    OPENCODE_DIRECTORY: "/srv/work",
    OPENCODE_AGENT: "build",
  }));
  assertEquals(c.opencode?.permissions, rules);
  assertEquals(c.opencode?.directory, "/srv/work");
  assertEquals(c.opencode?.agent, "build");
});

const invalid: Array<[string, Record<string, string | undefined>, string]> = [
  ["missing secret", { HARNESS_RUNNER_SECRET: undefined }, "HARNESS_RUNNER_SECRET"],
  ["short secret", { HARNESS_RUNNER_SECRET: "s".repeat(31) }, "HARNESS_RUNNER_SECRET"],
  ["missing allowlist", { RUNNER_ALLOWED_TODOIST_USER_IDS: undefined }, "RUNNER_ALLOWED_TODOIST_USER_IDS"],
  ["empty allowlist", { RUNNER_ALLOWED_TODOIST_USER_IDS: " , " }, "RUNNER_ALLOWED_TODOIST_USER_IDS"],
  ["allowlist with only invalid ids", { RUNNER_ALLOWED_TODOIST_USER_IDS: "a b,c/d" }, "RUNNER_ALLOWED_TODOIST_USER_IDS"],
  ["no backend", { OPENCODE_BASE_URL: undefined, OPENCODE_SERVER_PASSWORD: undefined }, "at least one backend"],
  ["missing callback url", { HARNESS_CALLBACK_URL: undefined }, "HARNESS_CALLBACK_URL"],
  ["http non-loopback callback", { HARNESS_CALLBACK_URL: "http://edge.example.com/cb" }, "must use https"],
  ["callback with embedded credentials", { HARNESS_CALLBACK_URL: "https://u:p@edge.example.com/cb" }, "credentials"],
  ["callback not a url", { HARNESS_CALLBACK_URL: "not a url" }, "valid http(s) URL"],
  ["callback with ftp scheme", { HARNESS_CALLBACK_URL: "ftp://edge.example.com/cb" }, "valid http(s) URL"],
  ["opencode url without password", { OPENCODE_SERVER_PASSWORD: undefined }, "OPENCODE_SERVER_PASSWORD"],
  ["opencode relative directory", { OPENCODE_DIRECTORY: "work" }, "OPENCODE_DIRECTORY"],
  ["opencode model without provider", { OPENCODE_MODEL: "just-a-model" }, "OPENCODE_MODEL"],
  ["opencode model with empty id", { OPENCODE_MODEL: "provider/" }, "OPENCODE_MODEL"],
  ["permissions not json", { OPENCODE_PERMISSIONS: "{nope" }, "OPENCODE_PERMISSIONS"],
  ["permissions empty array", { OPENCODE_PERMISSIONS: "[]" }, "OPENCODE_PERMISSIONS"],
  ["permissions not an array", { OPENCODE_PERMISSIONS: '{"action":"*"}' }, "OPENCODE_PERMISSIONS"],
  [
    "permissions bad effect",
    { OPENCODE_PERMISSIONS: '[{"action":"*","resource":"*","effect":"always"}]' },
    "OPENCODE_PERMISSIONS",
  ],
  ["hermes url without key", { HERMES_BASE_URL: "http://127.0.0.1:8642" }, "HERMES_API_KEY"],
  ["bad port", { RUNNER_PORT: "abc" }, "RUNNER_PORT"],
  ["zero timeout", { RUNNER_JOB_TIMEOUT_SECONDS: "0" }, "RUNNER_JOB_TIMEOUT_SECONDS"],
];

for (const [name, over, message] of invalid) {
  Deno.test(`config: rejects ${name}`, () => {
    assertThrows(() => loadRunnerConfig(env(over)), Error, message);
  });
}

Deno.test("config: reports every problem at once", () => {
  const err = assertThrows(() =>
    loadRunnerConfig(env({ HARNESS_RUNNER_SECRET: "short", RUNNER_ALLOWED_TODOIST_USER_IDS: "", RUNNER_PORT: "x" }))
  );
  assert(err instanceof Error);
  for (const key of ["HARNESS_RUNNER_SECRET", "RUNNER_ALLOWED_TODOIST_USER_IDS", "RUNNER_PORT"]) {
    assert(err.message.includes(key), key);
  }
});
