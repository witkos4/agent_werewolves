// Spike-only turn logic: a chained story, one sentence per turn. Pure (no
// Cloudflare imports) so S-02 can replace it without touching GameRoom.

const SYSTEM_PROMPT =
  "You are co-writing a very short story, one sentence per turn. " +
  "Reply with exactly one new sentence and nothing else.";

const OPENING_PROMPT =
  "Write the opening sentence of a story about a village that suspects one of its own.";

export type TurnRequestInput = {
  gameId: string;
  model: string;
  turnNo: number;
  /** Saved replies of turns 1..turnNo-1, in order. */
  previous: string[];
};

/**
 * Builds the exact chat-completions body for a turn. The result is stored and
 * re-sent byte-for-byte on retry, so it must be deterministic: fixed key order,
 * no timestamps or randomness. `user: gameId` keeps games from sharing
 * OpenRouter cache entries.
 */
export function buildTurnRequest({
  gameId,
  model,
  turnNo,
  previous,
}: TurnRequestInput): string {
  const prompt =
    previous.length === 0
      ? OPENING_PROMPT
      : `Story so far:\n${previous.map((line, i) => `${i + 1}. ${line}`).join("\n")}\n\n` +
        `Write sentence ${turnNo}, continuing the story.`;

  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: 120,
    temperature: 0.7,
    user: gameId,
  });
}
