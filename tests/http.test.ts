import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchJsonWithRetry, fetchWithRetry, HttpError } from "../src/http.js";

describe("JSON response retries", () => {
  it("retries an HTTP 200 HTML response and accepts subsequent JSON regardless of content type", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return calls === 1
        ? new Response("<!DOCTYPE html><html>Temporarily unavailable</html>")
        : new Response('{"ok":true}');
    });
    assert.deepEqual(
      await fetchJsonWithRetry(
        "https://store.steampowered.com/search/results/",
      ),
      { ok: true },
    );
    assert.equal(calls, 2);
  });

  it("reports the endpoint and attempt count after repeated malformed JSON without exposing query secrets or HTML", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response("<!DOCTYPE html><html>sensitive content</html>");
    });
    await assert.rejects(
      fetchJsonWithRetry(
        "https://store.steampowered.com/api/featuredcategories?key=secret",
        {},
        2,
      ),
      (error: unknown) =>
        error instanceof HttpError &&
        error.attempts === 2 &&
        error.message ===
          "Invalid JSON (HTTP 200) while requesting https://store.steampowered.com/api/featuredcategories",
    );
    assert.equal(calls, 2);
  });

  it("does not retry permanent HTTP errors for JSON requests", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response(null, { status: 403 });
    });
    await assert.rejects(
      fetchJsonWithRetry("https://store.steampowered.com/search/results/"),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
    assert.equal(calls, 1);
  });
});

describe("HTTP response deadlines", () => {
  it("times out a body that stalls after headers, even if the mock ignores abort", async (t) => {
    let signal: AbortSignal | undefined;
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Response(new ReadableStream({ start() {} }));
      },
    );
    await assert.rejects(
      fetchWithRetry("https://store.steampowered.com/test", {}, 1, 20),
      (error: unknown) =>
        error instanceof HttpError &&
        error.attempts === 1 &&
        /timed out/u.test(error.message),
    );
    assert.equal(signal?.aborted, true);
  });

  it("retries a truncated body and preserves the final redirect URL", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("Connection closed"));
            },
          }),
        );
      const response = Response.json({ ok: true });
      Object.defineProperties(response, {
        url: {
          value: "https://steamcommunity.com/app/100/announcements/detail/123",
        },
        redirected: { value: true },
      });
      return response;
    });
    const response = await fetchWithRetry(
      "https://store.steampowered.com/news/123",
      {},
      2,
      1000,
    );
    assert.equal(calls, 2);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(
      response.url,
      "https://steamcommunity.com/app/100/announcements/detail/123",
    );
    assert.equal(response.redirected, true);
  });

  it("does not retry a permanent HTTP error", async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response(null, { status: 403 });
    });
    await assert.rejects(
      fetchWithRetry("https://store.steampowered.com/test"),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
    assert.equal(calls, 1);
  });
});
