import { describe, expect, it } from "vitest";
import { applyMove, createGame, type Game, type Move } from "../workers/game/engine";
import { buildRecord, type TimelineItem, type TurnData } from "../workers/game/record";

// No swaps: p1 wolf, p2 Seer, p3 wolf, p4–p8 villagers.
const setup = (passes = 1) => createGame("record-game", passes, 100, undefined, length => length - 1);
const meta = { endedAt: 500, reservedUsd: 0.01 };
const why = (game: Game) => `why-${game.turn}`;
const target = (game: Game, id: string, pick = () => 0) => applyMove(game, { target: id, rationale: why(game) }, pick);
const speak = (game: Game) => applyMove(game, { text: `says-${game.turn}`, rationale: why(game) });
function discussion(game: Game) {
  while (game.phase === "discuss") game = speak(game);
  return game;
}
/** Everyone votes `id` out; `id` itself votes for `other`. */
function voteOut(game: Game, id: string, other: string) {
  while (game.status === "running" && game.phase === "vote") game = target(game, game.queue[0] === id ? other : id);
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

/**
 * Night 1: the Seer checks p1, both wolves kill p8; the village votes p1 out.
 * Night 2: the Seer checks p3, p3 kills p7; the village votes p3 out.
 */
function villageWin() {
  let game = target(setup(), "p1");
  game = target(target(game, "p8"), "p8");
  game = voteOut(discussion(game), "p1", "p2");
  game = target(target(game, "p3"), "p7");
  return voteOut(discussion(game), "p3", "p2");
}

describe("game record projection", () => {
  it("orders a finished game with night actions, rationale beside speech and individual votes", () => {
    const game = villageWin();
    const record = buildRecord(game, [], meta);

    expect(record).toMatchObject({ status: "finished", winner: "Village", turns: 29, days: 2, totalCostUsd: null, unknownCostTurns: 29 });
    expect(record.players.map(p => [p.seat, p.role, p.survived])).toEqual([
      ["p1", "Werewolf", false], ["p2", "Seer", true], ["p3", "Werewolf", false], ["p4", "Villager", true],
      ["p5", "Villager", true], ["p6", "Villager", true], ["p7", "Villager", false], ["p8", "Villager", false],
    ]);
    expect(shape(record.timeline)).toEqual([
      "phase: Night 1: the village sleeps.",
      "night investigate p2→p1=Werewolf why-1",
      "night kill p1→p8 why-2",
      "night kill p3→p8 why-3",
      "death: Hugo (p8) died during the night.",
      "phase: Day 1: discussion begins.",
      "speech p1 why-4", "speech p2 why-5", "speech p3 why-6", "speech p4 why-7", "speech p5 why-8", "speech p6 why-9", "speech p7 why-10",
      "phase: Voting begins. Votes are revealed together.",
      "vote p1→p2 why-11", "vote p2→p1 why-12", "vote p3→p1 why-13", "vote p4→p1 why-14", "vote p5→p1 why-15", "vote p6→p1 why-16", "vote p7→p1 why-17",
      "votes: p1 → p2; p2 → p1; p3 → p1; p4 → p1; p5 → p1; p6 → p1; p7 → p1.",
      "death: Ada (p1) was eliminated by the village.",
      "phase: Night 2: the village sleeps.",
      "night investigate p2→p3=Werewolf why-18",
      "night kill p3→p7 why-19",
      "death: Gwen (p7) died during the night.",
      "phase: Day 2: discussion begins.",
      "speech p2 why-20", "speech p3 why-21", "speech p4 why-22", "speech p5 why-23", "speech p6 why-24",
      "phase: Voting begins. Votes are revealed together.",
      "vote p2→p3 why-25", "vote p3→p2 why-26", "vote p4→p3 why-27", "vote p5→p3 why-28", "vote p6→p3 why-29",
      "votes: p2 → p3; p3 → p2; p4 → p3; p5 → p3; p6 → p3.",
      "death: Cora (p3) was eliminated by the village.",
    ]);
    const speech = record.timeline.find(i => i.kind === "speech");
    expect(speech).toMatchObject({ text: "says-4", rationale: "why-4" });
    expectEveryMoveOnce(game, record.timeline);
  });

  it("handles two discussion passes, a tie vote and a dead Seer across days", () => {
    let game = target(setup(2), "p4"); // Seer checks a villager.
    game = target(target(game, "p2"), "p2"); // Wolves kill the Seer.
    game = discussion(game);
    // p4 and p5 tie on three votes each; the pick takes p4.
    for (const vote of ["p4", "p5", "p5", "p4", "p4", "p5", "p6"]) game = target(game, vote);
    expect(game).toMatchObject({ day: 2, phase: "kill", queue: ["p1", "p3"] });
    game = target(target(game, "p5"), "p5");
    game = voteOut(discussion(game), "p6", "p7");
    expect(game).toMatchObject({ status: "finished", winner: "Werewolves" });
    const record = buildRecord(game, [], meta);

    const lines = shape(record.timeline);
    expect(lines.filter(l => l.startsWith("speech"))).toHaveLength(14 + 10);
    expect(lines.filter(l => l.startsWith("vote ")).slice(0, 7)).toEqual([
      "vote p1→p4 why-18", "vote p3→p5 why-19", "vote p4→p5 why-20", "vote p5→p4 why-21", "vote p6→p4 why-22", "vote p7→p5 why-23", "vote p8→p6 why-24",
    ]);
    expect(lines.find(l => l.startsWith("votes:"))).toContain("Tie: p4 chosen at random");
    // Night 2 has only the kills: the dead Seer does not act.
    const night2 = lines.indexOf("phase: Night 2: the village sleeps.");
    expect(lines.slice(night2 + 1, night2 + 5)).toEqual([
      "night kill p1→p5 why-25", "night kill p3→p5 why-26", "death: Esme (p5) died during the night.", "phase: Day 2: discussion begins.",
    ]);
    expect(record.days).toBe(2);
    expectEveryMoveOnce(game, record.timeline);
  });

  it("records an aborted game up to its last committed move with known and unknown costs", () => {
    let game = target(setup(), "p4");
    game = target(target(game, "p5"), "p5");
    game = speak(game);
    game = { ...game, status: "aborted", abortReason: "provider_error", queue: [] };
    const turns: TurnData[] = [
      { turnNo: 1, costUsd: 0.001, latencyMs: 900, attempts: 1, generationId: "g1" },
      { turnNo: 2, costUsd: null, latencyMs: 800, attempts: 2, generationId: "g2" },
      { turnNo: 3, costUsd: 0.002, latencyMs: 700, attempts: 1, generationId: "g3" },
      { turnNo: 4, costUsd: null, latencyMs: 600, attempts: 1, generationId: "g4" },
    ];
    const record = buildRecord(game, turns, meta);

    expect(record).toMatchObject({ status: "aborted", winner: null, abortReason: "provider_error", turns: 4, unknownCostTurns: 2, endedAt: 500, reservedUsd: 0.01 });
    expect(record.totalCostUsd).toBeCloseTo(0.003);
    expect(record.moves[1]).toMatchObject({ turnNo: 2, phase: "kill", actor: "p1", target: "p5", costUsd: null, latencyMs: 800, attempts: 2, generationId: "g2" });
    expect(record.moves[0].resultRole).toBe("Villager");
    expect(shape(record.timeline).at(-1)).toBe("speech p1 why-4");
    expectEveryMoveOnce(game, record.timeline);
  });

  it("rebuilds a JSON round-tripped state, as stored by drill rooms and D1, identically", () => {
    const game = villageWin();
    const legacy = JSON.parse(JSON.stringify(game)) as Game;
    expect(buildRecord(legacy, [], meta)).toEqual(buildRecord(game, [], meta));
  });

  it("carries each seat's model and personality, and keeps version-1 seats on the game model", () => {
    const game = villageWin();
    const record = buildRecord(game, [], meta);
    expect(record.setup).toEqual(game.setup);
    expect(record.players.map(p => [p.model, p.persona])).toEqual(game.players.map(p => [p.model, p.persona]));
    const legacy = JSON.parse(JSON.stringify(game)) as Game;
    legacy.version = 1;
    legacy.model = "google/gemini-3.1-flash-lite";
    delete legacy.setup;
    for (const p of legacy.players) { delete p.model; delete p.persona; }
    const old = buildRecord(legacy, [], meta);
    expect(old).toMatchObject({ setup: null, engineVersion: 1, model: "google/gemini-3.1-flash-lite" });
    expect(old.players.every(p => p.model === "google/gemini-3.1-flash-lite" && p.persona === null)).toBe(true);
  });

  it("refuses a move whose public entry is missing", () => {
    const game = villageWin();
    const withoutNight1 = { ...game, transcript: game.transcript.filter(e => !(e.kind === "phase" && e.text.startsWith("Night 1"))) };
    expect(() => buildRecord(withoutNight1, [], meta)).toThrow("record_unplaced_move");
  });

  it("refuses running games and moves by unknown actors", () => {
    const game = target(setup(), "p1");
    expect(() => buildRecord(game, [], meta)).toThrow("record_of_running_game");
    const bad: Game = { ...game, status: "aborted", privateMoves: [{ actor: "p9", phase: "kill", day: 1, move: { target: "p2", rationale: "x" } as Move }] };
    expect(() => buildRecord(bad, [], meta)).toThrow("record_unknown_actor");
  });
});
