import { attemptAllowance } from "./engine";
import { RANDOM, type GameSetup } from "./setup";

/** Archive aggregates the estimate is computed from. Small enough to send to the browser. */
export type EstimateInputs = {
  /** Known-cost turns and their summed cost, per acting seat's model, over every archived game. */
  models: { model: string; knownTurns: number; costUsd: number }[];
  /** Finished games per table shape, with their mean move count. */
  shapes: { seats: number; passes: number; games: number; meanTurns: number }[];
};

export type Estimate =
  | { usd: null; reason: "no_shape" }
  | {
      usd: number;
      /** Finished games behind the move count. */
      games: number;
      /** False when the move count comes from the other discussion setting at the same table size. */
      exactShape: boolean;
      /** Fewest known-cost turns behind any model the estimate used from history; null if none did. */
      minModelTurns: number | null;
      /** Models with no cost history; each was priced at `UPPER_BOUND_TURN_USD`. */
      missing: string[];
    };

/** Request size the no-history fallback prices: a mid-game prompt, well under `MAX_INPUT_BYTES`. */
export const UPPER_BOUND_BODY_BYTES = 20_000;
export const UPPER_BOUND_TURN_USD = attemptAllowance("x".repeat(UPPER_BOUND_BODY_BYTES));

export async function readEstimateInputs(db: D1Database): Promise<EstimateInputs> {
  const [models, shapes] = await db.batch([
    db.prepare(`SELECT p.model, COUNT(m.cost_usd) AS known_turns, COALESCE(SUM(m.cost_usd), 0) AS cost_usd
      FROM game_moves m JOIN game_players p ON p.game_id = m.game_id AND p.seat = m.actor GROUP BY p.model`),
    db.prepare(`SELECT seat_count, discussion_passes, COUNT(*) AS games, AVG(turns) AS mean_turns
      FROM games WHERE status = 'finished' GROUP BY seat_count, discussion_passes`),
  ]);
  return {
    models: (models.results as { model: string; known_turns: number; cost_usd: number }[])
      .map(r => ({ model: r.model, knownTurns: r.known_turns, costUsd: r.cost_usd })),
    shapes: (shapes.results as { seat_count: number; discussion_passes: number; games: number; mean_turns: number }[])
      .map(r => ({ seats: r.seat_count, passes: r.discussion_passes, games: r.games, meanTurns: r.mean_turns })),
  };
}

/**
 * Expected cost of a game: per seat, its share of the shape's mean move count
 * times its model's mean cost per known-cost turn. A "Random" seat takes the
 * unweighted mean over the pool. A model with no history is priced at the
 * worst case for a mid-game prompt and reported in `missing`.
 */
export function estimateCost(setup: GameSetup, passes: number, inputs: EstimateInputs): Estimate {
  const seats = setup.seats.length;
  const sameSize = inputs.shapes.filter(s => s.seats === seats && s.games > 0);
  const shape = sameSize.find(s => s.passes === passes) ?? [...sameSize].sort((a, b) => b.games - a.games)[0];
  if (!shape) return { usd: null, reason: "no_shape" };

  const missing = new Set<string>();
  const used: number[] = [];
  const rate = (model: string) => {
    const history = inputs.models.find(m => m.model === model);
    if (!history?.knownTurns) { missing.add(model); return UPPER_BOUND_TURN_USD; }
    used.push(history.knownTurns);
    return history.costUsd / history.knownTurns;
  };
  const seatRate = (model: string) => {
    if (model !== RANDOM) return rate(model);
    return setup.pool.length ? setup.pool.reduce((sum, m) => sum + rate(m), 0) / setup.pool.length : UPPER_BOUND_TURN_USD;
  };
  const turnsPerSeat = shape.meanTurns / seats;
  const usd = setup.seats.reduce((sum, seat) => sum + turnsPerSeat * seatRate(seat.model), 0);
  return { usd, games: shape.games, exactShape: shape.passes === passes, minModelTurns: used.length ? Math.min(...used) : null, missing: [...missing] };
}
