import { describe, expect, it } from "vitest";
import { MODELS, PERSONAS } from "../workers/game/catalog";
import { createGame, rolesFor } from "../workers/game/engine";
import {
  canonicalSetup,
  DEFAULT_SETUP,
  defaultSetup,
  formatComposition,
  isValidSeatCount,
  parseSeatCountField,
  parseSetup,
  resizeSeats,
  resolveSeats,
  roleCounts,
  SEAT_COUNT,
  SEAT_COUNT_MAX,
  SEAT_COUNT_MIN,
  SEAT_COUNTS,
  setupFromForm,
  type GameSetup,
} from "../workers/game/setup";

const ids = MODELS.map(m => m.id);
const seats = (model: string, persona = "random", count = SEAT_COUNT) => Array.from({ length: count }, () => ({ model, persona }));

const EXPECTED_COMPOSITIONS = [
  { count: 5, wolves: 1, seer: 1, villagers: 3, text: "1 Werewolf, 1 Seer, 3 Villagers" },
  { count: 6, wolves: 2, seer: 1, villagers: 3, text: "2 Werewolves, 1 Seer, 3 Villagers" },
  { count: 7, wolves: 2, seer: 1, villagers: 4, text: "2 Werewolves, 1 Seer, 4 Villagers" },
  { count: 8, wolves: 2, seer: 1, villagers: 5, text: "2 Werewolves, 1 Seer, 5 Villagers" },
  { count: 9, wolves: 3, seer: 1, villagers: 5, text: "3 Werewolves, 1 Seer, 5 Villagers" },
] as const;

