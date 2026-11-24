import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildArchiveSearchParams,
  hasActiveArchiveFilters,
  listArchivedGames,
  parseArchiveQuery,
  parseUtcDateStart,
  writeArchive,
} from "../workers/game/archive";
import { applyMove, createGame, type Game } from "../workers/game/engine";
import { buildRecord } from "../workers/game/record";

// Dedicated models & 2024-06 UTC dates keep this suite isolated from other test files sharing env.ARCHIVE.
const MODEL_ALPHA = "test-browse/alpha";
const MODEL_BETA = "test-browse/beta";
const MODEL_GAMMA = "test-browse/gamma";
const MODEL_UNUSED = "test-browse/never-played";
const PERSONAS = ["analyst", "accuser", "diplomat", "contrarian", "storyteller", "cautious", "instigator"];

const WINDOW = { from: "2024-06-01", to: "2024-06-30" } as const;

/** Deterministic 7-seat table (no shuffle swaps): p1 wolf, p2 Seer, p3 wolf, p4–p7 villagers. */
function makeTable(id: string, models: string[], batchId?: string): Game {
  return createGame(
    id,
    1,
    100,
    { seats: models.map((model, i) => ({ model, persona: PERSONAS[i] })), pool: [] },
    length => length - 1,
    1,
    batchId,
  );
}

const target = (game: Game, seat: string) => applyMove(game, { target: seat, rationale: "r" }, () => 0);
const speakAll = (game: Game) => {
  while (game.status === "running" && game.phase === "discuss") game = applyMove(game, { text: "hm", rationale: "r" });
  return game;
};
function voteOut(game: Game, seat: string, other: string) {
  while (game.status === "running" && game.phase === "vote") game = target(game, game.queue[0] === seat ? other : seat);
  return game;
}

function playVillageWin(id: string, models: string[], batchId?: string) {
  let game = target(makeTable(id, models, batchId), "p1");
  game = voteOut(speakAll(target(target(game, "p7"), "p7")), "p1", "p4");
  game = voteOut(speakAll(target(target(game, "p3"), "p6")), "p3", "p4");
  expect(game.winner).toBe("Village");
  return game;
}

function playWolvesWin(id: string, models: string[], batchId?: string) {
  let game = target(makeTable(id, models, batchId), "p4");
  game = voteOut(speakAll(target(target(game, "p2"), "p2")), "p7", "p1");
  game = target(target(game, "p6"), "p6");
  expect(game.winner).toBe("Werewolves");
  return game;
}

function makeAborted(id: string, models: string[], abortReason = "spend_limit") {
  const game = target(target(makeTable(id, models), "p1"), "p4");
  return { ...game, status: "aborted" as const, abortReason };
}

async function seedGame(game: Game, endedAtIso: string) {
  const endedAt = Date.parse(endedAtIso);
  const turns = game.privateMoves.map((_, i) => ({ turnNo: i + 1, costUsd: 0.001, latencyMs: 50, attempts: 1, generationId: "g" }));
  const record = buildRecord(game, turns, { endedAt, reservedUsd: 0.1, chargedUsd: 0.02 });
  await writeArchive(env.ARCHIVE, record, JSON.stringify(game), endedAt);
  return record;
}

