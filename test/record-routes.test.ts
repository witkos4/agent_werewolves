import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, RouterContextProvider, StaticRouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../app/cloudflare-context";
import { loader as gameLoader } from "../app/routes/games.$gameId";
import Home, { action as homeAction, loader as homeLoader } from "../app/routes/home";
import { MODELS, PERSONAS } from "../workers/game/catalog";
import { liveRoom } from "../workers/game/routes";
import type { Game } from "../workers/game/engine";
import { roleCounts, SEAT_COUNTS } from "../workers/game/setup";
import { archiveTuning, liveTuning } from "../workers/game/runtime";
import { setLlmCall, type LlmCall } from "../workers/llm/client";
import { catalog, ok, playToFinish, startLiveGame, stubVillageWin } from "./live-helpers";

const HOUR = 3600_000;
const defaults = { ...liveTuning };
const archiveDefaults = { ...archiveTuning };
let previous: LlmCall;

beforeEach(() => {
  Object.assign(liveTuning, { firstDelayMs: HOUR, nextDelayMs: HOUR, timeoutMs: 100 });
  archiveTuning.firstDelayMs = HOUR;
  vi.mocked(fetch).mockImplementation(async () => catalog());
  previous = setLlmCall(async () => ok("invalid"));
});
afterEach(() => { Object.assign(liveTuning, defaults); Object.assign(archiveTuning, archiveDefaults); setLlmCall(previous); });

// Call the route modules directly; the React Router build is not in the test entry.
function args(path: string, params: Record<string, string> = {}, routeEnv: Env = env) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: routeEnv, ctx: {} as ExecutionContext });
  const request = new Request(`https://example.test${path}`);
  return { request, context, params, url: new URL(request.url), pattern: path } as never;
}
async function gamePage(id: string) {
  const result = await gameLoader(args(`/games/${id}`, { gameId: id }));
  return (result as unknown as { data: Awaited<ReturnType<typeof gameLoader>>["data"] }).data;
}

describe("game record page", () => {
  it("shows an archived game's record from D1 with rationale and roles", async () => {
    const { room, id } = await startLiveGame();
    await playToFinish(room, "route-rationale");
    await runDurableObjectAlarm(room); // Archive.
    const page = await gamePage(id);
    expect(page).toMatchObject({ kind: "record", archived: true, record: { id, status: "finished", winner: "Village" } });
    if (page.kind !== "record") throw new Error("expected a record");
    expect(page.record.players.every(p => p.role)).toBe(true);
    expect(page.record.timeline.some(i => i.kind === "speech" && i.rationale === "route-rationale")).toBe(true);
    expect(page.record.timeline.some(i => i.kind === "night")).toBe(true);
  });

  it("renders an unarchived terminal game from the room, marked as archiving", async () => {
    const { room, id } = await startLiveGame();
    await runDurableObjectAlarm(room); // Invalid output aborts; archive alarm is an hour out.
    expect(await gamePage(id)).toMatchObject({ kind: "record", archived: false, record: { status: "aborted", abortReason: "invalid_model_response" } });
  });

  it("gives the page a budget abort's limit and ledger, live and as a record", async () => {
    const { room, id } = await startLiveGame(undefined, 0.25);
    const live = await gamePage(id);
    expect(live).toMatchObject({ kind: "live", snapshot: { game: { spendLimitUsd: 0.25 } } });
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_game SET charged_usd = 0.249"); });
    await runDurableObjectAlarm(room);
    expect(await gamePage(id)).toMatchObject({ kind: "record", record: { abortReason: "spend_limit", spendLimitUsd: 0.25, chargedUsd: 0.249 } });
  });

  it("falls back to the room when the archive read fails", async () => {
    const { room, id } = await startLiveGame();
    await playToFinish(room, "fallback-rationale");
    await runDurableObjectAlarm(room);
    vi.spyOn(env.ARCHIVE, "batch").mockRejectedValueOnce(new Error("D1 down"));
    expect(await gamePage(id)).toMatchObject({ kind: "record", archived: true, record: { status: "finished" } });
  });

  it("keeps a running game on the live viewer with no private data", async () => {
    const { room, id } = await startLiveGame();
    await stubVillageWin(room, "running-secret-rationale");
    await runDurableObjectAlarm(room); // Seer's private investigation.
    await runDurableObjectAlarm(room); // Wolf's private kill.
    const page = await gamePage(id);
    expect(page.kind).toBe("live");
    const serialized = JSON.stringify(page);
    for (const secret of ["running-secret-rationale", "privateMoves", "investigations", "Werewolf", "Seer"]) expect(serialized).not.toContain(secret);
  });

  it("returns 404 for unknown and invalid ids", async () => {
    for (const id of ["not-a-uuid", crypto.randomUUID()]) {
      await expect(gameLoader(args(`/games/${id}`, { gameId: id }))).rejects.toMatchObject({ status: 404 });
    }
  });
});

