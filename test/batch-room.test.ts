import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { batchTuning, type BatchRoom, type BatchSnapshot } from "../workers/batch-room";
import { parseBatchRequest, type BatchRequest } from "../workers/batch/plan";
import { batchRoom } from "../workers/batch/routes";
import { readBatch } from "../workers/game/archive";
import { MODELS } from "../workers/game/catalog";
import { effectiveLimit, type Game } from "../workers/game/engine";
import { liveRoom } from "../workers/game/routes";
import { archiveTuning, liveTuning } from "../workers/game/runtime";
import { setLlmCall, type LlmCall } from "../workers/llm/client";
import { catalog, readGame } from "./live-helpers";

const HOUR = 3600_000;
const defaults = { live: { ...liveTuning }, archive: { ...archiveTuning }, batch: { ...batchTuning } };
let previous: LlmCall;
/** Wolves per game ID, for the stub to play a village win in any batch game. */
const wolves = new Map<string, string[]>();
let reportedCost: number | null = 0.0001;

beforeEach(() => {
  Object.assign(liveTuning, { firstDelayMs: HOUR, nextDelayMs: HOUR, timeoutMs: 100 });
  archiveTuning.firstDelayMs = HOUR;
  // Due alarms fire on their own; keep every supervisor pass under test control.
  Object.assign(batchTuning, { firstPassDelayMs: HOUR, pollMs: HOUR, startRetryMs: 0 });
  vi.mocked(fetch).mockImplementation(async () => catalog());
  reportedCost = 0.0001;
  previous = setLlmCall(async request => {
    const body = JSON.parse(request.body);
    const view = JSON.parse(body.messages[1].content);
    const known = wolves.get(body.user) ?? [];
    const target = view.actor.role !== "Werewolf" ? known.find(id => view.allowedTargets.includes(id)) ?? view.allowedTargets[0]
      : view.allowedTargets.filter((id: string) => !known.includes(id)).at(-1);
    return { ok: true, text: JSON.stringify(view.phase === "discuss" ? { text: "Hm.", rationale: "r" } : { target, rationale: "r" }),
      cost: reportedCost, cacheHit: false, generationId: "g", latencyMs: 1 };
  });
});
afterEach(() => {
  Object.assign(liveTuning, defaults.live); Object.assign(archiveTuning, defaults.archive); Object.assign(batchTuning, defaults.batch);
  setLlmCall(previous);
});

