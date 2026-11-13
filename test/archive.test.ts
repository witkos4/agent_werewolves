import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameRoom } from "../workers/game-room";
import { listRecentGames, readArchivedRecord, writeArchive } from "../workers/game/archive";
import type { Game } from "../workers/game/engine";
import { MODELS } from "../workers/game/catalog";
import { DEFAULT_SETUP } from "../workers/game/setup";
import { archiveTuning, liveTuning } from "../workers/game/runtime";
import { setLlmCall, type LlmCall } from "../workers/llm/client";
import { catalog, ok, playToFinish as play, startLiveGame as start } from "./live-helpers";

const defaults = { ...liveTuning };
const archiveDefaults = { ...archiveTuning };
const HOUR = 3600_000;
let previous: LlmCall;

beforeEach(() => {
  Object.assign(liveTuning, { firstDelayMs: HOUR, nextDelayMs: HOUR, timeoutMs: 100 });
  // Alarms that are due fire on their own; keep archiving under test control.
  archiveTuning.firstDelayMs = HOUR;
  vi.mocked(fetch).mockImplementation(async () => catalog());
  previous = setLlmCall(async () => ok("invalid"));
});
afterEach(() => { Object.assign(liveTuning, defaults); Object.assign(archiveTuning, archiveDefaults); setLlmCall(previous); });

const playToFinish = (room: DurableObjectStub<GameRoom>) => play(room, "private-archive-rationale");

function state(room: DurableObjectStub<GameRoom>) {
  return runInDurableObject(room, async (_i, s) => ({
    game: JSON.parse(s.storage.sql.exec<{ state: string }>("SELECT state FROM live_game").one().state) as Game,
    archive: s.storage.sql.exec<{ status: string; attempts: number; last_error: string | null }>("SELECT * FROM live_archive").toArray()[0] ?? null,
    alarm: await s.storage.getAlarm(),
  }));
}

async function counts(id: string) {
  const row = await env.ARCHIVE.prepare(
    `SELECT (SELECT COUNT(*) FROM games WHERE id = ?1) AS games, (SELECT COUNT(*) FROM game_players WHERE game_id = ?1) AS players,
            (SELECT COUNT(*) FROM game_moves WHERE game_id = ?1) AS moves`,
  ).bind(id).first<{ games: number; players: number; moves: number }>();
  return row!;
}