describe("home recent games", () => {
  it("lists the newest 20 archived games, newest first", async () => {
    const base = 9_000_000_000_000;
    for (let i = 0; i < 22; i++) {
      await env.ARCHIVE.prepare(
        `INSERT INTO games (id, status, winner, model, discussion_passes, seat_count, days, turns, unknown_cost_turns,
           reserved_usd, created_at, ended_at, archived_at, engine_version, state_json)
         VALUES (?, 'finished', 'Village', 'test/model', 1, 5, 1, 1, 0, 0, 0, ?, 0, 1, '{}')`,
      ).bind(crypto.randomUUID(), base + i).run();
    }
    const { data } = await homeLoader(args("/")) as unknown as { data: { recent: { endedAt: number }[] } };
    expect(data.recent).toHaveLength(20);
    expect(data.recent.map(g => g.endedAt)).toEqual(Array.from({ length: 20 }, (_, i) => base + 21 - i));
  });

  it("offers the model catalog and personality roster on the start form", async () => {
    const { data } = await homeLoader(args("/")) as unknown as { data: { models: { id: string }[]; personas: { id: string }[] } };
    expect(data.models.map(m => m.id)).toEqual(MODELS.map(m => m.id));
    expect(data.personas.map(p => p.id)).toEqual(PERSONAS.map(p => p.id));
  });

  it("starts a game with the form's seats and pool, and re-renders an invalid setup with its choices", async () => {
    const post = (fields: [string, string][]) => {
      const form = new FormData();
      for (const [k, v] of fields) form.append(k, v);
      const request = new Request("https://example.test/?index", { method: "POST", body: form });
      const context = new RouterContextProvider();
      context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
      return homeAction({ request, context, params: {}, url: new URL(request.url), pattern: "/" } as never);
    };
    const id = crypto.randomUUID();
    // Seats 1–7 cycle through the first five models; seat 8 draws from the pool.
    const chosen = Array.from({ length: 7 }, (_, i) => MODELS[i % 5].id);
    const seats: [string, string][] = [...chosen, "random"].flatMap((model, i) => [["seatModel", model], ["seatPersona", i === 0 ? "analyst" : "random"]] as [string, string][]);
    const redirect = await post([["requestId", id], ["discussionPasses", "2"], ...seats, ["pool", MODELS[5].id]]).catch(r => r as Response);
    expect((redirect as Response).headers.get("Location")).toBe(`/games/${id}`);
    const game = await runInDurableObject(liveRoom(env, id), (_i, st) => JSON.parse(st.storage.sql.exec<{ state: string }>("SELECT state FROM live_game").one().state) as Game);
    expect(game.discussionPasses).toBe(2);
    expect(game.players.map(p => p.model)).toEqual([...chosen, MODELS[5].id]);
    expect(game.players[0].persona).toBe("analyst");

    const bad = await post([["requestId", crypto.randomUUID()], ["discussionPasses", "1"], ...seats]) as unknown as { data: { error: string; setup: { pool: string[] } }; init: { status: number } };
    expect(bad.init.status).toBe(400);
    expect(bad.data.error).toBe("Pick at least one model for the pool.");
    expect(bad.data.setup.pool).toEqual([]);

    // The spend limit is forwarded, and a rejected one comes back as typed.
    const limited = crypto.randomUUID();
    await post([["requestId", limited], ["discussionPasses", "1"], ...seats, ["pool", MODELS[5].id], ["spendLimitUsd", "0.30"]]).catch(r => r as Response);
    expect((await runInDurableObject(liveRoom(env, limited), (_i, st) => JSON.parse(st.storage.sql.exec<{ state: string }>("SELECT state FROM live_game").one().state) as Game)).spendLimitUsd).toBe(0.3);
    for (const typed of ["9", "abc"]) {
      const over = await post([["requestId", crypto.randomUUID()], ["discussionPasses", "1"], ...seats, ["pool", MODELS[5].id], ["spendLimitUsd", typed]]) as unknown as { data: { error: string; spendLimit: string }; init: { status: number } };
      expect(over.init.status).toBe(400);
      expect(over.data).toMatchObject({ error: expect.stringContaining("spend limit"), spendLimit: typed });
    }
  });

  it("gives the start form the table-size bounds, limit bounds and estimate inputs", async () => {
    const { data } = await homeLoader(args("/")) as unknown as {
      data: {
        tableSize: { default: number; min: number; max: number };
        spendLimit: { default: number; min: number; max: number };
        estimateInputs: { models: unknown[]; shapes: unknown[] };
      };
    };
    expect(data.tableSize).toEqual({ default: 8, min: 5, max: 9 });
    expect(data.spendLimit).toEqual({ default: 1, min: 0.05, max: 5 });
    expect(data.estimateInputs).toMatchObject({ models: expect.any(Array), shapes: expect.any(Array) });
  });

  it("renders table size selection (5–9 seats, default 8) with composition summary and echoed seat counts", async () => {
    const loaderData = (await homeLoader(args("/")) as unknown as { data: Awaited<ReturnType<typeof homeLoader>>["data"] }).data;
    const renderHome = async (actionData?: Awaited<ReturnType<typeof homeAction>>["data"]) => {
      const routes = [{ path: "/", Component: () => createElement(Home, { loaderData, actionData } as never) }];
      const handler = createStaticHandler(routes);
      const context = await handler.query(new Request("https://example.test/"));
      if (context instanceof Response) throw new Error(`Unexpected response: ${context.status}`);
      const router = createStaticRouter(handler.dataRoutes, context);
      return renderToStaticMarkup(createElement(StaticRouterProvider, { router, context }));
    };

    const defaultHtml = await renderHome();
    expect(defaultHtml).toContain('name="seatCount"');
    for (const count of SEAT_COUNTS) expect(defaultHtml).toContain(`${count} seats`);
    expect(defaultHtml).toContain("Fixed composition: 2 Werewolves, 1 Seer, 5 Villagers.");
    expect(defaultHtml).toContain("Seat 8 model");
    expect(defaultHtml).not.toContain("Seat 9 model");

    const fiveSeatErrorHtml = await renderHome({
      error: "Pick at least one model for the pool.",
      requestId: crypto.randomUUID(),
      seatCount: "5",
      setup: { seats: Array.from({ length: 5 }, () => ({ model: "random", persona: "random" })), pool: [] },
      discussionPasses: 1,
      spendLimit: "1.00",
    });
    expect(fiveSeatErrorHtml).toContain("Fixed composition: 1 Werewolf, 1 Seer, 3 Villagers.");
    expect(fiveSeatErrorHtml).toContain("Seat 5 model");
    expect(fiveSeatErrorHtml).not.toContain("Seat 6 model");

    const nineSeatErrorHtml = await renderHome({
      error: "Pick at least one model for the pool.",
      requestId: crypto.randomUUID(),
      seatCount: "9",
      setup: { seats: Array.from({ length: 9 }, () => ({ model: "random", persona: "random" })), pool: [] },
      discussionPasses: 1,
      spendLimit: "1.00",
    });
    expect(nineSeatErrorHtml).toContain("Fixed composition: 3 Werewolves, 1 Seer, 5 Villagers.");
    expect(nineSeatErrorHtml).toContain("Seat 9 model");
  });

  it("starts games from the home form for every supported seat count 5–9 and rejects invalid counts", async () => {
    const post = (fields: [string, string][]) => {
      const form = new FormData();
      for (const [k, v] of fields) form.append(k, v);
      const request = new Request("https://example.test/?index", { method: "POST", body: form });
      const context = new RouterContextProvider();
      context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
      return homeAction({ request, context, params: {}, url: new URL(request.url), pattern: "/" } as never);
    };

    for (const count of SEAT_COUNTS) {
      const id = crypto.randomUUID();
      const chosenModels = Array.from({ length: count - 1 }, (_, i) => MODELS[i % 5].id);
      const seats: [string, string][] = [...chosenModels, "random"].flatMap((model, i) => [
        ["seatModel", model],
        ["seatPersona", i === 0 ? "analyst" : "random"],
      ] as [string, string][]);
      const redirect = await post([["requestId", id], ["seatCount", String(count)], ["discussionPasses", "1"], ...seats, ["pool", MODELS[5].id]]).catch(r => r as Response);
      expect((redirect as Response).headers.get("Location")).toBe(`/games/${id}`);
      const game = await runInDurableObject(liveRoom(env, id), (_i, st) => JSON.parse(st.storage.sql.exec<{ state: string }>("SELECT state FROM live_game").one().state) as Game);
      const expected = roleCounts(count);
      expect(game.players).toHaveLength(count);
      expect(game.players.filter(p => p.role === "Werewolf")).toHaveLength(expected.wolves);
      expect(game.players.filter(p => p.role === "Seer")).toHaveLength(expected.seer);
      expect(game.players.filter(p => p.role === "Villager")).toHaveLength(expected.villagers);
      expect(game.players.map(p => p.model)).toEqual([...chosenModels, MODELS[5].id]);
      expect(game.players[0].persona).toBe("analyst");
      expect(new Set(game.players.map(p => p.persona)).size).toBe(count);
    }

    // No-JS submission: changing seatCount without resizing the 8 rendered seat rows still honors seatCount.
    const noJsId = crypto.randomUUID();
    const eightSeats: [string, string][] = Array.from({ length: 8 }, (_, i) => [
      ["seatModel", MODELS[i % MODELS.length].id],
      ["seatPersona", PERSONAS[i].id],
    ] as [string, string][]).flat();
    const noJsRedirect = await post([["requestId", noJsId], ["seatCount", "5"], ["discussionPasses", "1"], ...eightSeats, ["pool", MODELS[0].id]]).catch(r => r as Response);
    expect((noJsRedirect as Response).headers.get("Location")).toBe(`/games/${noJsId}`);
    const noJsGame = await runInDurableObject(liveRoom(env, noJsId), (_i, st) => JSON.parse(st.storage.sql.exec<{ state: string }>("SELECT state FROM live_game").one().state) as Game);
    expect(noJsGame.players).toHaveLength(5);
    expect(noJsGame.players.map(p => p.persona)).toEqual(PERSONAS.slice(0, 5).map(p => p.id));

    // Invalid seat counts are rejected server-side without creating a game.
    for (const invalid of ["0", "4", "10", "-1", "6.5", "abc", ""]) {
      const id = crypto.randomUUID();
      const rejected = await post([["requestId", id], ["seatCount", invalid], ["discussionPasses", "1"], ...eightSeats, ["pool", MODELS[0].id]]) as unknown as {
        data: { error: string };
        init: { status: number };
      };
      expect(rejected.init.status).toBe(400);
      expect(rejected.data.error).toBe("Configure between 5 and 9 seats.");
      expect(await liveRoom(env, id).getLiveSnapshot()).toBeNull();
    }

    // Omitting seatCount with an out-of-range number of seat rows is also rejected.
    for (const badRowCount of [4, 10]) {
      const id = crypto.randomUUID();
      const rows: [string, string][] = Array.from({ length: badRowCount }, () => [
        ["seatModel", MODELS[0].id],
        ["seatPersona", "random"],
      ] as [string, string][]).flat();
      const rejected = await post([["requestId", id], ["discussionPasses", "1"], ...rows, ["pool", MODELS[0].id]]) as unknown as {
        data: { error: string };
        init: { status: number };
      };
      expect(rejected.init.status).toBe(400);
      expect(rejected.data.error).toBe("Configure between 5 and 9 seats.");
      expect(await liveRoom(env, id).getLiveSnapshot()).toBeNull();
    }
  });

  it("shows each seat's model and personality while live and in the record, without personality prompts", async () => {
    const setup = { seats: PERSONAS.slice(0, 8).map((p, i) => ({ model: MODELS[i % MODELS.length].id, persona: p.id })), pool: [] };
    const { room, id } = await startLiveGame(setup);
    const live = await gamePage(id);
    expect(live.kind).toBe("live");
    if (live.kind !== "live") return;
    expect(live.snapshot.game.players.map(p => [p.model, p.persona])).toEqual(setup.seats.map((s, i) => [s.model, PERSONAS[i].name]));
    expect(JSON.stringify(live)).not.toContain(PERSONAS[0].prompt);
    await playToFinish(room, "seat-rationale");
    await runDurableObjectAlarm(room);
    const page = await gamePage(id);
    expect(page).toMatchObject({ kind: "record", archived: true, record: { model: "mixed" } });
    if (page.kind !== "record") return;
    expect(page.record.players.map(p => [p.model, p.persona])).toEqual(setup.seats.map(s => [s.model, s.persona]));
  });

  it("still renders the start form when the archive is unavailable", async () => {
    const broken = { ...env, ARCHIVE: { prepare() { throw new Error("D1 down"); } } } as unknown as Env;
    const { data } = await homeLoader(args("/", {}, broken)) as unknown as { data: { recent: unknown; requestId: string; estimateInputs: unknown } };
    expect(data.recent).toBeNull();
    expect(data.estimateInputs).toBeNull();
    expect(data.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
