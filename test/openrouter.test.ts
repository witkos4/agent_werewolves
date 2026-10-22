import { describe, expect, it, vi } from "vitest";

import { callOpenRouter } from "../workers/llm/openrouter";

const BODY = '{"model":"test/model","user":"game-a"}';

function respondWith(response: Response) {
  const fetchSpy = vi.mocked(globalThis.fetch);
  fetchSpy.mockResolvedValueOnce(response);
  return fetchSpy;
}

function call() {
  return callOpenRouter({ apiKey: "sk-test", body: BODY, signal: new AbortController().signal });
}

const completion = (content: string, cost = 0.00012) =>
  Response.json({ id: "gen-123", choices: [{ message: { content } }], usage: { cost } });

describe("callOpenRouter", () => {
  it("sends the body unchanged with cache headers", async () => {
    const fetchSpy = respondWith(completion("A sentence."));

    await call();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init?.body).toBe(BODY);
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "X-OpenRouter-Cache": "true",
      "X-OpenRouter-Cache-TTL": "86400",
    });
  });

  it("maps a 200 to text, cost and generation id", async () => {
    respondWith(completion("  A sentence.\n"));

    expect(await call()).toMatchObject({
      ok: true,
      text: "A sentence.",
      cost: 0.00012,
      cacheHit: false,
      generationId: "gen-123",
    });
  });

  it("records a cache HIT as free, with the source generation id", async () => {
    const response = completion("Cached.", 0.00012);
    response.headers.set("X-OpenRouter-Cache-Status", "HIT");
    response.headers.set("X-OpenRouter-Cache-Source-Id", "gen-original");
    respondWith(response);

    expect(await call()).toMatchObject({
      ok: true,
      cost: 0,
      cacheHit: true,
      generationId: "gen-original",
    });
  });

  it.each([408, 429, 500, 503])("treats HTTP %i as retryable", async (status) => {
    respondWith(new Response("nope", { status }));

    expect(await call()).toEqual({ ok: false, retryable: true, status, reason: `http_${status}` });
  });

  it.each([400, 401, 402])("treats HTTP %i as final", async (status) => {
    respondWith(new Response("nope", { status }));

    expect(await call()).toMatchObject({ ok: false, retryable: false, status });
  });

  it("treats a network error as retryable", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError("connection reset"));

    expect(await call()).toMatchObject({ ok: false, retryable: true, status: null });
  });

  it("treats an empty reply as retryable", async () => {
    respondWith(completion(""));

    expect(await call()).toMatchObject({ ok: false, retryable: true, reason: "empty_reply" });
  });
});
