import { describe, expect, it } from "vitest";
import { agentView, applyMove, buildRequest, createGame, MODEL, publicGame, validateMove, type Game } from "../workers/game/engine";
import { MODELS } from "../workers/game/catalog";
import type { GameSetup } from "../workers/game/setup";

// No swaps: p1 wolf, p2 Seer, p3–p5 villagers.
const setup = (passes = 1) => createGame("test-game", passes, 100, undefined, length => length - 1);
const target = (game: Game, id: string) => applyMove(game, { target: id, rationale: "private-sentinel" }, () => 0);
const speak = (game: Game) => applyMove(game, { text: "What did you notice?", rationale: "private-sentinel" });
function discussion(game: Game) {
  while (game.phase === "discuss") game = speak(game);
  return game;
}

describe("Werewolf rules and information boundaries", () => {
  it("runs night, bounded discussion and simultaneous votes to a village win", () => {
    let game = target(setup(), "p1");
    game = target(game, "p5");
    expect(game.players.find(p => p.id === "p5")?.alive).toBe(false);
    game = discussion(game);
    expect(game.phase).toBe("vote");
    game = target(game, "p3"); // Wolf's vote is not yet public.
    expect(game.transcript.some(e => e.kind === "votes")).toBe(false);
    expect(agentView(game)).not.toHaveProperty("votes");
    while (game.status === "running") game = target(game, "p1");
    expect(game.winner).toBe("Village");
    expect(publicGame(game).players.every(p => p.role)).toBe(true);
    expect(game.transcript.filter(e => e.kind === "speech")).toHaveLength(4);
    expect(game.transcript.filter(e => e.kind === "votes")).toHaveLength(1);
  });

  it("ends at wolf parity and skips a dead Seer's future actions", () => {
    let game = target(setup(2), "p1");
    game = target(game, "p2");
    game = discussion(game);
    expect(game.transcript.filter(e => e.kind === "speech")).toHaveLength(8);
    while (game.phase === "vote") game = target(game, game.queue[0] === "p5" ? "p4" : "p5");
    expect(game).toMatchObject({ day: 2, phase: "kill", queue: ["p1"] });
    game = target(game, "p4");
    expect(game).toMatchObject({ status: "finished", winner: "Werewolves", queue: [] });
    expect(() => target(game, "p3")).toThrow();
  });

  it("resolves tied votes once and records the chosen tied player publicly", () => {
    let game = discussion(target(target(setup(), "p1"), "p5"));
    game = target(game, "p3");
    game = target(game, "p4");
    game = target(game, "p4");
    game = target(game, "p3");
    expect(game.players.find(p => p.id === "p3")?.alive).toBe(false);
    expect(game.transcript.find(e => e.kind === "votes")?.text).toContain("Tie: p3 chosen at random");
  });

  it("never serializes other agents' private facts or unrevealed authoritative roles", () => {
    let game = target(target(setup(), "p1"), "p5");
    game.privateMoves.find(m => m.actor === "p2")!.move.rationale = "seer-secret-sentinel";
    // p1 speaks first: the wolf must not receive the Seer's investigation/rationale.
    const wolf = agentView(game);
    expect(wolf.investigations).toEqual([]);
    expect(JSON.stringify(wolf)).not.toContain("seer-secret-sentinel");
    expect(wolf.players.every(p => !Object.hasOwn(p, "role"))).toBe(true);
    game = speak(game);
    const seer = agentView(game);
    expect(seer.actor.role).toBe("Seer");
    expect(seer.investigations).toEqual([{ target: "p1", role: "Werewolf" }]);
    expect(seer.ownMoves.every(m => m.actor === "p2")).toBe(true);
    const visible = publicGame(game);
    expect(visible.players.every(p => !Object.hasOwn(p, "role"))).toBe(true);
    for (const secret of ["private-sentinel", "investigations", "privateMoves", "queue", "votes"]) {
      expect(JSON.stringify(visible)).not.toContain(secret);
    }
    const aborted = publicGame({ ...game, status: "aborted" });
    expect(aborted.players.every(p => !p.role)).toBe(true);
  });

  it("rejects self/dead targets, malformed output, extra fields and oversized text", () => {
    const game = setup();
    for (const value of ["not JSON", "[]", '{"target":"p2","rationale":"x"}', '{"target":"p1","rationale":"x","role":"Seer"}', '{"target":"missing","rationale":"x"}', '{"target":"p1"}']) {
      expect(() => validateMove(game, value)).toThrow();
    }
    const day = target(target(game, "p1"), "p5");
    expect(() => validateMove(day, JSON.stringify({ text: "x".repeat(401), rationale: "x" }))).toThrow();
    const vote = discussion(day);
    expect(() => target(vote, "p5")).toThrow();
  });

  it("keeps requests stable, gives turns distinct identities and refuses context overflow", () => {
    const game = setup();
    expect(buildRequest(game)).toBe(buildRequest(game));
    expect(buildRequest(game)).not.toBe(buildRequest({ ...game, turn: 2 }));
    expect(JSON.parse(buildRequest(game))).toMatchObject({ max_tokens: 256, reasoning: { enabled: false } });
    game.transcript.push({ day: 1, kind: "speech", text: "x".repeat(50_000) });
    expect(() => buildRequest(game)).toThrow("context_limit");
  });
});

