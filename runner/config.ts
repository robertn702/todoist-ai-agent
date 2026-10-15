import { HARNESS_MIN_SECRET_LENGTH, parseAllowlist } from "../supabase/functions/_shared/harness-auth.ts";
import {
  OPENCODE_DEFAULT_PERMISSIONS,
  type OpenCodeConfig,
  type OpenCodePermissionRule,
} from "./adapters/opencode.ts";
import type { HermesConfig } from "./adapters/hermes.ts";

export interface RunnerConfig {
  secret: string;
  allowedTodoistUserIds: Set<string>;
  callbackUrl: string;
  host: string;
  port: number;
  stateFile: string;
  jobTimeoutMs: number;
  pollIntervalMs: number;
  opencode?: OpenCodeConfig;
  hermes?: HermesConfig;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function parseUrl(name: string, value: string, errors: string[], requireHttpsUnlessLoopback: boolean): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    if (requireHttpsUnlessLoopback && url.protocol === "http:" && !LOOPBACK.has(url.hostname)) {
      errors.push(`${name} must use https unless it targets loopback`);
    }
    if (url.username || url.password) errors.push(`${name} must not embed credentials`);
    return value.replace(/\/+$/, "");
  } catch {
    errors.push(`${name} must be a valid http(s) URL`);
    return "";
  }
}

function positiveInt(name: string, raw: string | undefined, fallback: number, errors: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${name} must be a positive integer`);
    return fallback;
  }
  return n;
}

function parsePermissions(raw: string | undefined, errors: string[]): OpenCodePermissionRule[] {
  if (!raw?.trim()) return OPENCODE_DEFAULT_PERMISSIONS;
  try {
    const rules = JSON.parse(raw);
    if (
      !Array.isArray(rules) || rules.length === 0 ||
      !rules.every((r) =>
        r && typeof r.action === "string" && typeof r.resource === "string" &&
        ["allow", "deny", "ask"].includes(r.effect)
      )
    ) throw new Error();
    return rules;
  } catch {
    errors.push("OPENCODE_PERMISSIONS must be a non-empty JSON array of {action, resource, effect}");
    return OPENCODE_DEFAULT_PERMISSIONS;
  }
}

/** Load and validate runner configuration. Throws with every problem listed. */
export function loadRunnerConfig(env: (key: string) => string | undefined): RunnerConfig {
  const errors: string[] = [];
  const get = (k: string) => {
    const v = env(k);
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };

  const secret = get("HARNESS_RUNNER_SECRET") ?? "";
  if (secret.length < HARNESS_MIN_SECRET_LENGTH) {
    errors.push(`HARNESS_RUNNER_SECRET must be at least ${HARNESS_MIN_SECRET_LENGTH} characters`);
  }

  const allowedTodoistUserIds = parseAllowlist(get("RUNNER_ALLOWED_TODOIST_USER_IDS"));
  if (allowedTodoistUserIds.size === 0) {
    errors.push("RUNNER_ALLOWED_TODOIST_USER_IDS must list at least one Todoist user ID");
  }

  const callbackRaw = get("HARNESS_CALLBACK_URL");
  const callbackUrl = callbackRaw
    ? parseUrl("HARNESS_CALLBACK_URL", callbackRaw, errors, true)
    : (errors.push("HARNESS_CALLBACK_URL is required"), "");

  let opencode: OpenCodeConfig | undefined;
  const opencodeUrl = get("OPENCODE_BASE_URL");
  if (opencodeUrl) {
    const password = get("OPENCODE_SERVER_PASSWORD");
    if (!password) errors.push("OPENCODE_SERVER_PASSWORD is required when OPENCODE_BASE_URL is set");
    const directory = get("OPENCODE_DIRECTORY");
    if (directory && !directory.startsWith("/")) errors.push("OPENCODE_DIRECTORY must be an absolute path");
    const modelRaw = get("OPENCODE_MODEL");
    let model: OpenCodeConfig["model"];
    if (modelRaw) {
      const slash = modelRaw.indexOf("/");
      if (slash <= 0 || slash === modelRaw.length - 1) errors.push("OPENCODE_MODEL must be provider/model");
      else model = { providerID: modelRaw.slice(0, slash), id: modelRaw.slice(slash + 1) };
    }
    opencode = {
      baseUrl: parseUrl("OPENCODE_BASE_URL", opencodeUrl, errors, true),
      username: get("OPENCODE_SERVER_USERNAME") ?? "opencode",
      password: password ?? "",
      directory,
      agent: get("OPENCODE_AGENT"),
      model,
      permissions: parsePermissions(get("OPENCODE_PERMISSIONS"), errors),
    };
  }

  let hermes: HermesConfig | undefined;
  const hermesUrl = get("HERMES_BASE_URL");
  if (hermesUrl) {
    const apiKey = get("HERMES_API_KEY");
    if (!apiKey) errors.push("HERMES_API_KEY is required when HERMES_BASE_URL is set");
    hermes = { baseUrl: parseUrl("HERMES_BASE_URL", hermesUrl, errors, true), apiKey: apiKey ?? "" };
  }

  if (!opencode && !hermes) errors.push("Configure at least one backend: OPENCODE_BASE_URL or HERMES_BASE_URL");

  const home = env("HOME") ?? ".";
  const config: RunnerConfig = {
    secret,
    allowedTodoistUserIds,
    callbackUrl,
    host: get("RUNNER_HOST") ?? "127.0.0.1",
    port: positiveInt("RUNNER_PORT", get("RUNNER_PORT"), 8787, errors),
    stateFile: get("RUNNER_STATE_FILE") ?? `${home}/.local/state/todoist-harness-runner/state.json`,
    jobTimeoutMs: positiveInt("RUNNER_JOB_TIMEOUT_SECONDS", get("RUNNER_JOB_TIMEOUT_SECONDS"), 900, errors) * 1000,
    pollIntervalMs: positiveInt("RUNNER_POLL_INTERVAL_MS", get("RUNNER_POLL_INTERVAL_MS"), 2000, errors),
    opencode,
    hermes,
  };

  if (errors.length > 0) throw new Error(`Invalid runner configuration:\n- ${errors.join("\n- ")}`);
  return config;
}
