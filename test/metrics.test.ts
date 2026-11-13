import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { writeArchive } from "../workers/game/archive";
import { applyMove, createGame, type Game } from "../workers/game/engine";
import { computeMetrics, loadMetrics, type Figure, type MetricRows } from "../workers/game/metrics";
import { buildRecord, type TurnData } from "../workers/game/record";

const G = "google/gemini-3.1-flash-lite";
const H = "anthropic/claude-haiku-5.5";
const PERSONAS = ["analyst", "accuser", "diplomat", "contrarian", "storyteller", "cautious", "instigator"];

/** A 7-seat table (no other test uses 7 seats). No swaps: p1 wolf, p2 Seer, p3 wolf, p4–p7 villagers. */
function table(id: string, models: string[]): Game {
  return createGame(id, 1, 100, { seats: models.map((model, i) => ({ model, persona: PERSONAS[i] })), pool: [] }, length => length - 1);
}
const target = (game: Game, id: string) => applyMove(game, { target: id, rationale: "r" }, () => 0);
const speakAll = (game: Game) => {
  while (game.status === "running" && game.phase === "discuss") game = applyMove(game, { text: "hm", rationale: "r" });
  return game;
};
/** Everyone votes `id` out; `id` itself votes for `other`. */
function voteOut(game: Game, id: string, other: string) {
  while (game.status === "running" && game.phase === "vote") game = target(game, game.queue[0] === id ? other : id);
  return game;
}

/** Night 1: kill p7, vote out p1. Night 2: kill p6, vote out p3. Village wins. */
function villageWin(id: string) {
  let game = target(table(id, [G, H, H, G, H, G, H]), "p1");
  game = voteOut(speakAll(target(target(game, "p7"), "p7")), "p1", "p4");
  game = voteOut(speakAll(target(target(game, "p3"), "p6")), "p3", "p4");
  expect(game.winner).toBe("Village");
  return game;
}

/** Night 1: kill the Seer, vote out villager p7. Night 2: kill p6, wolves reach parity. */
function wolvesWin(id: string) {
  let game = target(table(id, [H, G, G, H, G, H, G]), "p4");
  game = voteOut(speakAll(target(target(game, "p2"), "p2")), "p7", "p1");
  game = target(target(game, "p6"), "p6");
  expect(game.winner).toBe("Werewolves");
  return game;
}

function aborted(id: string) {
  const game = target(target(table(id, [G, G, G, G, G, G, G]), "p1"), "p4");
  return { ...game, status: "aborted" as const, abortReason: "provider_error" };
}

async function archive(game: Game, turn: (n: number) => Omit<TurnData, "turnNo">) {
  const turns = game.privateMoves.map((_, i) => ({ turnNo: i + 1, ...turn(i + 1) }));
  const record = buildRecord(game, turns, { endedAt: 1000, reservedUsd: 0.1 });
  await writeArchive(env.ARCHIVE, record, JSON.stringify(game), 1000);
  return record;
}

const fig = (numerator: number, denominator: number, games: number): Figure => ({ value: denominator ? numerator / denominator : null, numerator, denominator, games });
const close = (value: number) => expect.closeTo(value, 9);