describe("table setup", () => {
  it("defaults every seat to a random model from the whole catalog and a random personality", () => {
    expect(parseSetup(undefined)).toEqual(DEFAULT_SETUP);
    expect(DEFAULT_SETUP.pool).toEqual(ids);
    expect(SEAT_COUNT).toBe(8);
    expect(SEAT_COUNT_MIN).toBe(5);
    expect(SEAT_COUNT_MAX).toBe(9);
    expect(SEAT_COUNTS).toEqual([5, 6, 7, 8, 9]);
    expect(DEFAULT_SETUP.seats).toHaveLength(8);
  });

  it.each(EXPECTED_COMPOSITIONS)("supports $count seats with $text", ({ count, wolves, seer, villagers, text }) => {
    expect(isValidSeatCount(count)).toBe(true);
    expect(roleCounts(count)).toEqual({ wolves, seer, villagers });
    expect(formatComposition(count)).toBe(text);

    const roles = rolesFor(count);
    expect(roles).toHaveLength(count);
    expect(roles.filter(r => r === "Werewolf")).toHaveLength(wolves);
    expect(roles.filter(r => r === "Seer")).toHaveLength(seer);
    expect(roles.filter(r => r === "Villager")).toHaveLength(villagers);

    const fallback = defaultSetup(count);
    expect(parseSetup(fallback)).toEqual(fallback);
    expect(fallback.seats).toHaveLength(count);
    expect(fallback.pool).toEqual(ids);

    const resolved = resolveSeats(fallback, () => 0);
    expect(resolved).toHaveLength(count);
    expect(new Set(resolved.map(s => s.persona)).size).toBe(count);
  });

  it("rejects out-of-range and non-integer seat counts in helpers", () => {
    for (const invalid of [-1, 0, 1, 4, 10, 11, 5.5, Number.NaN, Number.POSITIVE_INFINITY, "6", null, undefined]) {
      expect(isValidSeatCount(invalid)).toBe(false);
    }
    for (const invalid of [0, 4, 10, 6.5, Number.NaN]) {
      expect(() => roleCounts(invalid)).toThrow(RangeError);
      expect(() => defaultSetup(invalid)).toThrow(RangeError);
    }
    for (const invalid of [0, 2, 5.5, Number.NaN]) {
      expect(() => rolesFor(invalid)).toThrow(RangeError);
    }
  });

  it("normalizes the pool to catalog order without duplicates", () => {
    expect(parseSetup({ seats: seats("random"), pool: [ids[3], ids[0], ids[3]] })).toEqual({ seats: seats("random"), pool: [ids[0], ids[3]] });
  });

  it.each([
    ["not an object", []],
    ["extra key", { seats: seats(ids[0]), pool: [], extra: 1 }],
    ["zero seats", { seats: [], pool: [] }],
    ["four seats (below min)", { seats: seats(ids[0], "random", 4), pool: [] }],
    ["ten seats (above max)", { seats: seats(ids[0], "random", 10), pool: [] }],
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
    for (const count of SEAT_COUNTS) {
      expect(parseSetup({ seats: seats(ids[1], "random", count), pool: [] })).toEqual({ seats: seats(ids[1], "random", count), pool: [] });
    }
  });

  it("draws models with repeats and personalities without repeats, avoiding chosen ones", () => {
    const setup: GameSetup = {
      seats: [{ model: ids[2], persona: "analyst" }, ...seats("random", "random", SEAT_COUNT_MAX).slice(1)],
      pool: [ids[0], ids[1]],
    };
    const resolved = resolveSeats(setup, () => 0);
    expect(resolved.map(s => s.model)).toEqual([ids[2], ...Array(SEAT_COUNT_MAX - 1).fill(ids[0])]);
    const personas = resolved.map(s => s.persona);
    expect(personas[0]).toBe("analyst");
    expect(new Set(personas).size).toBe(SEAT_COUNT_MAX);
    expect(resolveSeats(setup, () => 0)).toEqual(resolved);
  });

  it("has enough personalities for a fully random nine-seat table", () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(SEAT_COUNT_MAX);
    expect(new Set(PERSONAS.map(p => p.id)).size).toBe(PERSONAS.length);
  });

  it("resizes seat choices while preserving earlier seats and defaulting added ones to random", () => {
    const initial = [
      { model: ids[0], persona: "analyst" },
      { model: ids[1], persona: "accuser" },
      { model: ids[2], persona: "diplomat" },
    ];
    expect(resizeSeats(initial, 2)).toEqual(initial.slice(0, 2));
    expect(resizeSeats(initial, 5)).toEqual([
      ...initial,
      { model: "random", persona: "random" },
      { model: "random", persona: "random" },
    ]);
  });

  it("parses form seat counts and resizes form seats when a valid seatCount is given", () => {
    expect(parseSeatCountField(null)).toBeUndefined();
    expect(parseSeatCountField("7")).toBe(7);
    expect(parseSeatCountField(" 5 ")).toBe(5);
    expect(parseSeatCountField("4")).toBe(4);
    expect(parseSeatCountField("10")).toBe(10);
    expect(parseSeatCountField("")).toBeNaN();
    expect(parseSeatCountField("6.5")).toBeNaN();
    expect(parseSeatCountField("-5")).toBeNaN();
    expect(parseSeatCountField("abc")).toBeNaN();

    const shrink = new FormData();
    shrink.set("seatCount", "5");
    for (let i = 0; i < 8; i++) {
      shrink.append("seatModel", ids[i % ids.length]);
      shrink.append("seatPersona", PERSONAS[i].id);
    }
    expect(setupFromForm(shrink).seats).toEqual(
      Array.from({ length: 5 }, (_, i) => ({ model: ids[i % ids.length], persona: PERSONAS[i].id })),
    );

    const grow = new FormData();
    grow.set("seatCount", "9");
    for (let i = 0; i < 8; i++) {
      grow.append("seatModel", ids[0]);
      grow.append("seatPersona", PERSONAS[i].id);
    }
    const grown = setupFromForm(grow);
    expect(grown.seats).toHaveLength(9);
    expect(grown.seats[8]).toEqual({ model: "random", persona: "random" });
  });

  it("compares requested setups, not resolved draws", () => {
    expect(canonicalSetup(DEFAULT_SETUP)).toBe(canonicalSetup(parseSetup(undefined) as GameSetup));
    expect(canonicalSetup(DEFAULT_SETUP)).not.toBe(canonicalSetup({ ...DEFAULT_SETUP, pool: [ids[0]] }));
    expect(canonicalSetup(DEFAULT_SETUP)).not.toBe(canonicalSetup(defaultSetup(6)));
    expect(canonicalSetup(null)).toBe("null");
  });
});

