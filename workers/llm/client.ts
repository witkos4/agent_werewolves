export type LlmRequest = {
  apiKey: string;
  /** Exact JSON body, sent unchanged so retries hit the gateway cache. */
  body: string;
  signal: AbortSignal;
};

export type LlmResult =
  | {
      ok: true;
      text: string;
      cost: number;
      cacheHit: boolean;
      generationId: string | null;
      latencyMs: number;
    }
  | {
      ok: false;
      retryable: boolean;
      status: number | null;
      reason: string;
    };

export type LlmCall = (request: LlmRequest) => Promise<LlmResult>;

const notConfigured: LlmCall = async () => ({
  ok: false,
  retryable: false,
  status: null,
  reason: "llm_not_configured",
});

let impl: LlmCall = notConfigured;

/** The single seam GameRoom uses for LLM calls. */
export function callLlm(request: LlmRequest): Promise<LlmResult> {
  return impl(request);
}

/** Swap the implementation (tests use a stub). Returns the previous one. */
export function setLlmCall(next: LlmCall): LlmCall {
  const previous = impl;
  impl = next;
  return previous;
}
