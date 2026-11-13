import { describe, expect, it } from "vitest";
import { agentView, applyMove, buildRequest, createGame, deaths, MODEL, publicGame, rolesFor, validateMove, type Game } from "../workers/game/engine";
import { MODELS } from "../workers/game/catalog";
import type { GameSetup } from "../workers/game/setup";

// No swaps: p1 wolf, p2 Seer, p3 wolf, p4–p8 villagers.
const setup = (passes = 1) => createGame("test-game", passes, 100, undefined, length => length - 1);
const target = (game: Game, id: string) => applyMove(game, { target: id, rationale: "private-sentinel" }, () => 0);
const speak = (game: Game) => applyMove(game, { text: "What did you notice?", rationale: "private-sentinel" });
function discussion(game: Game) {
  while (game.phase === "discuss") game = speak(game);
  return game;
}
/** The Seer (if alive) checks `check`, then every living wolf picks `victim`. */
function night(game: Game, check: string, victim: string) {
  if (game.phase === "investigate") game = target(game, check);
  while (game.status === "running" && game.phase === "kill") game = target(game, victim);
  return game;
}
/** Everyone votes `id` out; `id` itself votes for `other`. */
function voteOut(game: Game, id: string, other: string) {
  while (game.status === "running" && game.phase === "vote") game = target(game, game.queue[0] === id ? other : id);
  return game;
}

