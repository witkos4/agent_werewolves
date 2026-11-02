import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameRoom } from "../workers/game-room";
import { listRecentGames, readArchivedRecord, writeArchive } from "../workers/game/archive";
import type { Game } from "../workers/game/engine";
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
    expect(await counts(id)).toEqual({ games: 1, players: 5, moves: fromRoom.record.turns });
    const moves = await env.ARCHIVE.prepare("SELECT rationale, cost_usd, latency_ms, attempts FROM game_moves WHERE game_id = ?").bind(id).all();
    expect(moves.results.every(m => m.rationale === "private-archive-rationale" && m.cost_usd === 0.0001 && m.latency_ms === 5 && m.attempts === 1)).toBe(true);
    expect((await listRecentGames(env.ARCHIVE)).find(g => g.id === id)).toMatchObject({ status: "finished", winner: "Village" });
    // The public snapshot and socket events stay free of private reasoning even after archiving.
    const publicData = JSON.stringify(await room.getLiveSnapshot()) + JSON.stringify(await runInDurableObject(room, (_i, s) => s.storage.sql.exec("SELECT payload FROM events").toArray()));
    for (const secret of ["private-archive-rationale", "privateMoves", "investigations"]) expect(publicData).not.toContain(secret);
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
    expect(await counts(id)).toEqual({ games: 1, players: 5, moves: record.turns });
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
