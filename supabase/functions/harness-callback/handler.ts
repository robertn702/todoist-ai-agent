import { createServiceClient } from "../_shared/supabase.ts";
import { TodoistClient } from "../_shared/todoist.ts";
import { decrypt } from "../_shared/crypto.ts";
import { captureException } from "../_shared/sentry.ts";
import { ERROR_PREFIX } from "../_shared/constants.ts";
import { verifyHarnessRequest } from "../_shared/harness-auth.ts";
import { CALLBACK_ROUTE } from "../_shared/harness.ts";

// Receives terminal job results from the operator-hosted harness runner and
// finalizes the job's Todoist progress comment. Requests must be signed with
// the shared runner secret (runner-to-edge direction), fresh, and single-use.

const MAX_CALLBACK_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 14_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function formatHarnessResult(
  status: string,
  output: string | null,
  errorCode: string | null,
  deniedApprovals: number,
): string {
  const deniedNote = deniedApprovals > 0
    ? `\n\n_Note: ${deniedApprovals} action(s) that required approval were denied — unattended Todoist runs cannot approve actions._`
    : "";
  switch (status) {
    case "completed": {
      const text = (output ?? "").trim() || "_The agent finished without a text response._";
      const clipped = text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n…(response truncated)` : text;
      return `${clipped}${deniedNote}`;
    }
    case "cancelled":
      return `_Agent run cancelled._${deniedNote}`;
    case "timed_out":
      return `${ERROR_PREFIX} The agent run timed out and was stopped. Retry by adding a comment.${deniedNote}`;
    default: {
      const reason = errorCode === "approval_required"
        ? "The agent needed approval for an action and was stopped (approvals are denied for unattended runs)."
        : errorCode === "harness_auth_failed"
        ? "The agent runner could not authenticate with the agent backend."
        : errorCode === "harness_unreachable" || errorCode === "harness_busy"
        ? "The agent backend is unavailable."
        : errorCode === "runner_restarted"
        ? "The agent runner restarted during the run."
        : "The agent run failed.";
      return `${ERROR_PREFIX} ${reason} Retry by adding a comment.${deniedNote}`;
    }
  }
}

export async function harnessCallbackHandler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const contentLength = req.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_CALLBACK_BYTES) {
    return json({ error: "Payload too large" }, 413);
  }
  const rawBody = await req.text();
  if (rawBody.length > MAX_CALLBACK_BYTES) return json({ error: "Payload too large" }, 413);

  const verified = await verifyHarnessRequest({
    secret: Deno.env.get("HARNESS_RUNNER_SECRET"),
    direction: "runner-to-edge",
    route: CALLBACK_ROUTE,
    body: rawBody,
    headers: req.headers,
  });
  if (!verified.ok) {
    if (verified.reason === "misconfigured") {
      console.error("HARNESS_RUNNER_SECRET is not configured");
      return json({ error: "Not configured" }, 503);
    }
    return json({ error: "Unauthorized" }, 401);
  }

  const supabase = createServiceClient();
  // Replay protection: each nonce is accepted once (retained beyond the freshness window).
  const { data: fresh, error: nonceErr } = await supabase.rpc("try_claim_event", {
    p_event_id: `harness-callback-nonce:${verified.nonce}`,
  });
  if (nonceErr) return json({ error: "Temporarily unavailable" }, 503);
  if (fresh === false) return json({ error: "Replayed request" }, 401);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const jobId = payload.job_id;
  const status = payload.status;
  const todoistUserId = payload.todoist_user_id;
  const output = typeof payload.output === "string" ? payload.output : null;
  const errorCode = typeof payload.error_code === "string" ? payload.error_code : null;
  const denied = Number.isInteger(payload.denied_approvals) ? Math.max(0, payload.denied_approvals as number) : 0;
  if (
    typeof jobId !== "string" || !/^job_[a-f0-9]{32}$/.test(jobId) ||
    typeof status !== "string" || !TERMINAL_STATUSES.has(status) ||
    typeof todoistUserId !== "string"
  ) {
    return json({ error: "Invalid payload" }, 400);
  }

  const { data: job } = await supabase
    .from("harness_jobs")
    .select("id, user_id, todoist_task_id, progress_comment_id, status")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return json({ error: "Unknown job" }, 404);

  const { data: user } = await supabase
    .from("users_config")
    .select("id, todoist_token, todoist_user_id")
    .eq("id", job.user_id)
    .maybeSingle();
  // The job must belong to the Todoist user the runner says it ran for.
  if (!user || String(user.todoist_user_id) !== todoistUserId) return json({ error: "Unknown job" }, 404);

  // Atomically transition submitted → terminal; a repeat callback finds nothing to update.
  const { data: claimed, error: claimErr } = await supabase
    .from("harness_jobs")
    .update({ status })
    .eq("id", jobId)
    .eq("status", "submitted")
    .select("id");
  if (claimErr) return json({ error: "Temporarily unavailable" }, 503);
  if (!claimed || claimed.length === 0) return json({ ok: true, duplicate: true });

  try {
    const todoist = new TodoistClient(await decrypt(user.todoist_token));
    const text = formatHarnessResult(status, output, errorCode, denied);
    if (job.progress_comment_id) {
      await todoist.updateComment(job.progress_comment_id, text);
    } else {
      await todoist.postComment(job.todoist_task_id, text);
    }
    if (status === "completed") {
      await supabase.rpc("increment_ai_requests", { p_todoist_user_id: todoistUserId });
    }
  } catch (error) {
    console.error("Failed to finalize harness job", {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    await captureException(error);
    // Re-open the job so the runner's retry can finalize it.
    await supabase.from("harness_jobs").update({ status: "submitted" }).eq("id", jobId).eq("status", status);
    return json({ error: "Failed to update Todoist" }, 502);
  }

  return json({ ok: true });
}
