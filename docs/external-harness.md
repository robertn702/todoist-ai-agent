# External harness backends (OpenCode, Hermes)

By default every `@ai` comment goes to the AI provider configured in Settings
(the **provider** mode). Allowlisted users can instead route their comments to a
real, operator-hosted agent harness:

- **OpenCode**: an authenticated `opencode serve` (v2 HTTP API)
- **Hermes Agent**: an authenticated Hermes API server (`/v1/runs`)

These are full harness sessions with their own tools, memory and permissions.
They are not a model-compatible proxy. Each Todoist task gets its own harness
session. A follow-up comment on the same task continues that session, while
another task (or the other backend) gets a separate one.

This feature is designed for a **personal deployment**. You run one small
runner service next to your harness, and only the Todoist accounts you list can
reach it.

## Architecture

```
Todoist ──webhook──▶ Edge `webhook` ──signed POST /v1/jobs──▶ runner (your host) ──▶ opencode serve / Hermes API
   ▲                      │ harness_jobs row                     │ polls, denies approvals,
   │                      │ progress comment                     │ enforces timeout/cancel
   └──comment update── Edge `harness-callback` ◀──signed result──┘
```

1. The webhook verifies Todoist's HMAC, deduplicates the event and applies rate limits, as before.
2. For an `opencode` or `hermes` user it records a `harness_jobs` row. The row ID is derived from the Todoist event key, so a duplicate delivery hits the primary key. It then posts the usual progress comment and sends a signed job to the runner. The Edge Function returns immediately, so long runs never hold the webhook open.
3. The runner maps `(backend, Todoist user, task)` to a harness session and stores the mapping in its state file. It starts the turn and polls the harness until the turn finishes, times out or is cancelled.
4. The runner reports the terminal result to `harness-callback` (signed). That callback moves the job from `submitted` to its terminal state atomically and replaces the progress comment with the agent's answer.

The Todoist OAuth token never leaves Supabase. The runner never sees it.

### Security model (fails closed)

