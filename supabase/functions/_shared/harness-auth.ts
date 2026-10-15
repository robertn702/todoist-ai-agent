// ---------------------------------------------------------------------------
// Signed requests between the Edge Functions and the external harness runner.
//
// Both directions share one secret but sign a direction label, so a request
// captured in one direction cannot be reflected into the other. The signature
// covers a logical route (not the URL path, which differs behind proxies),
// a unix timestamp, a single-use nonce and the SHA-256 of the raw body.
// Replay protection: callers must reject stale timestamps (done here) and
// previously seen nonces (done by the caller's nonce store).
// ---------------------------------------------------------------------------

export type HarnessDirection = "edge-to-runner" | "runner-to-edge";

export const HARNESS_SIGNATURE_VERSION = "thv1";
export const HARNESS_HEADER_TIMESTAMP = "x-harness-timestamp";
export const HARNESS_HEADER_NONCE = "x-harness-nonce";
export const HARNESS_HEADER_SIGNATURE = "x-harness-signature";
export const HARNESS_MAX_SKEW_SECONDS = 300;
export const HARNESS_MIN_SECRET_LENGTH = 32;

const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}

async function canonicalString(
  direction: HarnessDirection,
  route: string,
  timestamp: string,
  nonce: string,
  body: string,
): Promise<string> {
  return [
    HARNESS_SIGNATURE_VERSION,
    direction,
    route,
    timestamp,
    nonce,
    await sha256Hex(body),
  ].join("\n");
}

export async function signHarnessRequest(opts: {
  secret: string;
  direction: HarnessDirection;
  route: string;
  body: string;
  nowSeconds?: number;
  nonce?: string;
}): Promise<Record<string, string>> {
  if (!opts.secret || opts.secret.length < HARNESS_MIN_SECRET_LENGTH) {
    throw new Error("Harness secret is missing or too short");
  }
  const timestamp = String(opts.nowSeconds ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? crypto.randomUUID().replaceAll("-", "");
  const signature = await hmacHex(
    opts.secret,
    await canonicalString(opts.direction, opts.route, timestamp, nonce, opts.body),
  );
  return {
    [HARNESS_HEADER_TIMESTAMP]: timestamp,
    [HARNESS_HEADER_NONCE]: nonce,
    [HARNESS_HEADER_SIGNATURE]: `${HARNESS_SIGNATURE_VERSION}=${signature}`,
  };
}

export type HarnessVerifyResult =
  | { ok: true; nonce: string; timestamp: number }
  | { ok: false; reason: "missing_headers" | "bad_nonce" | "stale" | "bad_signature" | "misconfigured" };

export async function verifyHarnessRequest(opts: {
  secret: string | undefined;
  direction: HarnessDirection;
  route: string;
  body: string;
  headers: Headers;
  nowSeconds?: number;
  maxSkewSeconds?: number;
}): Promise<HarnessVerifyResult> {
  if (!opts.secret || opts.secret.length < HARNESS_MIN_SECRET_LENGTH) {
    return { ok: false, reason: "misconfigured" };
  }
  const timestamp = opts.headers.get(HARNESS_HEADER_TIMESTAMP);
  const nonce = opts.headers.get(HARNESS_HEADER_NONCE);
  const signature = opts.headers.get(HARNESS_HEADER_SIGNATURE);
  if (!timestamp || !nonce || !signature) return { ok: false, reason: "missing_headers" };
  if (!NONCE_PATTERN.test(nonce)) return { ok: false, reason: "bad_nonce" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "stale" };

  const ts = parseInt(timestamp, 10);
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = opts.maxSkewSeconds ?? HARNESS_MAX_SKEW_SECONDS;
  if (Math.abs(now - ts) > skew) return { ok: false, reason: "stale" };

  const expected = await hmacHex(
    opts.secret,
    await canonicalString(opts.direction, opts.route, timestamp, nonce, opts.body),
  );
  if (!constantTimeEqual(`${HARNESS_SIGNATURE_VERSION}=${expected}`, signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true, nonce, timestamp: ts };
}

/** Parse a comma-separated allowlist of Todoist user IDs. Empty means nobody. */
export function parseAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9_-]{1,64}$/.test(s)),
  );
}