describe("mixed-model seats and personalities", () => {
  const ids = MODELS.map(m => m.id);
  const mixed: GameSetup = {
    seats: [
      { model: ids[1], persona: "analyst" }, { model: ids[0], persona: "accuser" }, { model: ids[2], persona: "observer" },
      { model: ids[3], persona: "diplomat" }, { model: ids[3], persona: "contrarian" },
    ],
    pool: [],
  };
  const fixed = () => createGame("mixed-game", 1, 100, mixed, length => length - 1);
  const body = (game: Game) => JSON.parse(buildRequest(game));

  it("stores resolved seats, the requested setup and a mixed summary model", () => {
    const game = fixed();
    expect(game.version).toBe(2);
    expect(game.model).toBe("mixed");
    expect(game.setup).toEqual(mixed);
    expect(game.players.map(p => [p.model, p.persona])).toEqual(mixed.seats.map(s => [s.model, s.persona]));
    const same = createGame("same", 1, 100, { seats: mixed.seats.map(s => ({ ...s, model: ids[4] })), pool: [] });
    expect(same.model).toBe(ids[4]);
  });

  it("constrains every reply to a strict per-phase schema", () => {
    let game = fixed();
    expect(body(game).response_format).toEqual({ type: "json_schema", json_schema: { name: "move", strict: true, schema: {
      type: "object", additionalProperties: false, required: ["target", "rationale"],
      properties: { target: { type: "string", enum: ["p1", "p3", "p4", "p5"] }, rationale: expect.objectContaining({ type: "string" }) },
    } } });
    game = target(target(game, "p1"), "p5");
    const schema = body(game).response_format.json_schema.schema;
    expect(schema).toMatchObject({ required: ["text", "rationale"], additionalProperties: false });
    expect(Object.keys(schema.properties)).toEqual(["text", "rationale"]);
  });

  it("shuffles roles independently of the seats", () => {
    const counts = new Set<string>();
    for (let i = 0; i < 30; i++) counts.add(createGame("g", 1, 100, mixed).players.find(p => p.role === "Werewolf")!.model!);
    expect(counts.size).toBeGreaterThan(1);
  });

  it("sends each turn with the actor's model, parameters and personality only", () => {
    let game = fixed(); // p2 is the Seer and acts first.
    let request = body(game);
    expect(request.model).toBe(ids[0]);
    expect(request.temperature).toBe(0.7);
    expect(request.messages[0].content).toContain("Your personality: The Accuser.");
    game = target(game, "p1");
    game = target(game, "p5");
    request = body(game); // p1 speaks first in the day.
    expect(request.model).toBe(ids[1]);
    expect(request).not.toHaveProperty("temperature");
    const text = JSON.stringify(request);
    expect(text).toContain("The Analyst");
    for (const other of ["The Accuser", "The Quiet Observer", "The Diplomat", ids[0], ids[2], ids[3]]) expect(text).not.toContain(other);
    expect(publicGame(game).players[0]).toMatchObject({ model: ids[1], persona: "The Analyst" });
  });

  it("builds a version-1 request on the game model with no personality", () => {
    const legacy = setup();
    legacy.version = 1;
    delete legacy.setup;
    for (const p of legacy.players) { delete p.model; delete p.persona; }
    legacy.model = MODEL;
    const request = body(legacy);
    expect(request).toMatchObject({ model: MODEL, temperature: 0.7 });
    expect(request.messages[0].content).not.toContain("Your personality");
    expect(Object.keys(request)).toEqual(["model", "messages", "max_tokens", "temperature", "response_format", "reasoning", "provider", "user"]);
    expect(publicGame(legacy).players[0]).toMatchObject({ model: MODEL, persona: null });
  });
});
