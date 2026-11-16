import { MODELS, PERSONAS } from "../game/catalog";
import { parseSpendLimit, SAFETY_USD, SPEND_LIMIT_MIN, type Role } from "../game/engine";
import { estimateCost, type Estimate, type EstimateInputs } from "../game/estimate";
import { parseSetup, RANDOM, rolesFor, SEAT_COUNT, type GameSetup } from "../game/setup";

/**
 * Pure batch decisions (S-09): request validation, slot planning, rotation
 * balance, escrow arithmetic and the batch estimate. Rules are pinned in
 * context/changes/headless-batch-runs/plan.md ("Batch rules").
 */

export const BATCH_GAMES_MIN = 2;
export const BATCH_GAMES_MAX = 20;
export const BATCH_LIMIT_MIN = 0.1;
export const BATCH_LIMIT_MAX = 20;
export const BATCH_LIMIT_DEFAULT = 5;

export type BatchMode = "template" | "rotation";

/** A validated batch request; limits are filled in with their defaults. */
export type BatchRequest = ({ mode: "template"; setup: GameSetup } | { mode: "rotation"; pool: string[] }) & {
  gameCount: number;
  discussionPasses: number;
  spendLimitUsd: number;
  gameLimitUsd: number;
};

export type SlotStatus = "pending" | "starting" | "running" | "finished" | "aborted" | "start_failed" | "skipped_budget" | "cancelled";
export const TERMINAL_SLOT: readonly SlotStatus[] = ["finished", "aborted", "start_failed", "skipped_budget", "cancelled"];
/** Slots that hold escrow: their game may be spending. */
export const ACTIVE_SLOT: readonly SlotStatus[] = ["starting", "running"];

/** What the escrow arithmetic needs from a slot. */
export type SlotLedger = { status: SlotStatus; escrowUsd: number; chargedUsd: number };

const KEYS = ["mode", "gameCount", "discussionPasses", "setup", "pool", "spendLimitUsd", "gameLimitUsd"];

const floorCents = (usd: number) => Math.floor(usd * 100 + 1e-6) / 100;

/** Whole cents within the batch bounds; omitted means the default. */
export function parseBatchLimit(value: unknown): number | { error: string } {
  if (value === undefined) return BATCH_LIMIT_DEFAULT;
  const cents = typeof value === "number" ? value * 100 : NaN;
  if (!Number.isFinite(cents) || Math.abs(cents - Math.round(cents)) > 1e-6 || cents < BATCH_LIMIT_MIN * 100 - 1e-6 || cents > BATCH_LIMIT_MAX * 100 + 1e-6) {
    return { error: `Set a batch limit between $${BATCH_LIMIT_MIN.toFixed(2)} and $${BATCH_LIMIT_MAX.toFixed(2)}, in whole cents.` };
  }
  return Math.round(cents) / 100;
}

/** Validates an untrusted batch request (without its request ID). */
export function parseBatchRequest(value: unknown): BatchRequest | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Expected a JSON object." };
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !KEYS.includes(k))) return { error: "The batch request has an unknown field." };
  if (!Number.isInteger(v.gameCount) || (v.gameCount as number) < BATCH_GAMES_MIN || (v.gameCount as number) > BATCH_GAMES_MAX) {
    return { error: `Run between ${BATCH_GAMES_MIN} and ${BATCH_GAMES_MAX} games.` };
  }
  if (![1, 2].includes(v.discussionPasses as number)) return { error: "Choose one or two discussion passes." };
  const spendLimitUsd = parseBatchLimit(v.spendLimitUsd);
  if (typeof spendLimitUsd === "object") return spendLimitUsd;
  const gameLimit = parseSpendLimit(v.gameLimitUsd);
  if (typeof gameLimit === "object") return { error: gameLimit.error.replace("a spend limit", "a per-game limit") };
  const gameLimitUsd = gameLimit ?? SAFETY_USD;
  if (gameLimitUsd > spendLimitUsd + 1e-9) return { error: "The per-game limit cannot be above the batch limit." };
  const base = { gameCount: v.gameCount as number, discussionPasses: v.discussionPasses as number, spendLimitUsd, gameLimitUsd };

  if (v.mode === "template") {
    if (v.pool !== undefined) return { error: "A template batch takes a setup, not a pool." };
    const setup = parseSetup(v.setup);
    if ("error" in setup) return setup;
    return { mode: "template", setup, ...base };
  }
  if (v.mode === "rotation") {
    if (v.setup !== undefined) return { error: "A rotation batch takes a pool, not a setup." };
    const ids = MODELS.map(m => m.id);
    if (!Array.isArray(v.pool) || v.pool.some(id => typeof id !== "string" || !ids.includes(id))) return { error: "The model pool must be a list of catalog models." };
    const pool = ids.filter(id => (v.pool as string[]).includes(id));
    if (!pool.length) return { error: "Pick at least one model for the pool." };
    return { mode: "rotation", pool, ...base };
  }
  return { error: "Choose a template or rotation batch." };
}

