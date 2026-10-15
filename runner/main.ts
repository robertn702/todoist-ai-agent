// Todoist external harness runner.
//
//   deno run --allow-net --allow-env --allow-read --allow-write runner/main.ts
//
// See docs/external-harness.md for deployment, environment and smoke tests.

import { HermesAdapter } from "./adapters/hermes.ts";
import { OpenCodeAdapter } from "./adapters/opencode.ts";
import type { HarnessAdapter, HarnessBackend } from "./adapters/types.ts";
import { loadRunnerConfig } from "./config.ts";
import { JobManager } from "./jobs.ts";
import { createCallbackNotifier, createRunnerHandler } from "./server.ts";
import { FileStore } from "./store.ts";

const config = loadRunnerConfig((k) => Deno.env.get(k));

const adapters: Partial<Record<HarnessBackend, HarnessAdapter>> = {};
if (config.opencode) adapters.opencode = new OpenCodeAdapter(config.opencode);
if (config.hermes) adapters.hermes = new HermesAdapter(config.hermes);

const store = await FileStore.open(config.stateFile);
const jobs = new JobManager({
  store,
  adapters,
  notify: createCallbackNotifier({ url: config.callbackUrl, secret: config.secret }),
  timeoutMs: config.jobTimeoutMs,
  pollIntervalMs: config.pollIntervalMs,
});
const handler = createRunnerHandler({
  secret: config.secret,
  allowedTodoistUserIds: config.allowedTodoistUserIds,
  jobs,
});

console.info("harness runner starting", {
  host: config.host,
  port: config.port,
  backends: Object.keys(adapters),
  allowedUsers: config.allowedTodoistUserIds.size,
});

Deno.serve({ hostname: config.host, port: config.port }, handler);

// Recover after listening so slow callback redelivery never blocks new jobs.
jobs.recover().catch((e) => console.error("startup recovery failed", { error: String(e) }));
