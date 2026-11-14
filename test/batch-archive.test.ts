import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listBatches, listRecentGames, readArchivedRecord, readBatch, upsertBatch, writeArchive, type BatchRow } from "../workers/game/archive";
import { applyMove, createGame, type Game } from "../workers/game/engine";
import { loadMetrics } from "../workers/game/metrics";
import { buildRecord } from "../workers/game/record";

const G = "google/gemini-3.1-flash-lite";
const H = "anthropic/claude-haiku-5.5";
const PERSONAS = ["analyst", "accuser", "diplomat", "contrarian"];

/** A 4-seat table (no other test uses 4 seats): p1 wolf, p2 Seer, p3–p4 villagers, no swaps. */
function table(id: string, model: string, batchId?: string): Game {
  return createGame(id, 1, 100, { seats: PERSONAS.map(persona => ({ model, persona })), pool: [] }, length => length - 1, 1, batchId);
}
const target = (game: Game, id: string) => applyMove(game, { target: id, rationale: "r" }, () => 0);

/** Seer checks p1, the wolf kills p4, everyone talks, then everyone votes p1 out: the village wins. */
function villageWin(id: string, model: string, batchId?: string) {
  let game = target(target(table(id, model, batchId), "p1"), "p4");
  while (game.phase === "discuss") game = applyMove(game, { text: "hm", rationale: "r" });
  while (game.status === "running") game = target(game, game.queue[0] === "p1" ? "p2" : "p1");
  expect(game.winner).toBe("Village");
  return game;
}

async function archive(game: Game) {
  const turns = game.privateMoves.map((_, i) => ({ turnNo: i + 1, costUsd: 0.001, latencyMs: 10, attempts: 1, generationId: "g" }));
  const record = buildRecord(game, turns, { endedAt: Date.now(), reservedUsd: 0.1, chargedUsd: 0.02 });
  await writeArchive(env.ARCHIVE, record, JSON.stringify(game), Date.now());
  return record;
}

const batchRow = (id: string, version: number, patch: Partial<BatchRow> = {}): BatchRow => ({
  id, status: "running", mode: "rotation", gameCount: 4, discussionPasses: 1, spendLimitUsd: 2, gameLimitUsd: 0.5, chargedUsd: 0,
  createdAt: 1000, endedAt: null, version, summaryJson: "{}", ...patch,
});

describe("batches in the archive", () => {
  it("round-trips a game's batch and leaves batch games out of the recent list", async () => {
    const batchId = crypto.randomUUID(), inBatch = crypto.randomUUID(), single = crypto.randomUUID();
    const record = await archive(villageWin(inBatch, G, batchId));
    await archive(villageWin(single, G));
    expect(record.batchId).toBe(batchId);
    expect(await readArchivedRecord(env.ARCHIVE, inBatch)).toEqual(record);
    expect((await readArchivedRecord(env.ARCHIVE, single))!.batchId).toBeNull();
    const recent = (await listRecentGames(env.ARCHIVE, 1000)).map(g => g.id);
    expect(recent).toContain(single);
    expect(recent).not.toContain(inBatch);
  });

  it("filters every metric to one batch", async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    await archive(villageWin(crypto.randomUUID(), G, a));
    await archive(villageWin(crypto.randomUUID(), H, a));
    await archive(villageWin(crypto.randomUUID(), H, b));
    await archive(villageWin(crypto.randomUUID(), G));

    const m = await loadMetrics(env.ARCHIVE, { batchId: a });
    expect(m.finishedGames).toBe(2);
    // Village wins: per model, 3 of 4 seats win in its one game.
    expect(m.winRate.byModel.map(r => [r.model, r.figure.numerator, r.figure.denominator, r.figure.games]).sort())
      .toEqual([[G, 3, 4, 1], [H, 3, 4, 1]].sort());
    expect(m.cost.byStatus.find(s => s.status === "finished")!.games).toBe(2);
    expect((await loadMetrics(env.ARCHIVE, { batchId: b })).finishedGames).toBe(1);
    expect((await loadMetrics(env.ARCHIVE, { batchId: crypto.randomUUID() })).finishedGames).toBe(0);
    // Combined with a seat filter.
    expect((await loadMetrics(env.ARCHIVE, { batchId: a, seats: 8 })).finishedGames).toBe(0);
    expect((await loadMetrics(env.ARCHIVE, { batchId: a, seats: 4 })).finishedGames).toBe(2);
  });

  it("upserts a batch copy, never rolling it back to an older version", async () => {
    const id = crypto.randomUUID();
    await upsertBatch(env.ARCHIVE, batchRow(id, 1));
    await upsertBatch(env.ARCHIVE, batchRow(id, 3, { status: "done", chargedUsd: 1.25, endedAt: 2000, summaryJson: '{"v":3}' }));
    await upsertBatch(env.ARCHIVE, batchRow(id, 2, { status: "running", chargedUsd: 0.5 }));
    await upsertBatch(env.ARCHIVE, batchRow(id, 3, { status: "running" }));
    expect(await readBatch(env.ARCHIVE, id)).toEqual(batchRow(id, 3, { status: "done", chargedUsd: 1.25, endedAt: 2000, summaryJson: '{"v":3}' }));
    expect(await readBatch(env.ARCHIVE, crypto.randomUUID())).toBeNull();
  });

  it("lists batches newest first", async () => {
    const older = crypto.randomUUID(), newer = crypto.randomUUID();
    await upsertBatch(env.ARCHIVE, batchRow(older, 1, { createdAt: Date.now() + 10_000 }));
    await upsertBatch(env.ARCHIVE, batchRow(newer, 1, { createdAt: Date.now() + 20_000 }));
    expect((await listBatches(env.ARCHIVE, 2)).map(b => b.id)).toEqual([newer, older]);
  });
});