| Control | Where |
|---|---|
| HMAC-SHA256 over `version, direction, route, timestamp, nonce, sha256(body)` using a shared secret of at least 32 characters | Both directions (`_shared/harness-auth.ts`) |
| Direction label, so a captured request cannot be reflected back the other way | Both directions |
| Timestamp freshness of ±300 s | Both directions |
| Single-use nonces: an in-memory cache on the runner and `processed_events` on the Edge | Both directions |
| Todoist user allowlist: `HARNESS_ALLOWED_TODOIST_USER_IDS` (Edge) **and** `RUNNER_ALLOWED_TODOIST_USER_IDS` (runner) | Edge and runner |
| Feature disabled unless the runner URL (https), secret and allowlist are all set | Edge |
| Settings refuse non-provider backends for accounts that are not allowlisted | Settings API |
| The runner accepts only "run a turn for this Todoist task" and "cancel this job". Callers cannot set commands, paths, URLs, models or permissions | Runner |
| Approval and permission requests are **always denied**. A run that cannot be denied is stopped (`approval_required`) | Runner |
| OpenCode sessions get the `[{"action":"*","resource":"*","effect":"deny"}]` ruleset by default. Unlike `ask`, a `deny` rule also overrides permissions the operator previously saved with "always" for that project | Runner |
| Only events **initiated by the allowlisted account owner** run (Todoist delivers collaborator comments on shared projects to the owner's webhook; those are ignored) | Edge |
| Job IDs double as harness idempotency keys (OpenCode message ID, Hermes `Idempotency-Key`) | Runner |

A user who edits their own `users_config.agent_backend` directly through the
REST API still cannot run anything: the webhook and the runner both check their
allowlists.

## Deploy

### 1. Generate a shared secret

```bash
deno eval "console.log(Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''))"
```

Store it in your secret manager. Never commit it or paste it into a task.

### 2. Run your harness on loopback

**OpenCode.** Run it in a dedicated project directory, with a password:

```bash
cd /path/to/agent-workspace
OPENCODE_SERVER_PASSWORD=<from secret manager> opencode serve --hostname 127.0.0.1 --port 4096
```

**Hermes.** Use a dedicated profile with a restricted toolset and its own
`API_SERVER_KEY`, then point the runner at that profile's prefix
(`http://127.0.0.1:8642/p/<profile>`). Do not reuse your default profile or
gateway key. Keep `API_SERVER_HOST=127.0.0.1`.

### 3. Run the runner

The runner is a small Deno service in `runner/`. It needs network access
(harness, callback), env, and read/write access to its state file.

| Variable | Required | Description |
|---|---|---|
| `HARNESS_RUNNER_SECRET` | yes | Shared secret, at least 32 characters (same value as on the Edge) |
| `RUNNER_ALLOWED_TODOIST_USER_IDS` | yes | Comma-separated Todoist user IDs |
| `HARNESS_CALLBACK_URL` | yes | `https://<project-ref>.supabase.co/functions/v1/harness-callback` |
| `RUNNER_HOST` / `RUNNER_PORT` | no | Bind address. Default `127.0.0.1:8787` |
| `RUNNER_STATE_FILE` | no | Default `~/.local/state/todoist-harness-runner/state.json` (mode 0600) |
| `RUNNER_JOB_TIMEOUT_SECONDS` | no | Per-turn wall-clock limit. Default `900` |
| `RUNNER_POLL_INTERVAL_MS` | no | Harness polling interval. Default `2000` |
| `OPENCODE_BASE_URL` | one backend | For example `http://127.0.0.1:4096` |
| `OPENCODE_SERVER_PASSWORD` | with OpenCode | Basic-auth password (`OPENCODE_SERVER_USERNAME` defaults to `opencode`) |
| `OPENCODE_DIRECTORY` | no | Absolute project directory for new sessions |
| `OPENCODE_AGENT` | no | Agent for new sessions (for example a restricted custom agent) |
| `OPENCODE_MODEL` | no | `provider/model` for new sessions |
| `OPENCODE_PERMISSIONS` | no | JSON ruleset for new sessions (last matching rule wins). Default: everything `deny`. Example of an explicit read-only opt-in: `[{"action":"*","resource":"*","effect":"deny"},{"action":"read","resource":"*","effect":"allow"}]`. Any `ask` rule is rejected by the runner, but beware that `ask` can be overridden by permissions saved with "always" in that OpenCode project — prefer `deny` |
| `HERMES_BASE_URL` | one backend | For example `http://127.0.0.1:8642/p/todoist` |
| `HERMES_API_KEY` | with Hermes | That profile's `API_SERVER_KEY` |

```bash
# with the variables above in the environment (e.g. a systemd EnvironmentFile, mode 0600)
npm run runner:start
```

The runner validates its configuration at startup and refuses to start if
anything is missing.

### 4. Expose only the runner over HTTPS

Supabase Edge Functions must reach the runner over HTTPS. Publish **only** the
runner port, for example with Cloudflare Tunnel or Tailscale Funnel:

```bash
tailscale funnel --bg 8787        # or: cloudflared tunnel --url http://127.0.0.1:8787
```

Never publish the OpenCode or Hermes ports. The runner exposes `GET /healthz`
(which returns only `{"ok":true}`), `POST /v1/jobs` and `POST /v1/jobs/cancel`.
Both POST routes require a valid signature and an allowlisted user.

### 5. Configure Supabase

```bash
npx supabase secrets set \
  HARNESS_RUNNER_URL=https://<your-runner-host> \
  HARNESS_RUNNER_SECRET=<same secret> \
  HARNESS_ALLOWED_TODOIST_USER_IDS=<your todoist user id>
```

Then deploy as usual. The deploy applies migration `00009_external_harness.sql`
and deploys the new `harness-callback` function (`verify_jwt = false`, because
it authenticates with the runner signature).

### 6. Choose the backend

In **Settings → Advanced → Agent Backend**, choose OpenCode or Hermes. The
selector appears only for allowlisted accounts.

## Using it

- `@ai <request>` starts a turn. The first turn on a task includes the task title and description as context. Later turns send only the comment, because the harness session already has the history.
- `@ai stop` (or `@ai cancel`) cancels the task's running turn. The progress comment then changes to "Agent run cancelled."
- If the harness asked for approval during the run, the reply ends with a note that those requests were denied.
- A timeout stops the run on the harness and reports an error comment.

## Live smoke tests

`runner/smoke.ts` runs the real runner HTTP handler and a signed callback
receiver on ephemeral loopback ports against your local harness. It checks:

- unsigned requests are rejected
- non-allowlisted users are rejected
- same-task continuity (a codeword is recalled)
- cross-task separation
- duplicate-job deduplication
- tool execution is blocked (the agent is asked to print a fresh UUID from the host; a UUID in the reply fails the check)
- cancellation

It generates a throwaway signing secret and never prints credentials.

```bash
# OpenCode (start `opencode serve` with a password first)
OPENCODE_BASE_URL=http://127.0.0.1:4096 OPENCODE_SERVER_PASSWORD="$(<your secret lookup>)" \
OPENCODE_DIRECTORY=/path/to/scratch-project \
  npm run runner:smoke -- opencode

# Hermes (API server enabled on a dedicated profile)
HERMES_BASE_URL=http://127.0.0.1:8642/p/todoist HERMES_API_KEY="$(<your secret lookup>)" \
  npm run runner:smoke -- hermes
```

Options:

- `SMOKE_TIMEOUT_SECONDS`: default 300.
- `SMOKE_SKIP_TOOL_CHECK=1`: skip the tool-blocking check (for example, if you deliberately allow shell tools).
- `SMOKE_SKIP_CANCEL=1`: skip the cancellation check.

For an end-to-end Todoist check after deploying:

1. Set your account to the harness backend.
2. Comment `@ai remember the word PELICAN, reply OK` on task A.
3. Comment `@ai what word?` on task A. It should answer PELICAN.
4. Ask the same on task B. It should not know the word.
5. Comment `@ai stop` during a long request to check cancellation.

## Tests

- `npm test`: Edge tests, including webhook routing, the signed callback, settings and the signing scheme.
- `npm run test:runner`: runner tests against in-process mock OpenCode and Hermes servers. They cover session reuse and separation, idempotency, approval denial, timeout, cancellation, restart recovery and the HTTP security checks.

## Limitations

- **OpenCode**: targets the v2 server API (`/api/session/...`, verified against OpenCode 2.0.29). The v1 routes (`/session/:id/prompt_async`) are not supported.
- **Hermes**: the adapter reads the pending approval from either `approval` (legacy) or `pending_controls` (canonical) and always answers `deny`. Clarify requests are not answered, so the job timeout bounds them.
- **Attachments**: images and files on Todoist comments are not forwarded to harnesses.
- **Restarts**: if the runner restarts mid-run, the harness turn is interrupted and the job is reported as failed (`runner_restarted`). Undelivered results are re-sent at startup.
- **Replay after restart**: the runner's nonce cache is in memory. A signed request replayed within five minutes of a runner restart is still harmless, because job IDs are deduplicated by the durable ledger and cancels are scoped to the job owner.
