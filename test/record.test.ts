import { describe, expect, it } from "vitest";
import { applyMove, createGame, type Game, type Move } from "../workers/game/engine";
import { buildRecord, type TimelineItem, type TurnData } from "../workers/game/record";

// No swaps: p1 wolf, p2 Seer, p3–p5 villagers.
const setup = (passes = 1) => createGame("record-game", passes, 100, length => length - 1);
const meta = { endedAt: 500, reservedUsd: 0.01 };
const why = (game: Game) => `why-${game.turn}`;
const target = (game: Game, id: string, pick = () => 0) => applyMove(game, { target: id, rationale: why(game) }, pick);
const speak = (game: Game) => applyMove(game, { text: `says-${game.turn}`, rationale: why(game) });
function discussion(game: Game) {
  while (game.phase === "discuss") game = speak(game);
  return game;
}
const shape = (items: TimelineItem[]) => items.map(i =>
  i.kind === "speech" ? `speech ${i.actor} ${i.rationale}`
  : i.kind === "vote" ? `vote ${i.actor}→${i.target} ${i.rationale}`
  : i.kind === "night" ? `night ${i.action} ${i.actor}→${i.target}${i.resultRole ? `=${i.resultRole}` : ""} ${i.rationale}`
  : `${i.kind}: ${i.text}`);

function expectEveryMoveOnce(game: Game, items: TimelineItem[]) {
  const turns = items.flatMap(i => "turnNo" in i ? [i.turnNo] : []);
  expect([...turns].sort((a, b) => a - b)).toEqual(game.privateMoves.map((_, i) => i + 1));
}

/** Seer checks the wolf, wolf kills p5, then the village votes the wolf out. */
function villageWin() {
  let game = target(setup(), "p1");
  game = target(game, "p5");
  game = discussion(game);
  while (game.status === "running") game = target(game, game.queue[0] === "p1" ? "p2" : "p1");
  return game;
}

describe("game record projection", () => {
  it("orders a finished game with night actions, rationale beside speech and individual votes", () => {
    const game = villageWin();
    const record = buildRecord(game, [], meta);

    expect(record).toMatchObject({ status: "finished", winner: "Village", turns: 10, days: 1, totalCostUsd: null, unknownCostTurns: 10 });
    expect(record.players.map(p => [p.seat, p.role, p.survived])).toEqual([
      ["p1", "Werewolf", false], ["p2", "Seer", true], ["p3", "Villager", true], ["p4", "Villager", true], ["p5", "Villager", false],
    ]);
    expect(shape(record.timeline)).toEqual([
      "phase: Night 1: the village sleeps.",
      "night investigate p2→p1=Werewolf why-1",
      "night kill p1→p5 why-2",
      "death: Esme (p5) died during the night.",
      "phase: Day 1: discussion begins.",
      "speech p1 why-3", "speech p2 why-4", "speech p3 why-5", "speech p4 why-6",
      "phase: Voting begins. Votes are revealed together.",
      "vote p1→p2 why-7", "vote p2→p1 why-8", "vote p3→p1 why-9", "vote p4→p1 why-10",
      "votes: p1 → p2; p2 → p1; p3 → p1; p4 → p1.",
      "death: Ada (p1) was eliminated by the village.",
    ]);
    const speech = record.timeline.find(i => i.kind === "speech");
    expect(speech).toMatchObject({ text: "says-3", rationale: "why-3" });
    expectEveryMoveOnce(game, record.timeline);
  });

  it("handles two discussion passes, a tie vote and a dead Seer across days", () => {
    let game = target(setup(2), "p3"); // Seer checks a villager.
    game = target(game, "p2"); // Wolf kills the Seer.
    game = discussion(game);
    // p1→p3, p3→p4, p4→p3, p5→p4: p3 and p4 tie, the pick takes p3.
    for (const vote of ["p3", "p4", "p3", "p4"]) game = target(game, vote);
    expect(game).toMatchObject({ day: 2, phase: "kill" });
    game = target(game, "p4");
    expect(game).toMatchObject({ status: "finished", winner: "Werewolves" });
    const record = buildRecord(game, [], meta);

    const lines = shape(record.timeline);
    expect(lines.filter(l => l.startsWith("speech"))).toHaveLength(8);
    expect(lines.filter(l => l.startsWith("vote "))).toEqual(["vote p1→p3 why-11", "vote p3→p4 why-12", "vote p4→p3 why-13", "vote p5→p4 why-14"]);
    expect(lines.find(l => l.startsWith("votes:"))).toContain("Tie: p3 chosen at random");
    // Night 2 has only the kill: the dead Seer does not act.
    const night2 = lines.indexOf("phase: Night 2: the village sleeps.");
    expect(lines.slice(night2 + 1)).toEqual(["night kill p1→p4 why-15", "death: Dax (p4) died during the night."]);
    expect(record.days).toBe(2);
    expectEveryMoveOnce(game, record.timeline);
  });

  it("records an aborted game up to its last committed move with known and unknown costs", () => {
    let game = target(setup(), "p3");
    game = target(game, "p4");
    game = speak(game);
    game = { ...game, status: "aborted", abortReason: "provider_error", queue: [] };
    const turns: TurnData[] = [
      { turnNo: 1, costUsd: 0.001, latencyMs: 900, attempts: 1, generationId: "g1" },
      { turnNo: 2, costUsd: null, latencyMs: 800, attempts: 2, generationId: "g2" },
      { turnNo: 3, costUsd: 0.002, latencyMs: 700, attempts: 1, generationId: "g3" },
    ];
    const record = buildRecord(game, turns, meta);

    expect(record).toMatchObject({ status: "aborted", winner: null, abortReason: "provider_error", turns: 3, unknownCostTurns: 1, endedAt: 500, reservedUsd: 0.01 });
    expect(record.totalCostUsd).toBeCloseTo(0.003);
    expect(record.moves[1]).toMatchObject({ turnNo: 2, phase: "kill", actor: "p1", target: "p4", costUsd: null, latencyMs: 800, attempts: 2, generationId: "g2" });
    expect(record.moves[0].resultRole).toBe("Villager");
    expect(shape(record.timeline).at(-1)).toBe("speech p1 why-3");
    expectEveryMoveOnce(game, record.timeline);
  });

  it("rebuilds a JSON round-tripped state, as stored by drill rooms and D1, identically", () => {
    const game = villageWin();
    const legacy = JSON.parse(JSON.stringify(game)) as Game;
    expect(buildRecord(legacy, [], meta)).toEqual(buildRecord(game, [], meta));
  });

  it("refuses running games and moves by unknown actors", () => {
    const game = target(setup(), "p1");
    expect(() => buildRecord(game, [], meta)).toThrow("record_of_running_game");
    const bad: Game = { ...game, status: "aborted", privateMoves: [{ actor: "p9", phase: "kill", day: 1, move: { target: "p2", rationale: "x" } as Move }] };
    expect(() => buildRecord(bad, [], meta)).toThrow("record_unknown_actor");
  });
});
