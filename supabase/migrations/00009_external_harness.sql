-- External harness backends (OpenCode, Hermes) via an authenticated runner bridge.
-- Provider mode remains the default for every user.

ALTER TABLE users_config
  ADD COLUMN agent_backend text NOT NULL DEFAULT 'provider'
  CHECK (agent_backend IN ('provider', 'opencode', 'hermes'));

-- One row per Todoist event routed to an external harness. The id is derived
-- from the Todoist event key, so duplicate deliveries map to the same job.
-- The runner owns task → harness session mappings; this table only tracks
-- which progress comment to finalize when the runner calls back.
CREATE TABLE harness_jobs (
  id                  text PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users_config(id) ON DELETE CASCADE,
  todoist_task_id     text NOT NULL,
  backend             text NOT NULL CHECK (backend IN ('opencode', 'hermes')),
  progress_comment_id text,
  status              text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'completed', 'failed', 'cancelled', 'timed_out')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_harness_jobs_user_task ON harness_jobs (user_id, todoist_task_id, created_at DESC);

-- Service role only (Edge Functions). No policies: anon/authenticated get nothing.
ALTER TABLE harness_jobs ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER harness_jobs_updated_at
  BEFORE UPDATE ON harness_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