describe("Werewolf rules and information boundaries", () => {
  it("seats eight players by the composition rule", () => {
    expect(setup().players.map(p => [p.id, p.name, p.role])).toEqual([
      ["p1", "Ada", "Werewolf"], ["p2", "Bram", "Seer"], ["p3", "Cora", "Werewolf"], ["p4", "Dax", "Villager"],
      ["p5", "Esme", "Villager"], ["p6", "Finn", "Villager"], ["p7", "Gwen", "Villager"], ["p8", "Hugo", "Villager"],
    ]);
    expect([5, 6, 8, 9].map(n => rolesFor(n).filter(r => r === "Werewolf").length)).toEqual([1, 2, 2, 3]);
    for (let i = 0; i < 20; i++) expect(createGame("g", 1, 100).players.filter(p => p.role === "Werewolf")).toHaveLength(2);
  });

  it("runs night, bounded discussion and simultaneous votes to a village win", () => {
    let game = night(setup(), "p1", "p8");
    expect(game.players.find(p => p.id === "p8")?.alive).toBe(false);
    game = discussion(game);
    expect(game.phase).toBe("vote");
    game = target(game, "p4"); // Wolf's vote is not yet public.
    expect(game.transcript.some(e => e.kind === "votes")).toBe(false);
    expect(agentView(game)).not.toHaveProperty("votes");
    game = voteOut(game, "p1", "p4");
    expect(game).toMatchObject({ status: "running", day: 2, phase: "investigate" });
    game = discussion(night(game, "p3", "p7"));
    game = voteOut(game, "p3", "p4");
    expect(game.winner).toBe("Village");
    expect(publicGame(game).players.every(p => p.role)).toBe(true);
    expect(game.transcript.filter(e => e.kind === "speech")).toHaveLength(7 + 5);
    expect(game.transcript.filter(e => e.kind === "votes")).toHaveLength(2);
  });

  it("reads each death's day and cause from the transcript", () => {
    let game = discussion(night(setup(), "p1", "p8"));
    game = discussion(night(voteOut(game, "p1", "p4"), "p3", "p7"));
    game = voteOut(game, "p3", "p4");
    expect(game.winner).toBe("Village");
    expect(deaths(game)).toEqual({
      p8: { day: 1, by: "night" }, p1: { day: 1, by: "village" },
      p7: { day: 2, by: "night" }, p3: { day: 2, by: "village" },
    });
    expect(Object.keys(deaths(game)).sort()).toEqual(game.players.filter(p => !p.alive).map(p => p.id).sort());
    game.transcript.push({ day: 2, kind: "death", text: "Iris (p9) vanished." });
    expect(() => deaths(game)).toThrow("unknown_death_entry");
  });

  it("kills the wolves' most-picked target, breaking ties at random", () => {
    let game = target(setup(), "p4"); // Seer
    expect(game.queue).toEqual(["p1", "p3"]);
    game = target(game, "p5");
    expect(game.players.every(p => p.alive)).toBe(true);
    expect(game.transcript.some(e => e.kind === "death")).toBe(false);
    game = target(game, "p6");
    // p5 and p6 tie; the pick takes the first sorted id.
    expect(game.players.filter(p => !p.alive).map(p => p.id)).toEqual(["p5"]);
    expect(game).toMatchObject({ phase: "discuss", votes: {} });
    const agreed = night(setup(), "p4", "p6");
    expect(agreed.players.filter(p => !p.alive).map(p => p.id)).toEqual(["p6"]);
  });

  it("ends at wolf parity and skips a dead Seer's future actions", () => {
    let game = night(setup(2), "p1", "p2");
    game = discussion(game);
    expect(game.transcript.filter(e => e.kind === "speech")).toHaveLength(14);
    game = voteOut(game, "p8", "p4");
    expect(game).toMatchObject({ day: 2, phase: "kill", queue: ["p1", "p3"] });
    game = discussion(night(game, "", "p7"));
    game = voteOut(game, "p6", "p4");
    expect(game).toMatchObject({ status: "finished", winner: "Werewolves", queue: [] });
    expect(() => target(game, "p4")).toThrow();
  });

  it("resolves tied votes once and records the chosen tied player publicly", () => {
    let game = discussion(night(setup(), "p1", "p8"));
    for (const id of ["p4", "p5", "p4", "p5", "p4", "p5", "p6"]) game = target(game, id);
    expect(game.players.find(p => p.id === "p4")?.alive).toBe(false);
    expect(game.transcript.find(e => e.kind === "votes")?.text).toContain("Tie: p4 chosen at random");
  });

  it("shows a wolf only its teammates' picks from the current night", () => {
    let game = target(setup(), "p4");
    expect(agentView(game)).toMatchObject({ actor: { id: "p1" }, teammates: ["p3"], teamKillVotes: {} });
    expect(agentView(game).allowedTargets).toEqual(["p2", "p4", "p5", "p6", "p7", "p8"]);
    expect(() => target(game, "p3")).toThrow("invalid_target");
    game = target(game, "p6");
    expect(agentView(game)).toMatchObject({ actor: { id: "p3" }, teammates: ["p1"], teamKillVotes: { p1: "p6" } });
    expect(JSON.stringify(agentView(game).teamKillVotes)).not.toContain("private-sentinel");
    game = discussion(target(game, "p6"));
    game = target(game, "p4"); // p1's secret day vote
    game = target(game, "p4"); // p2
    expect(agentView(game)).toMatchObject({ actor: { id: "p3" }, teamKillVotes: {} });
    game = target(game, "p4");
    expect(agentView(game).actor.role).toBe("Villager");
    expect(agentView(game)).not.toHaveProperty("teamKillVotes");
  });

  it("never serializes other agents' private facts or unrevealed authoritative roles", () => {
    let game = night(setup(), "p1", "p8");
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
    expect(seer).not.toHaveProperty("teamKillVotes");
    expect(JSON.stringify(seer.teammates)).toBe("[]");
    const visible = publicGame(game);
    expect(visible.players.every(p => !Object.hasOwn(p, "role"))).toBe(true);
    for (const secret of ["private-sentinel", "investigations", "privateMoves", "queue", "votes", "teamKillVotes"]) {
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
    const day = night(game, "p1", "p8");
    expect(() => validateMove(day, JSON.stringify({ text: "x".repeat(401), rationale: "x" }))).toThrow();
    const vote = discussion(day);
    expect(() => target(vote, "p8")).toThrow();
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
      { model: ids[1], persona: "analyst" }, { model: ids[0], persona: "accuser" }, { model: ids[2], persona: "loyalist" },
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
    for (const other of ["The Accuser", "The Loyalist", "The Diplomat", ids[0], ids[2], ids[3]]) expect(text).not.toContain(other);
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
