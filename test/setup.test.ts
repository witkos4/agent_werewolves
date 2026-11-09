import { describe, expect, it } from "vitest";
import { MODELS, PERSONAS } from "../workers/game/catalog";
import { canonicalSetup, DEFAULT_SETUP, parseSetup, resolveSeats, SEAT_COUNT, type GameSetup } from "../workers/game/setup";

const ids = MODELS.map(m => m.id);
const seats = (model: string, persona = "random") => Array.from({ length: SEAT_COUNT }, () => ({ model, persona }));

describe("table setup", () => {
  it("defaults every seat to a random model from the whole catalog and a random personality", () => {
    expect(parseSetup(undefined)).toEqual(DEFAULT_SETUP);
    expect(DEFAULT_SETUP.pool).toEqual(ids);
    expect(SEAT_COUNT).toBe(8);
    expect(DEFAULT_SETUP.seats).toHaveLength(8);
  });

  it("normalizes the pool to catalog order without duplicates", () => {
    expect(parseSetup({ seats: seats("random"), pool: [ids[3], ids[0], ids[3]] })).toEqual({ seats: seats("random"), pool: [ids[0], ids[3]] });
  });

  it.each([
    ["not an object", []],
    ["extra key", { seats: seats(ids[0]), pool: [], extra: 1 }],
    ["seven seats", { seats: seats(ids[0]).slice(1), pool: [] }],
    ["nine seats", { seats: [...seats(ids[0]), seats(ids[0])[0]], pool: [] }],
    ["unknown model", { seats: seats("vendor/unknown"), pool: [] }],
    ["unknown pool model", { seats: seats(ids[0], "analyst").map((s, i) => ({ ...s, persona: PERSONAS[i].id })), pool: ["vendor/unknown"] }],
    ["unknown personality", { seats: seats(ids[0], "nobody"), pool: [] }],
    ["seat extra key", { seats: seats(ids[0]).map(s => ({ ...s, role: "Seer" })), pool: [] }],
    ["empty pool with random seat", { seats: seats("random"), pool: [] }],
    ["repeated personality", { seats: seats(ids[0], "analyst"), pool: [] }],
  ])("rejects %s", (_name, value) => {
    expect(parseSetup(value)).toHaveProperty("error");
  });

  it("accepts an empty pool when no seat draws a model", () => {
    expect(parseSetup({ seats: seats(ids[1]), pool: [] })).toEqual({ seats: seats(ids[1]), pool: [] });
  });

  it("draws models with repeats and personalities without repeats, avoiding chosen ones", () => {
    const setup: GameSetup = {
      seats: [{ model: ids[2], persona: "analyst" }, ...seats("random").slice(1)],
      pool: [ids[0], ids[1]],
    };
    const resolved = resolveSeats(setup, () => 0);
    expect(resolved.map(s => s.model)).toEqual([ids[2], ...Array(SEAT_COUNT - 1).fill(ids[0])]);
    const personas = resolved.map(s => s.persona);
    expect(personas[0]).toBe("analyst");
    expect(new Set(personas).size).toBe(SEAT_COUNT);
    expect(resolveSeats(setup, () => 0)).toEqual(resolved);
  });

  it("has enough personalities for a fully random table", () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(SEAT_COUNT);
    expect(new Set(PERSONAS.map(p => p.id)).size).toBe(PERSONAS.length);
  });

  it("compares requested setups, not resolved draws", () => {
    expect(canonicalSetup(DEFAULT_SETUP)).toBe(canonicalSetup(parseSetup(undefined) as GameSetup));
    expect(canonicalSetup(DEFAULT_SETUP)).not.toBe(canonicalSetup({ ...DEFAULT_SETUP, pool: [ids[0]] }));
    expect(canonicalSetup(null)).toBe("null");
  });
});
