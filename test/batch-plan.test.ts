import { describe, expect, it } from "vitest";
import { available, estimateBatch, nextStart, parseBatchRequest, planRotation, planSlots, type BatchRequest, type SlotLedger } from "../workers/batch/plan";
import { MODELS } from "../workers/game/catalog";
import { createGame, randomIndex, type Role } from "../workers/game/engine";
import type { EstimateInputs } from "../workers/game/estimate";
import { DEFAULT_SETUP, parseSetup, rolesFor, type GameSetup } from "../workers/game/setup";

const ids = MODELS.map(m => m.id);
const base = { gameCount: 4, discussionPasses: 1 };

describe("batch requests", () => {
  it("fills default limits and normalizes both modes", () => {
    expect(parseBatchRequest({ mode: "rotation", pool: [ids[3], ids[0]], ...base })).toEqual({ mode: "rotation", pool: [ids[0], ids[3]], ...base, spendLimitUsd: 5, gameLimitUsd: 1 });
    expect(parseBatchRequest({ mode: "template", setup: DEFAULT_SETUP, ...base, spendLimitUsd: 0.1, gameLimitUsd: 0.05 }))
      .toEqual({ mode: "template", setup: DEFAULT_SETUP, ...base, spendLimitUsd: 0.1, gameLimitUsd: 0.05 });
  });

  it("uses the default setup for a template without one, as a single game does", () => {
    expect(parseBatchRequest({ mode: "template", ...base })).toMatchObject({ mode: "template", setup: DEFAULT_SETUP });
  });

  it.each([
    ["one game", { mode: "rotation", pool: [ids[0]], ...base, gameCount: 1 }],
    ["21 games", { mode: "rotation", pool: [ids[0]], ...base, gameCount: 21 }],
    ["fractional games", { mode: "rotation", pool: [ids[0]], ...base, gameCount: 2.5 }],
    ["three passes", { mode: "rotation", pool: [ids[0]], ...base, discussionPasses: 3 }],
    ["batch limit below $0.10", { mode: "rotation", pool: [ids[0]], ...base, spendLimitUsd: 0.09 }],
    ["batch limit above $20", { mode: "rotation", pool: [ids[0]], ...base, spendLimitUsd: 20.01 }],
    ["fractional cents", { mode: "rotation", pool: [ids[0]], ...base, spendLimitUsd: 1.005 }],
    ["game limit below $0.05", { mode: "rotation", pool: [ids[0]], ...base, gameLimitUsd: 0.04 }],
    ["game limit above the batch limit", { mode: "rotation", pool: [ids[0]], ...base, spendLimitUsd: 0.5, gameLimitUsd: 0.6 }],
    ["default game limit above the batch limit", { mode: "rotation", pool: [ids[0]], ...base, spendLimitUsd: 0.5 }],
    ["no mode", { pool: [ids[0]], ...base }],
    ["unknown field", { mode: "rotation", pool: [ids[0]], ...base, extra: 1 }],
    ["empty pool", { mode: "rotation", pool: [], ...base }],
    ["unknown model", { mode: "rotation", pool: ["vendor/unknown"], ...base }],
    ["rotation with a setup", { mode: "rotation", pool: [ids[0]], setup: DEFAULT_SETUP, ...base }],
    ["template with a pool", { mode: "template", setup: DEFAULT_SETUP, pool: [ids[0]], ...base }],
    ["template with forced roles", { mode: "template", setup: { seats: DEFAULT_SETUP.seats.map(s => ({ ...s, role: "Villager" })), pool: ids }, ...base }],
  ])("rejects %s", (_name, value) => {
    expect(parseBatchRequest(value)).toHaveProperty("error");
  });
});