function request(value: Record<string, unknown>): BatchRequest {
  const parsed = parseBatchRequest({ discussionPasses: 1, ...value });
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

async function startBatch(value: Record<string, unknown>) {
  const id = crypto.randomUUID();
  const room = batchRoom(env, id);
  expect(await room.start(id, request(value))).toEqual({ ok: true });
  return { room, id };
}

/** One supervisor pass, then the bound and the concurrency cap are checked. */
async function pass(room: DurableObjectStub<BatchRoom>): Promise<BatchSnapshot> {
  await runInDurableObject(room, instance => instance.alarm());
  const snap = (await room.snapshot())!;
  expect(snap.settledUsd + snap.escrowUsd).toBeLessThanOrEqual(snap.request.spendLimitUsd + 1e-9);
  expect(snap.slots.filter(s => s.status === "starting" || s.status === "running").length).toBeLessThanOrEqual(batchTuning.concurrency);
  for (const s of snap.slots) if (s.limitUsd !== null) expect(s.chargedUsd).toBeLessThanOrEqual(s.limitUsd + 1e-9);
  return snap;
}

/** Plays every running slot's game to its end with the stub. */
async function playRunning(snap: BatchSnapshot) {
  for (const slot of snap.slots.filter(s => s.status === "running")) {
    const room = liveRoom(env, slot.gameId);
    const game = await readGame(room);
    wolves.set(game.id, game.players.filter(p => p.role === "Werewolf").map(p => p.id));
    for (let i = 0; i < 120 && (await readGame(room)).status === "running"; i++) await runDurableObjectAlarm(room);
  }
}

/** Passes and plays until the batch ends. */
async function runBatch(room: DurableObjectStub<BatchRoom>) {
  for (let i = 0; i < 30; i++) {
    const snap = await pass(room);
    if (snap.status === "done" || snap.status === "cancelled") return snap;
    await playRunning(snap);
  }
  throw new Error("batch did not end");
}

describe("batch supervisor", () => {
  it("runs at most three games at once, refills as games end, and archives every game under the batch", async () => {
    const { room, id } = await startBatch({ mode: "rotation", pool: MODELS.slice(0, 2).map(m => m.id), gameCount: 4, spendLimitUsd: 4, gameLimitUsd: 1 });
    const first = await pass(room);
    expect(first.slots.map(s => s.status)).toEqual(["running", "running", "running", "pending"]);
    expect(first.slots.slice(0, 3).map(s => s.limitUsd)).toEqual([1, 1, 1]);
    expect(first.escrowUsd).toBe(3);
    const games = await Promise.all(first.slots.slice(0, 3).map(s => readGame(liveRoom(env, s.gameId))));
    expect(games.every(g => g.batchId === id && effectiveLimit(g) === 1)).toBe(true);

    const end = await runBatch(room);
    expect(end.status).toBe("done");
    expect(end.slots.every(s => s.status === "finished" && s.winner === "Village" && s.escrowUsd === 0)).toBe(true);
    expect(end.escrowUsd).toBe(0);
    for (const slot of end.slots) {
      expect(slot.chargedUsd).toBeGreaterThan(0);
      await runDurableObjectAlarm(liveRoom(env, slot.gameId)); // The archive attempt.
    }
    const archived = await env.ARCHIVE.prepare("SELECT COUNT(*) AS n FROM games WHERE batch_id = ?").bind(id).first<{ n: number }>();
    expect(archived!.n).toBe(4);
    // Rotation forced the roles the batch planned.
    const played = await readGame(liveRoom(env, end.slots[0].gameId));
    expect(played.setup!.seats.map(s => s.role)).toEqual(played.players.map(p => p.role));

    // The D1 copy matches the final snapshot; the alarm is cleared once it is current.
    const row = (await readBatch(env.ARCHIVE, id))!;
    expect(row).toMatchObject({ status: "done", mode: "rotation", gameCount: 4, chargedUsd: end.settledUsd });
    expect(JSON.parse(row.summaryJson)).toEqual(end);
    expect(await runInDurableObject(room, (_i, s) => s.storage.getAlarm())).toBeNull();
  });

  it("skips slots it cannot fund and never settles more than a tight limit", async () => {
    reportedCost = null; // Unknown costs keep each attempt's worst case, so games spend up to their limit.
    const { room } = await startBatch({ mode: "rotation", pool: [MODELS[0].id], gameCount: 4, spendLimitUsd: 0.1, gameLimitUsd: 0.05 });
    const first = await pass(room);
    expect(first.slots.map(s => s.status)).toEqual(["running", "running", "pending", "pending"]);
    const end = await runBatch(room);
    expect(end.status).toBe("done");
    expect(end.slots.slice(0, 2).every(s => s.status === "aborted" && s.abortReason === "spend_limit")).toBe(true);
    expect(end.slots.slice(2).map(s => s.status)).toEqual(["skipped_budget", "skipped_budget"]);
    expect(end.settledUsd).toBeLessThanOrEqual(0.1);
    expect(end.settledUsd).toBeGreaterThan(0.09);
  });

  it("gives a later game only the budget that is left", async () => {
    const { room } = await startBatch({ mode: "rotation", pool: [MODELS[0].id], gameCount: 3, spendLimitUsd: 0.25, gameLimitUsd: 0.1 });
    const first = await pass(room);
    expect(first.slots.map(s => s.limitUsd)).toEqual([0.1, 0.1, 0.05]);
    expect(first.availableUsd).toBe(0);
  });

  it("retries a start the pricing check refuses, then fails the slot at $0", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response("outage", { status: 503 }));
    const { room, id } = await startBatch({ mode: "template", gameCount: 2 });
    const first = await pass(room);
    expect(first.slots.map(s => [s.status, s.startAttempts])).toEqual([["starting", 1], ["starting", 1]]);
    expect(first.escrowUsd).toBe(2);
    await pass(room);
    const end = await pass(room);
    expect(end.status).toBe("done");
    expect(end.slots.map(s => [s.status, s.chargedUsd, s.escrowUsd])).toEqual([["start_failed", 0, 0], ["start_failed", 0, 0]]);
    expect(end.slots[0].abortReason).toContain("pricing");
    for (const slot of end.slots) expect(await liveRoom(env, slot.gameId).getBatchView()).toBeNull();
    expect((await readBatch(env.ARCHIVE, id))!.status).toBe("done");
  });

  it("resumes the same game after a crash between the escrow write and the start", async () => {
    const { room } = await startBatch({ mode: "template", gameCount: 2, spendLimitUsd: 1, gameLimitUsd: 0.4 });
    // As if the room crashed right after funding slot 0, before sending the start.
    await runInDurableObject(room, (_i, s) => {
      s.storage.sql.exec("UPDATE slots SET status = 'starting', limit_usd = 0.4, escrow_usd = 0.4, next_start_at = 0 WHERE idx = 0");
    });
    // And as if slot 1's start landed but its reply was lost.
    const slot1 = (await room.snapshot())!.slots[1].gameId;
    await runInDurableObject(room, (_i, s) => {
      s.storage.sql.exec("UPDATE slots SET status = 'starting', limit_usd = 0.4, escrow_usd = 0.4, next_start_at = 0, start_attempts = 1 WHERE idx = 1");
    });
    const setup1 = await runInDurableObject(room, (_i, s) => JSON.parse(s.storage.sql.exec<{ setup: string }>("SELECT setup FROM slots WHERE idx = 1").one().setup));
    const batchId = (await room.snapshot())!.id;
    expect(await liveRoom(env, slot1).startLive(slot1, 1, setup1, 0.4, batchId)).toEqual({ ok: true });
    const before = await readGame(liveRoom(env, slot1));

    const snap = await pass(room);
    expect(snap.slots.map(s => [s.status, s.limitUsd])).toEqual([["running", 0.4], ["running", 0.4]]);
    expect(effectiveLimit(await readGame(liveRoom(env, snap.slots[0].gameId)))).toBe(0.4);
    expect(await readGame(liveRoom(env, slot1))).toEqual(before);
  });

  it("cancels: pending slots never start and running games abort as cancelled", async () => {
    const { room, id } = await startBatch({ mode: "template", gameCount: 4 });
    await pass(room);
    const cancelling = (await room.cancel())!;
    expect(cancelling.status).toBe("cancelling");
    expect((await room.cancel())!.status).toBe("cancelling");
    const next = await pass(room);
    expect(next.slots[3].status).toBe("cancelled");
    const end = await runBatch(room);
    expect(end.status).toBe("cancelled");
    expect(end.slots.slice(0, 3).every(s => s.status === "aborted" && s.abortReason === "cancelled")).toBe(true);
    expect(end.slots[3]).toMatchObject({ status: "cancelled", limitUsd: null });
    expect(await liveRoom(env, end.slots[3].gameId).getBatchView()).toBeNull();
    expect((await readBatch(env.ARCHIVE, id))!.status).toBe("cancelled");
    // Cancelling a finished batch changes nothing.
    expect((await room.cancel())!.status).toBe("cancelled");
  });

  it("retries the D1 copy when it fails, and stays current afterwards", async () => {
    const { room, id } = await startBatch({ mode: "template", gameCount: 2 });
    await runInDurableObject(room, instance => { (instance as unknown as { env: Env }).env = { ...env, ARCHIVE: undefined as unknown as D1Database }; });
    await pass(room);
    expect(await readBatch(env.ARCHIVE, id)).toBeNull();
    await runInDurableObject(room, instance => { (instance as unknown as { env: Env }).env = env; });
    const snap = await pass(room);
    expect(JSON.parse((await readBatch(env.ARCHIVE, id))!.summaryJson)).toEqual(snap);
  });

  it("makes a batch start idempotent and refuses a reused ID with different settings", async () => {
    const value = { mode: "template", gameCount: 2 };
    const { room, id } = await startBatch(value);
    expect(await room.start(id, request(value))).toEqual({ ok: true });
    expect(await room.start(id, request({ ...value, gameCount: 3 }))).toMatchObject({ ok: false, status: 409 });
    expect((await room.snapshot())!.slots).toHaveLength(2);
    expect(await batchRoom(env, crypto.randomUUID()).snapshot()).toBeNull();
    expect(await batchRoom(env, crypto.randomUUID()).cancel()).toBeNull();
  });
});

export type { Game };
