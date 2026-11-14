import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { writeArchive } from "../workers/game/archive";
import { PERSONAS } from "../workers/game/catalog";
import { agentView, applyMove, createGame, type Game } from "../workers/game/engine";
import { estimateCost, readEstimateInputs, UPPER_BOUND_TURN_USD, type EstimateInputs } from "../workers/game/estimate";
import { buildRecord } from "../workers/game/record";
import { RANDOM, type GameSetup } from "../workers/game/setup";

const A = "model/a", B = "model/b", C = "model/c";
const seats = (...models: string[]): GameSetup["seats"] => models.map(model => ({ model, persona: RANDOM }));
const inputs: EstimateInputs = {
  models: [{ model: A, knownTurns: 100, costUsd: 0.1 }, { model: B, knownTurns: 50, costUsd: 0.15 }, { model: C, knownTurns: 0, costUsd: 0 }],
  shapes: [{ seats: 4, passes: 1, games: 3, meanTurns: 40 }, { seats: 4, passes: 2, games: 5, meanTurns: 60 }, { seats: 2, passes: 2, games: 1, meanTurns: 10 }],
};

describe("estimateCost", () => {
  it("prices fixed seats by their model's cost per known turn and the shape's turns per seat", () => {
    // 40 turns / 4 seats = 10 per seat; A costs $0.001 a turn, B $0.003.
    expect(estimateCost({ seats: seats(A, A, B, B), pool: [] }, 1, inputs)).toEqual({ usd: expect.closeTo(0.08, 10), games: 3, exactShape: true, minModelTurns: 50, missing: [] });
  });

  it("prices a random seat at the pool's unweighted mean", () => {
    const estimate = estimateCost({ seats: seats(RANDOM, RANDOM, RANDOM, RANDOM), pool: [A, B] }, 2, inputs);
    // 15 turns per seat × $0.002 mean × 4 seats.
    expect(estimate).toMatchObject({ games: 5, exactShape: true, missing: [] });
    expect(estimate.usd).toBeCloseTo(0.12, 10);
  });

  it("prices a model with no history at the upper bound and names it", () => {
    const estimate = estimateCost({ seats: seats(A, C, "model/new", A), pool: [] }, 1, inputs);
    expect(estimate).toMatchObject({ missing: [C, "model/new"], minModelTurns: 100 });
    expect(estimate.usd).toBeCloseTo(10 * (0.001 * 2 + UPPER_BOUND_TURN_USD * 2), 10);
    expect(estimateCost({ seats: seats(RANDOM, RANDOM), pool: [C] }, 2, inputs)).toMatchObject({ missing: [C], minModelTurns: null });
  });

  it("falls back to the other discussion setting at the same size, preferring more games", () => {
    expect(estimateCost({ seats: seats(A, A), pool: [] }, 1, inputs)).toMatchObject({ exactShape: false, games: 1 });
    expect(estimateCost({ seats: seats(A, A, A, A), pool: [] }, 3, inputs)).toMatchObject({ exactShape: false, games: 5 });
  });

  it("gives no estimate without a finished game of the same size, or with no history at all", () => {
    expect(estimateCost({ seats: seats(A, A, A), pool: [] }, 1, inputs)).toEqual({ usd: null, reason: "no_shape" });
    expect(estimateCost({ seats: seats(A, A, A, A), pool: [] }, 1, { models: [], shapes: [] })).toEqual({ usd: null, reason: "no_shape" });
  });
});

describe("readEstimateInputs", () => {
  // A model id and table size (9 seats, two rounds) no other test archives, since test files share one D1.
  const MODEL = "test/estimate-only";
  /** Plays `moves` legal moves, then ends the game as finished. */
  function archived(id: string, moves: number): Game {
    let game = createGame(id, 2, 100, { seats: PERSONAS.map(p => ({ model: MODEL, persona: p.id })), pool: [] }, n => n - 1);
    for (let i = 0; i < moves; i++) {
      game = applyMove(game, game.phase === "discuss" ? { text: "hm", rationale: "r" } : { target: agentView(game).allowedTargets[0], rationale: "r" }, () => 0);
    }
    return { ...game, status: "finished", winner: "Village" };
  }

  it("aggregates known turn cost per model and mean turns per finished shape", async () => {
    for (const [moves, unknown] of [[6, 1], [10, 0]]) {
      const game = archived(crypto.randomUUID(), moves);
      const turns = game.privateMoves.map((_, i) => ({ turnNo: i + 1, costUsd: i < unknown ? null : 0.002, latencyMs: 1, attempts: 1, generationId: null }));
      await writeArchive(env.ARCHIVE, buildRecord(game, turns, { endedAt: 200, reservedUsd: 0 }), JSON.stringify(game), 300);
    }
    const read = await readEstimateInputs(env.ARCHIVE);
    expect(read.models.find(m => m.model === MODEL)).toEqual({ model: MODEL, knownTurns: 15, costUsd: expect.closeTo(0.03, 10) });
    expect(read.shapes.find(s => s.seats === 9 && s.passes === 2)).toEqual({ seats: 9, passes: 2, games: 2, meanTurns: 8 });
  });
});