describe("archive filter parsing", () => {
  it("parses valid UTC dates and rejects malformed or non-existent calendar dates", () => {
    expect(parseUtcDateStart("2026-11-15")).toBe(Date.UTC(2026, 10, 15));
    expect(parseUtcDateStart("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
    for (const bad of ["", "2026-02-29", "2026-02-30", "2026-13-01", "2026-1-5", "not-a-date", "2026-11-15T00:00:00Z"]) {
      expect(parseUtcDateStart(bad)).toBeNull();
    }
  });

  it("extracts valid filters and ignores invalid outcomes, dates, pages, and excluded batch params", () => {
    const parsed = parseArchiveQuery(new URLSearchParams(
      "model=anthropic/claude-haiku-5.5&role=Werewolf&outcome=werewolves&from=2024-06-01&to=2024-06-15&page=3&batchId=abc&batch=xyz",
    ));
    expect(parsed).toEqual({
      filter: {
        model: "anthropic/claude-haiku-5.5",
        role: "Werewolf",
        outcome: "werewolves",
        from: "2024-06-01",
        to: "2024-06-15",
      },
      page: 3,
    });
    expect(hasActiveArchiveFilters(parsed.filter)).toBe(true);
    expect(buildArchiveSearchParams(parsed.filter, 3)).toBe(
      "?model=anthropic%2Fclaude-haiku-5.5&role=Werewolf&outcome=werewolves&from=2024-06-01&to=2024-06-15&page=3",
    );
    expect(buildArchiveSearchParams(parsed.filter, 1)).not.toContain("page=");

    const invalid = parseArchiveQuery(new URLSearchParams("model=&role=  &outcome=draw&from=2026-02-30&to=nope&page=0"));
    expect(invalid).toEqual({ filter: {}, page: 1 });
    expect(hasActiveArchiveFilters(invalid.filter)).toBe(false);
    expect(buildArchiveSearchParams(invalid.filter)).toBe("");
  });
});

describe("archive browse and filter queries", () => {
  const ids = {
    villageAlphaWolfBetaSeer: crypto.randomUUID(),
    wolvesBetaWolfAlphaSeer: crypto.randomUUID(),
    abortedGammaOnly: crypto.randomUUID(),
    villageMixedWithBatch: crypto.randomUUID(),
    customNoSeer: crypto.randomUUID(),
  };

  beforeAll(async () => {
    // 1) 2024-06-10 00:00:00.000Z — Village win. p1(Wolf)=Alpha, p2(Seer)=Beta, p3(Wolf)=Alpha, p4..p7(Villager)=Beta
    await seedGame(
      playVillageWin(ids.villageAlphaWolfBetaSeer, [MODEL_ALPHA, MODEL_BETA, MODEL_ALPHA, MODEL_BETA, MODEL_BETA, MODEL_BETA, MODEL_BETA]),
      "2024-06-10T00:00:00.000Z",
    );
    // 2) 2024-06-10 23:59:59.999Z — Werewolves win. p1(Wolf)=Beta, p2(Seer)=Alpha, p3(Wolf)=Beta, p4..p7(Villager)=Alpha
    await seedGame(
      playWolvesWin(ids.wolvesBetaWolfAlphaSeer, [MODEL_BETA, MODEL_ALPHA, MODEL_BETA, MODEL_ALPHA, MODEL_ALPHA, MODEL_ALPHA, MODEL_ALPHA]),
      "2024-06-10T23:59:59.999Z",
    );
    // 3) 2024-06-11 00:00:00.000Z — Aborted (spend_limit). All seats = Gamma
    await seedGame(
      makeAborted(ids.abortedGammaOnly, Array.from({ length: 7 }, () => MODEL_GAMMA), "spend_limit"),
      "2024-06-11T00:00:00.000Z",
    );
    // 4) 2024-06-15 12:30:00.000Z — Village win with batch_id set (included in archive; no batch filter). p1(Wolf)=Gamma, p2(Seer)=Gamma, rest=Alpha
    await seedGame(
      playVillageWin(ids.villageMixedWithBatch, [MODEL_GAMMA, MODEL_GAMMA, MODEL_ALPHA, MODEL_ALPHA, MODEL_ALPHA, MODEL_ALPHA, MODEL_ALPHA], crypto.randomUUID()),
      "2024-06-15T12:30:00.000Z",
    );
    // 5) 2024-06-20 08:00:00.000Z — Archived game containing a Witch seat and no Seer seat (to verify role exclusion).
    const noSeerBase = playVillageWin(ids.customNoSeer, Array.from({ length: 7 }, () => MODEL_BETA));
    await seedGame(noSeerBase, "2024-06-20T08:00:00.000Z");
    await env.ARCHIVE.prepare("UPDATE game_players SET role = 'Witch' WHERE game_id = ? AND role = 'Seer'").bind(ids.customNoSeer).run();
  });

  it("lists all matching archived games newest first and populates distinct model and role options", async () => {
    const res = await listArchivedGames(env.ARCHIVE, WINDOW);
    expect(res.total).toBe(5);
    expect(res.games.map(g => g.id)).toEqual([
      ids.customNoSeer,
      ids.villageMixedWithBatch,
      ids.abortedGammaOnly,
      ids.wolvesBetaWolfAlphaSeer,
      ids.villageAlphaWolfBetaSeer,
    ]);
    expect(res.models).toEqual(expect.arrayContaining([MODEL_ALPHA, MODEL_BETA, MODEL_GAMMA]));
    expect(res.roles).toEqual(expect.arrayContaining(["Werewolf", "Seer", "Villager", "Witch"]));
    expect(res.games[0].players).toHaveLength(7);
  });

  it("filters by model, matching both single-model and mixed-model games and excluding others", async () => {
    const alpha = await listArchivedGames(env.ARCHIVE, { ...WINDOW, model: MODEL_ALPHA });
    expect(alpha.games.map(g => g.id)).toEqual([
      ids.villageMixedWithBatch,
      ids.wolvesBetaWolfAlphaSeer,
      ids.villageAlphaWolfBetaSeer,
    ]);
    expect(alpha.games.map(g => g.id)).not.toContain(ids.abortedGammaOnly);
    expect(alpha.games.map(g => g.id)).not.toContain(ids.customNoSeer);

    const gamma = await listArchivedGames(env.ARCHIVE, { ...WINDOW, model: MODEL_GAMMA });
    expect(gamma.games.map(g => g.id)).toEqual([ids.villageMixedWithBatch, ids.abortedGammaOnly]);

    const empty = await listArchivedGames(env.ARCHIVE, { ...WINDOW, model: MODEL_UNUSED });
    expect(empty.total).toBe(0);
    expect(empty.games).toEqual([]);
  });

  it("filters by role, including games with that role and excluding games without it", async () => {
    const witch = await listArchivedGames(env.ARCHIVE, { ...WINDOW, role: "Witch" });
    expect(witch.games.map(g => g.id)).toEqual([ids.customNoSeer]);

    const seer = await listArchivedGames(env.ARCHIVE, { ...WINDOW, role: "Seer" });
    expect(seer.games.map(g => g.id)).not.toContain(ids.customNoSeer);
    expect(seer.total).toBe(4);

    const guard = await listArchivedGames(env.ARCHIVE, { ...WINDOW, role: "Guard" });
    expect(guard.total).toBe(0);
    expect(guard.games).toEqual([]);
  });

  it("combines model and role on the same seat so a model in another role is excluded", async () => {
    // Alpha played Werewolf in villageAlphaWolfBetaSeer and villageMixedWithBatch,
    // but only played Seer/Villager in wolvesBetaWolfAlphaSeer (where Beta was Werewolf).
    const alphaWolf = await listArchivedGames(env.ARCHIVE, { ...WINDOW, model: MODEL_ALPHA, role: "Werewolf" });
    expect(alphaWolf.games.map(g => g.id)).toEqual([ids.villageMixedWithBatch, ids.villageAlphaWolfBetaSeer]);
    expect(alphaWolf.games.map(g => g.id)).not.toContain(ids.wolvesBetaWolfAlphaSeer);

    // Beta played Seer only in villageAlphaWolfBetaSeer (in customNoSeer its Seer seat became Witch).
    const betaSeer = await listArchivedGames(env.ARCHIVE, { ...WINDOW, model: MODEL_BETA, role: "Seer" });
    expect(betaSeer.games.map(g => g.id)).toEqual([ids.villageAlphaWolfBetaSeer]);

    // Alpha never played Witch.
    const alphaWitch = await listArchivedGames(env.ARCHIVE, { ...WINDOW, model: MODEL_ALPHA, role: "Witch" });
    expect(alphaWitch.total).toBe(0);
    expect(alphaWitch.games).toEqual([]);
  });

  it("filters by outcome (village, werewolves, aborted) and excludes other outcomes", async () => {
    const village = await listArchivedGames(env.ARCHIVE, { ...WINDOW, outcome: "village" });
    expect(village.games.map(g => g.id)).toEqual([ids.customNoSeer, ids.villageMixedWithBatch, ids.villageAlphaWolfBetaSeer]);

    const wolves = await listArchivedGames(env.ARCHIVE, { ...WINDOW, outcome: "werewolves" });
    expect(wolves.games.map(g => g.id)).toEqual([ids.wolvesBetaWolfAlphaSeer]);

    const aborted = await listArchivedGames(env.ARCHIVE, { ...WINDOW, outcome: "aborted" });
    expect(aborted.games.map(g => g.id)).toEqual([ids.abortedGammaOnly]);
  });

  it("filters by UTC date boundaries (single day, range, open-ended, and inverted/empty range)", async () => {
    // Exact single day 2024-06-10 includes 00:00:00.000Z and 23:59:59.999Z, excludes 2024-06-11T00:00:00.000Z.
    const june10 = await listArchivedGames(env.ARCHIVE, { from: "2024-06-10", to: "2024-06-10" });
    expect(june10.games.map(g => g.id)).toEqual([ids.wolvesBetaWolfAlphaSeer, ids.villageAlphaWolfBetaSeer]);

    // From 2024-06-11 through 2024-06-15 includes June 11 and June 15 only.
    const mid = await listArchivedGames(env.ARCHIVE, { from: "2024-06-11", to: "2024-06-15" });
    expect(mid.games.map(g => g.id)).toEqual([ids.villageMixedWithBatch, ids.abortedGammaOnly]);

    // No games on 2024-06-12.
    const emptyDay = await listArchivedGames(env.ARCHIVE, { from: "2024-06-12", to: "2024-06-12" });
    expect(emptyDay.total).toBe(0);
    expect(emptyDay.games).toEqual([]);

    // Inverted range returns empty.
    const inverted = await listArchivedGames(env.ARCHIVE, { from: "2024-06-20", to: "2024-06-10" });
    expect(inverted.total).toBe(0);
    expect(inverted.games).toEqual([]);
  });

  it("combines all four filters together", async () => {
    const combined = await listArchivedGames(env.ARCHIVE, {
      model: MODEL_GAMMA,
      role: "Seer",
      outcome: "village",
      from: "2024-06-11",
      to: "2024-06-20",
    });
    expect(combined.games.map(g => g.id)).toEqual([ids.villageMixedWithBatch]);

    const noMatch = await listArchivedGames(env.ARCHIVE, {
      model: MODEL_GAMMA,
      role: "Seer",
      outcome: "werewolves",
      from: "2024-06-11",
      to: "2024-06-20",
    });
    expect(noMatch.total).toBe(0);
    expect(noMatch.games).toEqual([]);
  });

  it("paginates deterministically and clamps out-of-range pages", async () => {
    const p1 = await listArchivedGames(env.ARCHIVE, WINDOW, { page: 1, pageSize: 2 });
    expect(p1).toMatchObject({ total: 5, page: 1, pageSize: 2, totalPages: 3 });
    expect(p1.games.map(g => g.id)).toEqual([ids.customNoSeer, ids.villageMixedWithBatch]);

    const p2 = await listArchivedGames(env.ARCHIVE, WINDOW, { page: 2, pageSize: 2 });
    expect(p2).toMatchObject({ total: 5, page: 2, pageSize: 2, totalPages: 3 });
    expect(p2.games.map(g => g.id)).toEqual([ids.abortedGammaOnly, ids.wolvesBetaWolfAlphaSeer]);

    const clamped = await listArchivedGames(env.ARCHIVE, WINDOW, { page: 99, pageSize: 2 });
    expect(clamped).toMatchObject({ total: 5, page: 3, pageSize: 2, totalPages: 3 });
    expect(clamped.games.map(g => g.id)).toEqual([ids.villageAlphaWolfBetaSeer]);
  });
});
