import { env } from "cloudflare:workers";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, RouterContextProvider, StaticRouterProvider } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import { cloudflareContext } from "../app/cloudflare-context";
import ArchivePage, { loader as archiveLoader } from "../app/routes/archive";
import { loader as gameLoader } from "../app/routes/games.$gameId";
import { writeArchive } from "../workers/game/archive";
import { applyMove, createGame, type Game } from "../workers/game/engine";
import { buildRecord } from "../workers/game/record";
import { gate } from "../workers/gate";

const MODEL_A = "test-route-browse/model-a";
const MODEL_B = "test-route-browse/model-b";
const PERSONAS = ["analyst", "accuser", "diplomat", "contrarian", "storyteller", "cautious", "instigator"];

function args(path: string, params: Record<string, string> = {}, routeEnv: Env = env) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: routeEnv, ctx: {} as ExecutionContext });
  const request = new Request(`https://example.test${path}`);
  return { request, context, params, url: new URL(request.url), pattern: path } as never;
}

async function loadArchive(path: string, routeEnv: Env = env) {
  return (await archiveLoader(args(path, {}, routeEnv)) as unknown as { data: Awaited<ReturnType<typeof archiveLoader>>["data"] }).data;
}

async function renderArchive(path: string, loaderData: Awaited<ReturnType<typeof loadArchive>>) {
  const routes = [{ path: "/archive", Component: () => createElement(ArchivePage, { loaderData } as never) }];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`https://example.test${path}`));
  if (context instanceof Response) throw new Error(`Unexpected response: ${context.status}`);
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToStaticMarkup(createElement(StaticRouterProvider, { router, context }));
}

function makeVillageWin(id: string, models: string[]): Game {
  let game = createGame(
    id,
    1,
    100,
    { seats: models.map((model, i) => ({ model, persona: PERSONAS[i] })), pool: [] },
    length => length - 1,
  );
  const target = (g: Game, seat: string) => applyMove(g, { target: seat, rationale: "route-browse-rationale" }, () => 0);
  game = target(game, "p1");
  game = target(target(game, "p7"), "p7");
  while (game.status === "running" && game.phase === "discuss") game = applyMove(game, { text: "discussion", rationale: "route-browse-rationale" });
  while (game.status === "running" && game.phase === "vote") game = target(game, game.queue[0] === "p1" ? "p4" : "p1");
  game = target(target(game, "p3"), "p6");
  while (game.status === "running" && game.phase === "discuss") game = applyMove(game, { text: "day 2", rationale: "route-browse-rationale" });
  while (game.status === "running" && game.phase === "vote") game = target(game, game.queue[0] === "p3" ? "p4" : "p3");
  expect(game.winner).toBe("Village");
  return game;
}