describe("forced roles (batch rotation)", () => {
  // Wolf on seats 3 and 6, Seer on seat 8: deliberately not the unshuffled order.
  const roles = ["Villager", "Villager", "Werewolf", "Villager", "Villager", "Werewolf", "Villager", "Seer"] as const;
  const forced = () => ({ seats: roles.map((role, i) => ({ model: ids[i % ids.length], persona: PERSONAS[i].id, role })), pool: [] });

  it("accepts concrete seats with the composition rule's roles only when allowed", () => {
    expect(parseSetup(forced(), { allowRoles: true })).toEqual(forced());
    expect(parseSetup(forced())).toEqual({ error: "Each seat needs a model and a personality." });
    for (const count of SEAT_COUNTS) {
      const sized = {
        seats: rolesFor(count).map((role, i) => ({ model: ids[i % ids.length], persona: PERSONAS[i].id, role })),
        pool: [],
      };
      expect(parseSetup(sized, { allowRoles: true })).toEqual(sized);
    }
  });

  it.each([
    ["roles on some seats only", () => ({ ...forced(), seats: forced().seats.map((s, i) => i ? s : { model: s.model, persona: s.persona }) })],
    ["a random model", () => ({ ...forced(), seats: forced().seats.map((s, i) => i ? s : { ...s, model: "random" }), pool: [ids[0]] })],
    ["a random personality", () => ({ ...forced(), seats: forced().seats.map((s, i) => i ? s : { ...s, persona: "random" }) })],
    ["an unknown role", () => ({ ...forced(), seats: forced().seats.map((s, i) => i ? s : { ...s, role: "Witch" }) })],
    ["three wolves", () => ({ ...forced(), seats: forced().seats.map((s, i) => i ? s : { ...s, role: "Werewolf" }) })],
    ["no Seer", () => ({ ...forced(), seats: forced().seats.map((s, i) => i === 7 ? { ...s, role: "Villager" } : s) })],
  ])("rejects %s", (_name, value) => {
    expect(parseSetup(value(), { allowRoles: true })).toHaveProperty("error");
  });

  it("keeps forced roles in seat order instead of shuffling, and still shuffles without them", () => {
    const setup = parseSetup(forced(), { allowRoles: true }) as GameSetup;
    const game = createGame("g", 1, 0, setup, () => 0);
    expect(game.players.map(p => p.role)).toEqual(roles);
    expect(game.players.map(p => p.model)).toEqual(setup.seats.map(s => s.model));
    expect(game.queue).toEqual(["p8"]);
    // pick = 0 swaps every role toward the front, so unforced roles leave rolesFor order.
    const shuffled = createGame("g", 1, 0, { ...setup, seats: setup.seats.map(({ model, persona }) => ({ model, persona })) }, () => 0);
    expect(shuffled.players.map(p => p.role)).not.toEqual(rolesFor(SEAT_COUNT));
    expect(shuffled.players.map(p => p.role).sort()).toEqual(rolesFor(SEAT_COUNT).sort());
  });

  it("treats forced roles as part of the requested setup", () => {
    const setup = forced();
    const unforced = { ...setup, seats: setup.seats.map(({ model, persona }) => ({ model, persona })) };
    expect(canonicalSetup(setup)).not.toBe(canonicalSetup(unforced));
    expect(canonicalSetup(setup)).toBe(canonicalSetup(forced()));
  });
});
