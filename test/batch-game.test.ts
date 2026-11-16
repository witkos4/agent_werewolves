import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readArchivedRecord } from "../workers/game/archive";
import { MODELS, PERSONAS } from "../workers/game/catalog";
import { handleGameRequest, liveRoom } from "../workers/game/routes";
import { archiveTuning, liveTuning } from "../workers/game/runtime";
import type { GameSetup } from "../workers/game/setup";
import { setLlmCall, type LlmCall } from "../workers/llm/client";
import { catalog, ok, playToFinish, readGame } from "./live-helpers";

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

const roles = ["Villager", "Werewolf", "Villager", "Seer", "Villager", "Villager", "Werewolf", "Villager"] as const;
const forced: GameSetup = { seats: roles.map((role, i) => ({ model: MODELS[i % 3].id, persona: PERSONAS[i].id, role })), pool: [] };

async function startBatchGame(batchId: string, setup: GameSetup | undefined = forced, limit = 0.5) {
  const id = crypto.randomUUID();
  const room = liveRoom(env, id);
  expect(await room.startLive(id, 1, setup, limit, batchId)).toEqual({ ok: true });
  return { room, id };
}

describe("games started by a batch", () => {
  it("stores the batch and forced roles, and makes the start idempotent including the batch", async () => {
    const batchId = crypto.randomUUID();
    const { room, id } = await startBatchGame(batchId);
    const game = await readGame(room);
    expect(game.batchId).toBe(batchId);
    expect(game.players.map(p => p.role)).toEqual(roles);
    expect((await room.getLiveSnapshot())!.game.batchId).toBe(batchId);
    expect(await room.startLive(id, 1, forced, 0.5, batchId)).toEqual({ ok: true });
    expect(await room.startLive(id, 1, forced, 0.5, crypto.randomUUID())).toMatchObject({ ok: false, status: 409 });
    expect(await room.startLive(id, 1, forced, 0.4, batchId)).toMatchObject({ ok: false, status: 409 });
    // Outside a batch, forced roles are refused before the room is consulted.
    expect(await room.startLive(id, 1, forced, 0.5)).toMatchObject({ ok: false, status: 400 });
    const plain = await startBatchGame(batchId, undefined);
    expect(await plain.room.startLive(plain.id, 1, undefined, 0.5)).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses forced roles outside a batch, in the room and over HTTP", async () => {
    const id = crypto.randomUUID();
    expect(await liveRoom(env, id).startLive(id, 1, forced)).toMatchObject({ ok: false, status: 400 });
    const response = await handleGameRequest(new Request("https://example.test/api/games/start", {
      method: "POST", body: JSON.stringify({ requestId: id, discussionPasses: 1, setup: forced }),
    }), env);
    expect(response?.status).toBe(400);
    expect(await liveRoom(env, id).getLiveSnapshot()).toBeNull();
  });

  it("reports status and the settled ledger to its batch", async () => {
    const id = crypto.randomUUID();
    expect(await liveRoom(env, id).getBatchView()).toBeNull();
    const { room } = await startBatchGame(crypto.randomUUID(), undefined);
    expect(await room.getBatchView()).toEqual({ status: "running", chargedUsd: 0, winner: null, abortReason: null });
    await playToFinish(room, "r");
    const view = (await room.getBatchView())!;
    const charged = await runInDurableObject(room, (_i, s) => s.storage.sql.exec<{ charged_usd: number }>("SELECT charged_usd FROM live_game").one().charged_usd);
    expect(view).toEqual({ status: "finished", chargedUsd: charged, winner: "Village", abortReason: null });
    expect(view.chargedUsd).toBeGreaterThan(0);
  });

  it("cancels a running game, archives it with its batch, and ignores a second cancel", async () => {
    const batchId = crypto.randomUUID();
    const { room, id } = await startBatchGame(batchId);
    await room.cancelLive();
    expect(await room.getBatchView()).toMatchObject({ status: "aborted", abortReason: "cancelled" });
    const events = await runInDurableObject(room, (_i, s) => s.storage.sql.exec<{ type: string }>("SELECT type FROM events ORDER BY seq").toArray().map(e => e.type));
    await room.cancelLive();
    expect(await runInDurableObject(room, (_i, s) => s.storage.sql.exec("SELECT type FROM events").toArray().length)).toBe(events.length);
    expect(events.at(-1)).toBe("aborted");
    expect(await runDurableObjectAlarm(room)).toBe(true); // The archive attempt.
    const record = (await readArchivedRecord(env.ARCHIVE, id))!;
    expect(record).toMatchObject({ status: "aborted", abortReason: "cancelled", batchId });
    const row = await env.ARCHIVE.prepare("SELECT batch_id FROM games WHERE id = ?").bind(id).first<{ batch_id: string }>();
    expect(row!.batch_id).toBe(batchId);
  });

  it("keeps a finished game finished when cancelled afterwards", async () => {
    const { room } = await startBatchGame(crypto.randomUUID(), undefined);
    await playToFinish(room, "r");
    await room.cancelLive();
    expect(await room.getBatchView()).toMatchObject({ status: "finished", winner: "Village" });
  });

  it("drops a reply that arrives after the game was cancelled, keeping its charge", async () => {
    const { room } = await startBatchGame(crypto.randomUUID());
    // Plain flags, not shared promises: a promise resolved inside the room would
    // continue the test in the room's I/O context.
    let entered = false, released = false;
    setLlmCall(async request => {
      entered = true;
      while (!released) await new Promise(resolve => setTimeout(resolve, 5));
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      return ok(JSON.stringify({ target: view.allowedTargets[0], rationale: "late" }));
    });
    const turn = runInDurableObject(room, instance => instance.alarm());
    await vi.waitFor(() => expect(entered).toBe(true));
    await room.cancelLive();
    released = true;
    await turn;
    const game = await readGame(room);
    expect(game).toMatchObject({ status: "aborted", abortReason: "cancelled", turn: 1 });
    const stored = await runInDurableObject(room, (_i, s) => ({
      turn: s.storage.sql.exec<{ status: string; attempts: number }>("SELECT status, attempts FROM live_turns").one(),
      ledger: s.storage.sql.exec<{ reserved_usd: number; charged_usd: number }>("SELECT reserved_usd, charged_usd FROM live_game").one(),
    }));
    expect(stored.turn).toEqual({ status: "pending", attempts: 1 });
    expect(stored.ledger.charged_usd).toBeCloseTo(stored.ledger.reserved_usd);
    expect(stored.ledger.charged_usd).toBeGreaterThan(0);
  });
});
