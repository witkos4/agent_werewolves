import { MODELS, PERSONAS } from "./catalog";

export const SEAT_COUNT = 5;
export const RANDOM = "random";

/** A seat's requested model and personality: a catalog id, or `"random"`. */
export type SeatChoice = { model: string; persona: string };
/** What the operator asked for. Kept in the game state so a setup can be rerun. */
export type GameSetup = { seats: SeatChoice[]; pool: string[] };
export type ResolvedSeat = { model: string; persona: string };

export const DEFAULT_SETUP: GameSetup = {
  seats: Array.from({ length: SEAT_COUNT }, () => ({ model: RANDOM, persona: RANDOM })),
  pool: MODELS.map(m => m.id),
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Validates untrusted input into a normalized setup. `undefined` is the default setup. */
export function parseSetup(value: unknown): GameSetup | { error: string } {
  if (value === undefined) return structuredClone(DEFAULT_SETUP);
  if (!isObject(value) || Object.keys(value).some(k => k !== "seats" && k !== "pool")) return { error: "Setup must have seats and a model pool." };
  const { seats, pool } = value;
  if (!Array.isArray(seats) || seats.length !== SEAT_COUNT) return { error: `Configure exactly ${SEAT_COUNT} seats.` };
  if (!Array.isArray(pool) || pool.some(id => typeof id !== "string")) return { error: "The model pool must be a list of models." };
  const modelIds = MODELS.map(m => m.id);
  const personaIds = PERSONAS.map(p => p.id);
  if (pool.some(id => !modelIds.includes(id))) return { error: "The model pool contains an unknown model." };
  const normalized: SeatChoice[] = [];
  for (const seat of seats) {
    if (!isObject(seat) || Object.keys(seat).some(k => k !== "model" && k !== "persona")) return { error: "Each seat needs a model and a personality." };
    const { model, persona } = seat;
    if (typeof model !== "string" || (model !== RANDOM && !modelIds.includes(model))) return { error: "A seat uses an unknown model." };
    if (typeof persona !== "string" || (persona !== RANDOM && !personaIds.includes(persona))) return { error: "A seat uses an unknown personality." };
    normalized.push({ model, persona });
  }
  const normalizedPool = modelIds.filter(id => pool.includes(id));
  if (normalized.some(s => s.model === RANDOM) && !normalizedPool.length) return { error: "Pick at least one model for the pool." };
  const chosen = normalized.map(s => s.persona).filter(p => p !== RANDOM);
  if (new Set(chosen).size !== chosen.length) return { error: "Each personality can sit at the table only once." };
  if (normalized.filter(s => s.persona === RANDOM).length > personaIds.length - chosen.length) return { error: "Not enough personalities left to draw." };
  return { seats: normalized, pool: normalizedPool };
}

/** Stable key for comparing requested setups. */
export function canonicalSetup(setup: GameSetup | null): string {
  return JSON.stringify(setup && { seats: setup.seats.map(s => ({ model: s.model, persona: s.persona })), pool: setup.pool });
}

/**
 * Draws concrete seats in index order. Random models may repeat; random
 * personalities never repeat, and never reuse one another seat chose.
 */
export function resolveSeats(setup: GameSetup, pick: (length: number) => number): ResolvedSeat[] {
  const left = PERSONAS.map(p => p.id).filter(id => !setup.seats.some(s => s.persona === id));
  return setup.seats.map(seat => ({
    model: seat.model === RANDOM ? setup.pool[pick(setup.pool.length)] : seat.model,
    persona: seat.persona === RANDOM ? left.splice(pick(left.length), 1)[0] : seat.persona,
  }));
}