function shuffle<T>(items: T[], pick: (length: number) => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Concrete setups with forced roles, so that over the batch every pool model
 * gets each role equally often (±1) and the same number of seats (±1).
 *
 * All role slots of the batch are dealt models in one continuous cycle over a
 * shuffled pool, role by role. Any contiguous run of a cycle gives each model
 * ⌊n/k⌋ or ⌈n/k⌉ slots, so each role and the total are balanced. Game `g` takes
 * the `g`-th block of each role, so a game's two wolves are different models
 * whenever the pool has two. Seats are then shuffled and personalities drawn.
 */
export function planRotation(pool: string[], gameCount: number, pick: (length: number) => number): GameSetup[] {
  const order = shuffle(pool, pick);
  const perGame = rolesFor(SEAT_COUNT);
  const roles: Role[] = ["Seer", "Werewolf", "Villager"];
  const games: { model: string; role: Role }[][] = Array.from({ length: gameCount }, () => []);
  let cursor = 0;
  for (const role of roles) {
    const count = perGame.filter(r => r === role).length;
    for (let g = 0; g < gameCount; g++) {
      for (let i = 0; i < count; i++) games[g].push({ model: order[cursor++ % order.length], role });
    }
  }
  return games.map(seats => {
    const personas = shuffle(PERSONAS.map(p => p.id), pick);
    return { seats: shuffle(seats, pick).map((s, i) => ({ model: s.model, persona: personas[i], role: s.role })), pool: [] };
  });
}

/** One planned game per slot: a fresh game ID and the setup it starts with. */
export function planSlots(request: BatchRequest, pick: (length: number) => number): { gameId: string; setup: GameSetup }[] {
  const setups = request.mode === "rotation" ? planRotation(request.pool, request.gameCount, pick)
    : Array.from({ length: request.gameCount }, () => structuredClone(request.setup));
  return setups.map(setup => ({ gameId: crypto.randomUUID(), setup }));
}

/** Settled charges plus held escrow. */
export function committed(slots: SlotLedger[]): { settledUsd: number; escrowUsd: number } {
  let settledUsd = 0, escrowUsd = 0;
  for (const s of slots) {
    if (ACTIVE_SLOT.includes(s.status)) escrowUsd += s.escrowUsd;
    else settledUsd += s.chargedUsd;
  }
  return { settledUsd, escrowUsd };
}

/** Budget not yet settled or held, floored to whole cents. */
export function available(limitUsd: number, slots: SlotLedger[]): number {
  const { settledUsd, escrowUsd } = committed(slots);
  return Math.max(0, floorCents(limitUsd - settledUsd - escrowUsd));
}

/**
 * The next pending slot to fund and its game limit, or null: at the
 * concurrency cap, nothing pending, or less than the minimum game limit left.
 */
export function nextStart(limitUsd: number, gameLimitUsd: number, slots: SlotLedger[], concurrency: number): { index: number; limitUsd: number } | null {
  if (slots.filter(s => ACTIVE_SLOT.includes(s.status)).length >= concurrency) return null;
  const index = slots.findIndex(s => s.status === "pending");
  if (index < 0) return null;
  const left = available(limitUsd, slots);
  if (left < SPEND_LIMIT_MIN - 1e-9) return null;
  return { index, limitUsd: Math.min(gameLimitUsd, left) };
}

export type BatchEstimate = Estimate & { perGameUsd: number | null };

/**
 * `gameCount` times one game's estimate. Rotation prices every seat as a
 * random draw from the pool: balance makes the pool mean exact on average.
 */
export function estimateBatch(request: Pick<BatchRequest, "gameCount" | "discussionPasses"> & ({ mode: "template"; setup: GameSetup } | { mode: "rotation"; pool: string[] }), inputs: EstimateInputs): BatchEstimate {
  const setup = request.mode === "template" ? request.setup
    : { seats: Array.from({ length: SEAT_COUNT }, () => ({ model: RANDOM, persona: RANDOM })), pool: request.pool };
  const one = estimateCost(setup, request.discussionPasses, inputs);
  if (one.usd === null) return { ...one, perGameUsd: null };
  return { ...one, usd: one.usd * request.gameCount, perGameUsd: one.usd };
}
