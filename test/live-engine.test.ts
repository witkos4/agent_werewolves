import { describe, expect, it } from "vitest";
import { agentView, applyMove, buildRequest, createGame, publicGame, validateMove, type Game } from "../workers/game/engine";

// No swaps: p1 wolf, p2 Seer, p3–p5 villagers.
const setup = (passes = 1) => createGame("test-game", passes, 100, length => length - 1);
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