describe("archive outbox", () => {
  it("archives a finished game once, and D1 rebuilds the same record the room shows", async () => {
    const { room, id } = await start();
    expect(await room.getRecord()).toBeNull(); // Never while running.
    await playToFinish(room);
    const before = await state(room);
    expect(before.archive).toMatchObject({ status: "pending" });
    expect(before.alarm).not.toBeNull();
    expect(await room.getRecord()).toMatchObject({ archived: false });

    expect(await runDurableObjectAlarm(room)).toBe(true);
    const after = await state(room);
    expect(after.archive).toMatchObject({ status: "archived" });
    expect(after.alarm).toBeNull();

    const fromRoom = (await room.getRecord())!;
    expect(fromRoom.archived).toBe(true);
    expect(await readArchivedRecord(env.ARCHIVE, id)).toEqual(fromRoom.record);
    expect(await counts(id)).toEqual({ games: 1, players: 8, moves: fromRoom.record.turns });
    const moves = await env.ARCHIVE.prepare("SELECT rationale, cost_usd, latency_ms, attempts FROM game_moves WHERE game_id = ?").bind(id).all();
    expect(moves.results.every(m => m.rationale === "private-archive-rationale" && m.cost_usd === 0.0001 && m.latency_ms === 5 && m.attempts === 1)).toBe(true);
    // Other test files archive into the same D1 concurrently, so look past the 20 most recent.
    expect((await listRecentGames(env.ARCHIVE, 1000)).find(g => g.id === id)).toMatchObject({ status: "finished", winner: "Village" });
    // The public snapshot and socket events stay free of private reasoning even after archiving.
    const publicData = JSON.stringify(await room.getLiveSnapshot()) + JSON.stringify(await runInDurableObject(room, (_i, s) => s.storage.sql.exec("SELECT payload FROM events").toArray()));
    for (const secret of ["private-archive-rationale", "privateMoves", "investigations"]) expect(publicData).not.toContain(secret);
  });

  it("stores each seat's death, and migration 0003's backfill rebuilds the same values", async () => {
    const { room, id } = await start();
    await playToFinish(room);
    await runDurableObjectAlarm(room);
    const { record } = (await room.getRecord())!;
    const read = () => env.ARCHIVE.prepare("SELECT seat, survived, died_day, died_by FROM game_players WHERE game_id = ? ORDER BY seat").bind(id)
      .all<{ seat: string; survived: number; died_day: number | null; died_by: string | null }>().then(r => r.results);
    const stored = await read();
    expect(stored).toEqual(record.players.map(p => ({ seat: p.seat, survived: p.survived ? 1 : 0, died_day: p.diedDay, died_by: p.diedBy })).sort((a, b) => a.seat.localeCompare(b.seat)));
    expect(stored.filter(p => p.died_by === "village").length).toBeGreaterThan(0);
    expect(stored.filter(p => p.died_by === "night").length).toBeGreaterThan(0);

    // As if archived before 0003: clear the columns, then run the migration's backfill UPDATE.
    await env.ARCHIVE.prepare("UPDATE game_players SET died_day = NULL, died_by = NULL WHERE game_id = ?").bind(id).run();
    const migration = env.TEST_MIGRATIONS!.find(m => m.name.startsWith("0003_"))!;
    const backfill = migration.queries.find(q => q.includes("UPDATE game_players SET"))!;
    await env.ARCHIVE.prepare(backfill).run();
    expect(await read()).toEqual(stored);
  });

  it("archives an aborted game with its reason", async () => {
    const { room, id } = await start();
    await runDurableObjectAlarm(room); // Invalid output aborts at turn 1.
    expect((await state(room)).archive).toMatchObject({ status: "pending" });
    await runDurableObjectAlarm(room);
    const record = await readArchivedRecord(env.ARCHIVE, id);
    expect(record).toMatchObject({ status: "aborted", abortReason: "invalid_model_response", winner: null, turns: 0 });
    expect(record!.players.every(p => p.role)).toBe(true);
  });

  it("retries a failed D1 write with backoff and keeps the game until it lands", async () => {
    const { room, id } = await start();
    await runDurableObjectAlarm(room);
    const batch = vi.spyOn(env.ARCHIVE, "batch").mockRejectedValueOnce(new Error("D1_ERROR: unavailable"));
    const before = Date.now();
    await runDurableObjectAlarm(room);
    expect(batch).toHaveBeenCalledTimes(1);
    const failed = await state(room);
    expect(failed.archive).toMatchObject({ status: "pending", attempts: 1, last_error: expect.stringContaining("unavailable") });
    expect(failed.alarm).toBeGreaterThanOrEqual(before + archiveTuning.retryBaseMs);
    expect(await counts(id)).toEqual({ games: 0, players: 0, moves: 0 });
    expect(await room.getRecord()).toMatchObject({ archived: false, record: { status: "aborted" } });

    await runDurableObjectAlarm(room);
    expect((await state(room)).archive).toMatchObject({ status: "archived" });
    expect((await counts(id)).games).toBe(1);
  });

  it("caps the retry backoff", async () => {
    const { room } = await start();
    await runDurableObjectAlarm(room);
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_archive SET attempts = 20"); });
    vi.spyOn(env.ARCHIVE, "batch").mockRejectedValueOnce(new Error("down"));
    const before = Date.now();
    await runDurableObjectAlarm(room);
    const { alarm } = await state(room);
    expect(alarm! - before).toBeGreaterThanOrEqual(archiveTuning.retryMaxMs);
    expect(alarm! - before).toBeLessThan(archiveTuning.retryMaxMs + 5_000);
  });

  it("re-runs harmlessly when D1 committed but the room crashed before marking", async () => {
    const { room, id } = await start();
    await playToFinish(room);
    const { record } = (await room.getRecord())!;
    await writeArchive(env.ARCHIVE, record, JSON.stringify((await state(room)).game), Date.now());
    await evictDurableObject(room);
    await runDurableObjectAlarm(room);
    expect((await state(room)).archive).toMatchObject({ status: "archived" });
    expect(await counts(id)).toEqual({ games: 1, players: 8, moves: record.turns });
  });

  it("archives after an eviction between the terminal state and the write", async () => {
    const { room, id } = await start();
    await playToFinish(room);
    await evictDurableObject(room);
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect((await counts(id)).games).toBe(1);
  });

  it("lets the platform retry when the terminal alarm write fails, then archives", async () => {
    const { room, id } = await start();
    await runInDurableObject(room, (_i, s) => {
      const setAlarm = s.storage.setAlarm.bind(s.storage);
      vi.spyOn(s.storage, "setAlarm").mockImplementationOnce(setAlarm).mockRejectedValueOnce(new Error("alarm_unavailable"));
    });
    await expect(runDurableObjectAlarm(room)).rejects.toThrow("alarm_unavailable");
    expect((await state(room)).archive).toMatchObject({ status: "pending" });
    await runInDurableObject(room, instance => instance.alarm());
    expect((await state(room)).archive).toMatchObject({ status: "archived" });
    expect((await counts(id)).games).toBe(1);
  });

  it("re-arms a pending archive whose alarm was lost when the game ended", async () => {
    const { room, id } = await start();
    await playToFinish(room);
    await runInDurableObject(room, async (_i, s) => { await s.storage.deleteAlarm(); });
    expect((await state(room)).alarm).toBeNull();
    await room.getRecord();
    expect((await state(room)).alarm).not.toBeNull();
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect((await state(room)).archive).toMatchObject({ status: "archived" });
    expect((await counts(id)).games).toBe(1);
  });

  it("still serves the room and its record when re-arming the archive fails", async () => {
    const { room, id } = await start();
    await playToFinish(room);
    await runInDurableObject(room, async (_i, s) => { await s.storage.deleteAlarm(); });
    await runInDurableObject(room, (_i, s) => {
      vi.spyOn(s.storage, "setAlarm").mockRejectedValueOnce(new Error("alarm_unavailable"));
    });
    expect(await room.getLiveSnapshot()).toMatchObject({ game: { id, status: "finished" } });
    expect(await room.getRecord()).toMatchObject({ archived: false, record: { status: "finished" } });
    expect((await state(room)).alarm).not.toBeNull();
  });

  it("archives each seat's model and personality, and a mixed or shared summary model", async () => {
    const seatsOf = (id: string) => env.ARCHIVE.prepare("SELECT seat, model, persona FROM game_players WHERE game_id = ? ORDER BY seat").bind(id).all<{ seat: string; model: string; persona: string | null }>();
    const personas = ["analyst", "accuser", "loyalist", "diplomat", "contrarian", "logician", "storyteller", "instigator"];
    const mixed = { seats: personas.map((persona, i) => ({ model: MODELS[i % MODELS.length].id, persona })), pool: [] };
    const { room, id } = await start(mixed);
    await playToFinish(room);
    await runDurableObjectAlarm(room);
    expect((await seatsOf(id)).results).toEqual(mixed.seats.map((s, i) => ({ seat: `p${i + 1}`, model: s.model, persona: s.persona })));
    expect(await env.ARCHIVE.prepare("SELECT model FROM games WHERE id = ?").bind(id).first("model")).toBe("mixed");
    expect((await readArchivedRecord(env.ARCHIVE, id))?.setup).toEqual(mixed);

    const shared = await start({ seats: DEFAULT_SETUP.seats.map(s => ({ ...s, model: MODELS[3].id })), pool: [] });
    await playToFinish(shared.room);
    await runDurableObjectAlarm(shared.room);
    expect(await env.ARCHIVE.prepare("SELECT model FROM games WHERE id = ?").bind(shared.id).first("model")).toBe(MODELS[3].id);
    expect((await seatsOf(shared.id)).results.every(r => r.persona !== null)).toBe(true);
  });

  it("archives a version-1 game with the game model per seat and no personality", async () => {
    const { room, id } = await start();
    await runInDurableObject(room, (_i, s) => {
      const game = JSON.parse(s.storage.sql.exec<{ state: string }>("SELECT state FROM live_game").one().state) as Game;
      game.version = 1;
      game.model = "google/gemini-3.1-flash-lite";
      delete game.setup;
      for (const p of game.players) { delete p.model; delete p.persona; }
      s.storage.sql.exec("UPDATE live_game SET state = ?", JSON.stringify(game));
    });
    await playToFinish(room);
    await runDurableObjectAlarm(room);
    const rows = await env.ARCHIVE.prepare("SELECT model, persona FROM game_players WHERE game_id = ?").bind(id).all();
    expect(rows.results).toEqual(Array.from({ length: 8 }, () => ({ model: "google/gemini-3.1-flash-lite", persona: null })));
  });

  it("queues a legacy terminal room that predates archiving when it is next opened", async () => {
    const { room, id } = await start();
    await runDurableObjectAlarm(room); // Aborts.
    // Reproduce a room that ended before this change: no outbox row, no alarm.
    await runInDurableObject(room, async (_i, s) => {
      s.storage.sql.exec("DELETE FROM live_archive");
      await s.storage.deleteAlarm();
    });
    expect(await runDurableObjectAlarm(room)).toBe(false);
    await room.getLiveSnapshot();
    expect((await state(room)).archive).toMatchObject({ status: "pending" });
    expect(await runDurableObjectAlarm(room)).toBe(true);
    expect((await counts(id)).games).toBe(1);
  });
});
