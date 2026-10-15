import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  HARNESS_HEADER_NONCE,
  HARNESS_HEADER_SIGNATURE,
  HARNESS_HEADER_TIMESTAMP,
  parseAllowlist,
  signHarnessRequest,
  verifyHarnessRequest,
} from "../_shared/harness-auth.ts";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000;

async function signed(body = '{"a":1}', overrides: Partial<Parameters<typeof signHarnessRequest>[0]> = {}) {
  return new Headers(
    await signHarnessRequest({
      secret: SECRET,
      direction: "edge-to-runner",
      route: "POST /v1/jobs",
      body,
      nowSeconds: NOW,
      ...overrides,
    }),
  );
}

function verify(headers: Headers, overrides: Partial<Parameters<typeof verifyHarnessRequest>[0]> = {}) {
  return verifyHarnessRequest({
    secret: SECRET,
    direction: "edge-to-runner",
    route: "POST /v1/jobs",
    body: '{"a":1}',
    headers,
    nowSeconds: NOW,
    ...overrides,
  });
}

Deno.test("harness-auth: valid signature verifies", async () => {
  const result = await verify(await signed());
  assert(result.ok);
  if (result.ok) assertEquals(result.timestamp, NOW);
});

Deno.test("harness-auth: tampered body is rejected", async () => {
  const result = await verify(await signed(), { body: '{"a":2}' });
  assertEquals(result, { ok: false, reason: "bad_signature" });
});

Deno.test("harness-auth: wrong secret is rejected", async () => {
  const result = await verify(await signed(), { secret: "x".repeat(40) });
  assertEquals(result, { ok: false, reason: "bad_signature" });
});

Deno.test("harness-auth: direction is bound (no reflection)", async () => {
  const result = await verify(await signed(), { direction: "runner-to-edge" });
  assertEquals(result, { ok: false, reason: "bad_signature" });
});

Deno.test("harness-auth: route is bound", async () => {
  const result = await verify(await signed(), { route: "POST /v1/jobs/cancel" });
  assertEquals(result, { ok: false, reason: "bad_signature" });
});

Deno.test("harness-auth: stale and future timestamps are rejected", async () => {
  const headers = await signed();
  assertEquals(await verify(headers, { nowSeconds: NOW + 301 }), { ok: false, reason: "stale" });
  assertEquals(await verify(headers, { nowSeconds: NOW - 301 }), { ok: false, reason: "stale" });
  assert((await verify(headers, { nowSeconds: NOW + 299 })).ok);
});

Deno.test("harness-auth: modified nonce or timestamp breaks signature", async () => {
  const h1 = await signed();
  h1.set(HARNESS_HEADER_NONCE, "abcdefabcdefabcdef0123");
  assertEquals(await verify(h1), { ok: false, reason: "bad_signature" });

  const h2 = await signed();
  h2.set(HARNESS_HEADER_TIMESTAMP, String(NOW + 1));
  assertEquals(await verify(h2), { ok: false, reason: "bad_signature" });
});

Deno.test("harness-auth: missing headers and malformed nonce are rejected", async () => {
  const h = await signed();
  h.delete(HARNESS_HEADER_SIGNATURE);
  assertEquals(await verify(h), { ok: false, reason: "missing_headers" });

  const h2 = await signed();
  h2.set(HARNESS_HEADER_NONCE, "short");
  assertEquals(await verify(h2), { ok: false, reason: "bad_nonce" });
});

Deno.test("harness-auth: missing or short secret fails closed", async () => {
  const h = await signed();
  assertEquals(await verify(h, { secret: undefined }), { ok: false, reason: "misconfigured" });
  assertEquals(await verify(h, { secret: "short" }), { ok: false, reason: "misconfigured" });
  await assertRejects(() => signed("{}", { secret: "short" }));
});

Deno.test("harness-auth: parseAllowlist ignores blanks and junk", () => {
  assertEquals([...parseAllowlist(" 123, ,456,bad id,")], ["123", "456"]);
  assertEquals(parseAllowlist(undefined).size, 0);
  assertEquals(parseAllowlist("").size, 0);
});
