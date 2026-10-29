import type { LlmRequest, LlmResult } from "./client";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

type ChatCompletion = {
  id?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { cost?: number };
};

/**
 * One chat-completions call per attempt. The body is sent unchanged and the
 * response cache is on to permit reuse. Production retry hits remain unproven;
 * live-game safety reservations cover every attempt regardless of cache status.
 */
export async function callOpenRouter({ apiKey, body, signal }: LlmRequest): Promise<LlmResult> {
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "Content-Type": "application/json",
        "X-OpenRouter-Cache": "true",
        "X-OpenRouter-Cache-TTL": "86400",
        "X-Title": "Agent Werewolves",
      },
      body,
      signal,
    });
  } catch (error) {
    const reason = signal.aborted ? "timeout" : `network: ${String(error)}`;
    return { ok: false, retryable: true, status: null, reason };
  }

  if (!response.ok) {
    await response.body?.cancel();
    return {
      ok: false,
      retryable: isRetryableStatus(response.status),
      status: response.status,
      reason: `http_${response.status}`,
    };
  }

  let completion: ChatCompletion;
  try {
    completion = await response.json();
  } catch (error) {
    // Includes a timeout while the body is still streaming in.
    return { ok: false, retryable: true, status: response.status, reason: `bad_body: ${String(error)}` };
  }
  const latencyMs = Date.now() - startedAt;

  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text) {
    return { ok: false, retryable: true, status: response.status, reason: "empty_reply" };
  }

  const cacheHit = response.headers.get("X-OpenRouter-Cache-Status")?.toUpperCase() === "HIT";
  return {
    ok: true,
    text,
    // A HIT is free; recording its usage.cost would double-count the original call.
    cost: cacheHit ? 0 : (typeof completion.usage?.cost === "number" && Number.isFinite(completion.usage.cost) && completion.usage.cost >= 0 ? completion.usage.cost : null),
    cacheHit,
    generationId: cacheHit
      ? response.headers.get("X-OpenRouter-Cache-Source-Id")
      : (completion.id ?? null),
    latencyMs,
  };
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