describe("rotation", () => {
  const counts = (setups: GameSetup[], role?: Role) => {
    const out: Record<string, number> = {};
    for (const s of setups) for (const seat of s.seats) if (!role || seat.role === role) out[seat.model] = (out[seat.model] ?? 0) + 1;
    return out;
  };
  const spread = (byModel: Record<string, number>, pool: string[]) => {
    const values = pool.map(m => byModel[m] ?? 0);
    return Math.max(...values) - Math.min(...values);
  };

  for (const poolSize of [1, 2, 3, 6]) {
    for (const games of [2, 7, 12, 20]) {
      it(`balances every role and seat total for ${poolSize} models over ${games} games`, () => {
        const pool = ids.slice(0, poolSize);
        const setups = planRotation(pool, games, randomIndex);
        expect(setups).toHaveLength(games);
        for (const role of ["Werewolf", "Seer", "Villager"] as const) expect(spread(counts(setups, role), pool)).toBeLessThanOrEqual(1);
        expect(spread(counts(setups), pool)).toBeLessThanOrEqual(1);
        expect(Object.keys(counts(setups)).every(m => pool.includes(m))).toBe(true);
        for (const setup of setups) {
          // Valid on the batch's start path, with the composition rule's roles and distinct personalities.
          expect(parseSetup(setup, { allowRoles: true })).toEqual(setup);
          expect(setup.seats.map(s => s.role).sort()).toEqual(rolesFor(8).sort());
          expect(new Set(setup.seats.map(s => s.persona)).size).toBe(8);
          if (poolSize >= 2) {
            const wolves = setup.seats.filter(s => s.role === "Werewolf").map(s => s.model);
            expect(new Set(wolves).size).toBe(2);
          }
        }
      });
    }
  }

  it("gives each model exactly equal roles when the game count is a multiple of the pool", () => {
    const pool = ids.slice(0, 3);
    const setups = planRotation(pool, 6, randomIndex);
    expect(counts(setups, "Werewolf")).toEqual(Object.fromEntries(pool.map(m => [m, 4])));
    expect(counts(setups, "Seer")).toEqual(Object.fromEntries(pool.map(m => [m, 2])));
    expect(counts(setups, "Villager")).toEqual(Object.fromEntries(pool.map(m => [m, 10])));
  });

  it("does not tie a role to a seat position", () => {
    const seerSeats = new Set(planRotation(ids, 20, randomIndex).map(s => s.seats.findIndex(seat => seat.role === "Seer")));
    expect(seerSeats.size).toBeGreaterThan(1);
    const game = createGame("g", 1, 0, planRotation(ids, 2, randomIndex)[0]);
    expect(game.players.filter(p => p.role === "Seer")).toHaveLength(1);
  });

  it("plans one slot per game with fresh IDs; a template repeats its setup", () => {
    const request = { mode: "template", setup: DEFAULT_SETUP, ...base, spendLimitUsd: 5, gameLimitUsd: 1 } as BatchRequest;
    const slots = planSlots(request, randomIndex);
    expect(slots).toHaveLength(4);
    expect(new Set(slots.map(s => s.gameId)).size).toBe(4);
    expect(slots.every(s => JSON.stringify(s.setup) === JSON.stringify(DEFAULT_SETUP))).toBe(true);
  });
});

describe("escrow", () => {
  const slot = (status: SlotLedger["status"], escrowUsd = 0, chargedUsd = 0): SlotLedger => ({ status, escrowUsd, chargedUsd });

  it("counts settled charges and held escrow, floored to whole cents", () => {
    expect(available(1, [slot("finished", 0, 0.123), slot("running", 0.3), slot("pending")])).toBe(0.57);
    expect(available(1, [slot("start_failed"), slot("skipped_budget"), slot("cancelled")])).toBe(1);
    expect(available(0.1, [slot("aborted", 0, 0.0999)])).toBe(0);
  });

  it("funds the first pending slot at the per-game limit, or what is left", () => {
    expect(nextStart(5, 1, [slot("pending"), slot("pending")], 3)).toEqual({ index: 0, limitUsd: 1 });
    expect(nextStart(1, 1, [slot("running", 0.6), slot("pending")], 3)).toEqual({ index: 1, limitUsd: 0.4 });
    expect(nextStart(1, 1, [slot("finished", 0, 0.9449), slot("pending")], 3)).toEqual({ index: 1, limitUsd: 0.05 });
  });

  it("starts nothing below the $0.05 minimum, at the concurrency cap, or with nothing pending", () => {
    expect(nextStart(1, 1, [slot("finished", 0, 0.951), slot("pending")], 3)).toBeNull();
    expect(nextStart(5, 1, [slot("running", 1), slot("starting", 1), slot("running", 1), slot("pending")], 3)).toBeNull();
    expect(nextStart(5, 1, [slot("finished", 0, 1)], 3)).toBeNull();
  });
});

describe("batch estimate", () => {
  const inputs: EstimateInputs = {
    models: [{ model: ids[0], knownTurns: 100, costUsd: 0.1 }, { model: ids[1], knownTurns: 100, costUsd: 0.3 }],
    shapes: [{ seats: 8, passes: 1, games: 4, meanTurns: 48 }],
  };

  it("multiplies one game's estimate by the game count; rotation prices the pool mean", () => {
    // 6 turns per seat × 8 seats × $0.002 mean = $0.096 a game.
    expect(estimateBatch({ mode: "rotation", pool: [ids[0], ids[1]], gameCount: 10, discussionPasses: 1 }, inputs))
      .toMatchObject({ usd: expect.closeTo(0.96, 10), perGameUsd: expect.closeTo(0.096, 10), games: 4, missing: [] });
    const fixed = { seats: DEFAULT_SETUP.seats.map(s => ({ ...s, model: ids[0] })), pool: [] };
    expect(estimateBatch({ mode: "template", setup: fixed, gameCount: 3, discussionPasses: 1 }, inputs))
      .toMatchObject({ usd: expect.closeTo(0.144, 10), perGameUsd: expect.closeTo(0.048, 10) });
  });

  it("has no estimate without a matching table size", () => {
    expect(estimateBatch({ mode: "rotation", pool: [ids[0]], gameCount: 2, discussionPasses: 1 }, { models: [], shapes: [] }))
      .toEqual({ usd: null, reason: "no_shape", perGameUsd: null });
  });
});
