import { describe, expect, it } from "vitest";

import { buildTurnRequest } from "../workers/spike/story";

const base = { gameId: "game-a", model: "test/model", turnNo: 1, previous: [] };

describe("buildTurnRequest", () => {
  it("is byte-identical for the same inputs", () => {
    expect(buildTurnRequest(base)).toBe(buildTurnRequest({ ...base }));
  });

  it("differs across games so games never share cache entries", () => {
    expect(buildTurnRequest(base)).not.toBe(buildTurnRequest({ ...base, gameId: "game-b" }));
    expect(JSON.parse(buildTurnRequest(base)).user).toBe("game-a");
  });

  it("includes every previous turn in order", () => {
    const body = JSON.parse(
      buildTurnRequest({ ...base, turnNo: 3, previous: ["First.", "Second."] }),
    );
    const prompt: string = body.messages[1].content;
    expect(prompt).toContain("1. First.\n2. Second.");
    expect(prompt).toContain("sentence 3");
  });
});
