import { MODELS, PERSONAS } from "./catalog";
import type { Role } from "./engine";

export const SEAT_COUNT = 8;
export const RANDOM = "random";
const ROLES: readonly Role[] = ["Werewolf", "Seer", "Villager"];

/**
 * A seat's requested model and personality: a catalog id, or `"random"`. A
 * forced `role` exists only on batch rotation setups (`allowRoles`).
 */
export type SeatChoice = { model: string; persona: string; role?: Role };
/** What the operator asked for. Kept in the game state so a setup can be rerun. */
export type GameSetup = { seats: SeatChoice[]; pool: string[] };
export type ResolvedSeat = { model: string; persona: string; role?: Role };

/**
 * PRD composition rule: wolves are a third of the seats, rounded down, plus one
 * Seer; Villagers fill the rest. Listed before the shuffle as p1 wolf, p2 Seer,
 * then any other wolves, then Villagers.
 */
export function rolesFor(seats: number): Role[] {
  const wolves = Math.floor(seats / 3);
  return ["Werewolf", "Seer", ...Array<Role>(wolves - 1).fill("Werewolf"), ...Array<Role>(seats - wolves - 1).fill("Villager")];
}

export const DEFAULT_SETUP: GameSetup = {
  seats: Array.from({ length: SEAT_COUNT }, () => ({ model: RANDOM, persona: RANDOM })),
  pool: MODELS.map(m => m.id),
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validates untrusted input into a normalized setup. `undefined` is the default
 * setup. Forced roles are accepted only with `allowRoles` (the batch's internal
 * start path): all seats or none, concrete models and personalities, and the
 * composition rule's roles. Single games keep their role shuffle.
 */
export function parseSetup(value: unknown, { allowRoles = false }: { allowRoles?: boolean } = {}): GameSetup | { error: string } {
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
    const keys = allowRoles ? ["model", "persona", "role"] : ["model", "persona"];
    if (!isObject(seat) || Object.keys(seat).some(k => !keys.includes(k))) return { error: "Each seat needs a model and a personality." };
    const { model, persona, role } = seat;
    if (typeof model !== "string" || (model !== RANDOM && !modelIds.includes(model))) return { error: "A seat uses an unknown model." };
    if (typeof persona !== "string" || (persona !== RANDOM && !personaIds.includes(persona))) return { error: "A seat uses an unknown personality." };
    if (role !== undefined && !ROLES.includes(role as Role)) return { error: "A seat uses an unknown role." };
    normalized.push(role === undefined ? { model, persona } : { model, persona, role: role as Role });
  }
  const forced = normalized.filter(s => s.role !== undefined);
  if (forced.length) {
    if (forced.length !== normalized.length) return { error: "Assign a role to every seat or to none." };
    if (normalized.some(s => s.model === RANDOM || s.persona === RANDOM)) return { error: "Seats with assigned roles need a concrete model and personality." };
    if (forced.map(s => s.role).sort().join() !== rolesFor(normalized.length).sort().join()) return { error: "Assigned roles must follow the composition rule." };
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
  return JSON.stringify(setup && { seats: setup.seats.map(s => ({ model: s.model, persona: s.persona, ...(s.role ? { role: s.role } : {}) })), pool: setup.pool });
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
    ...(seat.role ? { role: seat.role } : {}),
  }));
}

/**
 * Reads the home form's repeated `seatModel`/`seatPersona` selects and `pool`
 * checkboxes, in form order. Validation is left to `parseSetup`.
 */
export function setupFromForm(form: FormData): { seats: SeatChoice[]; pool: string[] } {
  const models = form.getAll("seatModel").map(String);
  const personas = form.getAll("seatPersona").map(String);
  return {
    seats: models.map((model, i) => ({ model, persona: personas[i] ?? RANDOM })),
    pool: form.getAll("pool").map(String),
  };
}