describe("metrics from the archive", () => {
  it("computes every metric for a seat-count filter, as counted by hand", async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const known = { costUsd: 0.001, latencyMs: 100, attempts: 1, generationId: "g" };
    const records = [
      await archive(villageWin(ids[0]), () => known),
      await archive(wolvesWin(ids[1]), n => n === 1 ? { costUsd: null, latencyMs: null, attempts: 1, generationId: null } : known),
      await archive(aborted(ids[2]), () => ({ ...known, costUsd: 0.002 })),
    ];
    // Other files archive 8-seat and 5-seat games into the same D1; 7 seats are only ours.
    await env.ARCHIVE.prepare("DELETE FROM game_moves WHERE game_id IN (SELECT id FROM games WHERE seat_count = 7 AND id NOT IN (?, ?, ?))").bind(...ids).run();
    await env.ARCHIVE.prepare("DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE seat_count = 7 AND id NOT IN (?, ?, ?))").bind(...ids).run();
    await env.ARCHIVE.prepare("DELETE FROM games WHERE seat_count = 7 AND id NOT IN (?, ?, ?)").bind(...ids).run();

    const m = await loadMetrics(env.ARCHIVE, { seats: 7 });
    expect(m.seatCounts).toContain(7);
    expect(m.finishedGames).toBe(2);

    expect(m.winRate.byModel).toEqual([{ model: H, figure: fig(4, 7, 2) }, { model: G, figure: fig(3, 7, 2) }]);
    expect(m.winRate.byModelRole).toEqual([
      { model: H, role: "Seer", figure: fig(1, 1, 1) }, { model: H, role: "Villager", figure: fig(2, 4, 2) }, { model: H, role: "Werewolf", figure: fig(1, 2, 2) },
      { model: G, role: "Seer", figure: fig(0, 1, 1) }, { model: G, role: "Villager", figure: fig(2, 4, 2) }, { model: G, role: "Werewolf", figure: fig(1, 2, 2) },
    ]);

    expect(m.voteAccuracy).toEqual({
      perVote: fig(8, 11, 2),
      perVoteByModel: [{ model: H, figure: fig(4, 6, 2) }, { model: G, figure: fig(4, 5, 2) }],
      perElimination: fig(2, 3, 2),
    });

    const deception = Object.fromEntries(m.deception.map(d => [d.model ?? "all", d]));
    expect(deception[G]).toEqual({
      model: G, survival: fig(1, 2, 2), roundsHeld: 1.5, misdirected: fig(3, 11, 2),
      wolfRate: fig(4, 2, 2), innocentRate: fig(3, 11, 2), suspicionRatio: close(2 / (3 / 11)),
    });
    expect(deception[H]).toEqual({
      model: H, survival: fig(2, 2, 2), roundsHeld: 1.5, misdirected: fig(3, 11, 2),
      wolfRate: fig(4, 3, 2), innocentRate: fig(3, 11, 2), suspicionRatio: close((4 / 3) / (3 / 11)),
    });
    expect(deception.all).toMatchObject({ survival: fig(3, 4, 2), wolfRate: fig(8, 5, 2), innocentRate: fig(3, 11, 2) });

    // Cost counts every game, aborted included, attributed to the acting seat's model.
    const turnsBy = (model: string) => records.flatMap(r => r.moves.filter(mv => r.players.find(p => p.seat === mv.actor)!.model === model));
    for (const model of [G, H]) {
      const turns = turnsBy(model);
      const costs = turns.filter(t => t.costUsd !== null);
      expect(m.cost.byModel.find(c => c.model === model)).toEqual({
        model, turns: turns.length, unknownCostTurns: turns.length - costs.length,
        costUsd: close(costs.reduce((s, t) => s + t.costUsd!, 0)),
        costPerTurnUsd: close(costs.reduce((s, t) => s + t.costUsd!, 0) / costs.length),
        meanLatencyMs: 100, games: model === G ? 3 : 2,
      });
    }
    expect(m.cost.byStatus).toEqual([
      { status: "finished", games: 2, meanCostUsd: close((records[0].totalCostUsd! + records[1].totalCostUsd!) / 2), unknownCostGames: 0, meanTurns: (records[0].turns + records[1].turns) / 2 },
      { status: "aborted", games: 1, meanCostUsd: close(0.004), unknownCostGames: 0, meanTurns: 2 },
    ]);

    // Without the filter every table size is pooled.
    const all = await loadMetrics(env.ARCHIVE);
    expect(all.finishedGames).toBeGreaterThanOrEqual(2);
    expect(all.voteAccuracy.perVote.denominator).toBeGreaterThanOrEqual(11);
  });
});

describe("metric aggregation", () => {
  const empty: MetricRows = { seatCounts: [], seats: [], votes: [], eliminations: [], rounds: [], turns: [], games: [] };

  it("returns null values, not NaN, when nothing is measured", () => {
    const m = computeMetrics(empty);
    expect(m.finishedGames).toBe(0);
    expect(m.voteAccuracy.perVote).toEqual(fig(0, 0, 0));
    expect(m.voteAccuracy.perElimination.value).toBeNull();
    expect(m.deception).toEqual([{ model: null, survival: fig(0, 0, 0), roundsHeld: null, misdirected: fig(0, 0, 0), wolfRate: fig(0, 0, 0), innocentRate: fig(0, 0, 0), suspicionRatio: null }]);
    expect(m.cost.byStatus.map(s => [s.games, s.meanCostUsd, s.meanTurns])).toEqual([[0, null, null], [0, null, null]]);
  });

  it("leaves out a wolf recorded as killed at night, and gives no ratio when innocents drew no votes", () => {
    const seat = (s: string, role: "Werewolf" | "Villager", died_by: "night" | "village" | null, seat_rounds: number, votes_received: number) =>
      ({ game_id: "g", seat: s, model: "m", role, died_by, rounds_held: 2, seat_rounds, votes_received });
    const m = computeMetrics({ ...empty, rounds: [seat("p1", "Werewolf", "night", 0, 0), seat("p2", "Werewolf", null, 2, 1), seat("p3", "Villager", null, 2, 0)] });
    expect(m.deception[0]).toMatchObject({ model: "m", survival: fig(2, 1, 1), wolfRate: fig(1, 2, 1), innocentRate: fig(0, 2, 1), suspicionRatio: null });
  });
});
