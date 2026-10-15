import { assertEquals, assertRejects } from "@std/assert";
import { harnessFetch } from "../adapters/types.ts";

Deno.test("harnessFetch: a body that stalls after headers is aborted by the timeout", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  try {
    await assertRejects(() => harnessFetch("http://harness.test/slow", {}, 20));
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("harnessFetch: buffers the body and preserves status, including empty 204", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) =>
    Promise.resolve(
      String(input).endsWith("/empty")
        ? new Response(null, { status: 204 })
        : new Response('{"ok":true}', { status: 404 }),
    )) as typeof fetch;
  try {
    const a = await harnessFetch("http://harness.test/x", {}, 1000);
    assertEquals(a.status, 404);
    assertEquals(await a.json(), { ok: true });
    const b = await harnessFetch("http://harness.test/empty", {}, 1000);
    assertEquals(b.status, 204);
    assertEquals(await b.text(), "");
  } finally {
    globalThis.fetch = original;
  }
});