describe("archive browse route", () => {
  const villageGameId = crypto.randomUUID();
  const abortedGameId = crypto.randomUUID();

  beforeAll(async () => {
    const village = makeVillageWin(villageGameId, [MODEL_A, MODEL_B, MODEL_A, MODEL_B, MODEL_B, MODEL_B, MODEL_B]);
    const villageEnded = Date.parse("2024-07-10T14:30:00.000Z");
    const villageTurns = village.privateMoves.map((_, i) => ({ turnNo: i + 1, costUsd: 0.001, latencyMs: 40, attempts: 1, generationId: "g" }));
    await writeArchive(env.ARCHIVE, buildRecord(village, villageTurns, { endedAt: villageEnded, reservedUsd: 0.1, chargedUsd: 0.02 }), JSON.stringify(village), villageEnded);

    let aborted = createGame(
      abortedGameId,
      1,
      100,
      { seats: Array.from({ length: 7 }, (_, i) => ({ model: MODEL_B, persona: PERSONAS[i] })), pool: [] },
      length => length - 1,
    );
    aborted = applyMove(aborted, { target: "p1", rationale: "abort-rationale" }, () => 0);
    aborted = { ...aborted, status: "aborted", abortReason: "time_limit" };
    const abortedEnded = Date.parse("2024-07-12T09:15:00.000Z");
    await writeArchive(
      env.ARCHIVE,
      buildRecord(aborted, [{ turnNo: 1, costUsd: 0.001, latencyMs: 30, attempts: 1, generationId: "g" }], { endedAt: abortedEnded, reservedUsd: 0.1, chargedUsd: 0.01 }),
      JSON.stringify(aborted),
      abortedEnded,
    );
  });

  it("renders matching filtered games with links that open the existing game record", async () => {
    const path = `/archive?model=${encodeURIComponent(MODEL_A)}&role=Werewolf&outcome=village&from=2024-07-01&to=2024-07-31`;
    const data = await loadArchive(path);
    expect(data.error).toBe(false);
    expect(data.archive!.games.map(g => g.id)).toEqual([villageGameId]);

    const html = await renderArchive(path, data);
    expect(html).toContain(`href="/games/${villageGameId}"`);
    expect(html).not.toContain(abortedGameId);
    expect(html).toContain("Village win");
    expect(html).toContain("Clear filters");

    // Following the selected game's link loads its existing archived record with rationale.
    const recordRes = await gameLoader(args(`/games/${villageGameId}`, { gameId: villageGameId })) as unknown as {
      data: Awaited<ReturnType<typeof gameLoader>>["data"];
    };
    expect(recordRes.data).toMatchObject({
      kind: "record",
      archived: true,
      record: { id: villageGameId, status: "finished", winner: "Village" },
    });
    if (recordRes.data.kind !== "record") throw new Error("expected record");
    expect(recordRes.data.record.timeline.some(item => item.kind === "speech" && item.rationale === "route-browse-rationale")).toBe(true);

    // Filtering by aborted renders the aborted game and its reason, excluding the finished game.
    const abortedPath = "/archive?outcome=aborted&from=2024-07-01&to=2024-07-31";
    const abortedData = await loadArchive(abortedPath);
    expect(abortedData.archive!.games.map(g => g.id)).toEqual([abortedGameId]);
    const abortedHtml = await renderArchive(abortedPath, abortedData);
    expect(abortedHtml).toContain(`href="/games/${abortedGameId}"`);
    expect(abortedHtml).toContain("Aborted · time limit");
    expect(abortedHtml).not.toContain(villageGameId);
  });

  it("preserves active filters in pagination links", async () => {
    const html = await renderArchive("/archive?outcome=village&page=2", {
      archive: {
        games: [{
          id: villageGameId, status: "finished", winner: "Village", abortReason: null, model: MODEL_A,
          seatCount: 7, days: 2, turns: 10, totalCostUsd: 0.01, endedAt: Date.parse("2024-07-10T14:30:00.000Z"), players: [],
        }],
        total: 60, page: 2, pageSize: 25, totalPages: 3, models: [MODEL_A], roles: ["Werewolf", "Seer", "Villager"],
      },
      filter: { outcome: "village" },
      error: false,
    });
    expect(html).toContain('href="/archive?outcome=village"');
    expect(html).toContain('href="/archive?outcome=village&amp;page=3"');
    expect(html).toContain("Showing 26–26 of 60 archived games");
  });

  it("clearly presents no-match results for active filters and inverted date ranges", async () => {
    const noMatchPath = `/archive?model=${encodeURIComponent(MODEL_A)}&outcome=aborted&from=2024-07-01&to=2024-07-31`;
    const noMatchData = await loadArchive(noMatchPath);
    expect(noMatchData.archive!.total).toBe(0);
    expect(noMatchData.archive!.games).toEqual([]);

    const noMatchHtml = await renderArchive(noMatchPath, noMatchData);
    expect(noMatchHtml).toContain("No archived games match your filters.");
    expect(noMatchHtml).toContain('href="/archive"');

    const invertedPath = "/archive?from=2024-07-20&to=2024-07-01";
    const invertedData = await loadArchive(invertedPath);
    expect(invertedData.archive!.total).toBe(0);
    const invertedHtml = await renderArchive(invertedPath, invertedData);
    expect(invertedHtml).toContain("No archived games match your filters.");
    expect(invertedHtml).toContain("The start date (2024-07-20) is after the end date (2024-07-01).");
  });

  it("clearly presents an empty archive when no filters are active", async () => {
    const emptyHtml = await renderArchive("/archive", {
      archive: { games: [], total: 0, page: 1, pageSize: 25, totalPages: 1, models: [], roles: [] },
      filter: {},
      error: false,
    });
    expect(emptyHtml).toContain("No archived games yet.");
    expect(emptyHtml).toContain('href="/"');
  });

  it("ignores invalid query parameters and batch parameters without failing", async () => {
    const data = await loadArchive("/archive?outcome=invalid&from=2024-02-30&to=bogus&page=abc&batchId=123");
    expect(data.error).toBe(false);
    expect(data.filter).toEqual({});
    expect(data.archive!.page).toBe(1);
    expect(data.archive!.total).toBeGreaterThanOrEqual(2);
  });

  it("renders an error notice instead of throwing when the archive is unavailable", async () => {
    const broken = { ...env, ARCHIVE: { batch() { throw new Error("D1 down"); }, prepare() { throw new Error("D1 down"); } } } as unknown as Env;
    const data = await loadArchive("/archive?outcome=village", broken);
    expect(data).toEqual({ archive: null, filter: { outcome: "village" }, error: true });
    const html = await renderArchive("/archive?outcome=village", data);
    expect(html).toContain("Archive unavailable.");
  });

  it("sits behind the access key gate", async () => {
    const path = "/archive?outcome=village&from=2024-07-01";
    const refused = await gate(new Request(`https://example.test${path}`), env);
    expect(refused?.status).toBe(302);
    expect(refused?.headers.get("Location")).toBe(`/login?next=${encodeURIComponent(path)}`);
  });
});
