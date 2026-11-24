import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameRoom } from "../workers/game-room";
import { SOCKET_EXPIRED_CLOSE_CODE, tuning } from "../workers/game-room";
import { attemptAllowance, buildRequest, type Game } from "../workers/game/engine";
import { liveRoom, handleGameRequest } from "../workers/game/routes";
import { archiveTuning, liveTuning } from "../workers/game/runtime";
import { setLlmCall, type LlmCall } from "../workers/llm/client";
import { MODELS } from "../workers/game/catalog";
import { DEFAULT_SETUP, SEAT_COUNT, type GameSetup } from "../workers/game/setup";
import { catalog } from "./live-helpers";

const defaults = { ...liveTuning };
const HOUR = 3600_000;
let previous: LlmCall;
let calls = 0;
const ok = (text: string, cost: number | null = 0.0001) => ({ ok: true as const, text, cost, cacheHit: false, generationId: "test-generation", latencyMs: 1 });

beforeEach(() => {
  Object.assign(liveTuning, { firstDelayMs: HOUR, nextDelayMs: HOUR, timeoutMs: 100 });
  // A due alarm fires on its own; keep terminal rooms' archive alarm out of the way.
  archiveTuning.firstDelayMs = HOUR;
  vi.mocked(fetch).mockImplementation(async () => catalog());
  calls = 0;
  previous = setLlmCall(async () => { calls++; return ok("invalid"); });
});
afterEach(() => { Object.assign(liveTuning, defaults); archiveTuning.firstDelayMs = 0; setLlmCall(previous); });

async function start(spendLimitUsd?: number) {
  const id = crypto.randomUUID();
  const room = liveRoom(env, id);
  expect(await room.startLive(id, 1, undefined, spendLimitUsd)).toEqual({ ok: true });
  return { room, id };
}
/** Plays legal moves that lead the village to the wolves, at a fixed reported cost. */
async function playLegally(room: DurableObjectStub<GameRoom>, cost: number | null) {
  const wolves = (await inspect(room)).game.players.filter(p => p.role === "Werewolf").map(p => p.id);
  setLlmCall(async request => {
    calls++;
    const view = JSON.parse(JSON.parse(request.body).messages[1].content);
    const target = view.actor.role !== "Werewolf" ? wolves.find(id => view.allowedTargets.includes(id)) ?? view.allowedTargets[0]
      : view.allowedTargets.filter((id: string) => !wolves.includes(id)).at(-1);
    return ok(JSON.stringify(view.phase === "discuss" ? { text: "Let's compare.", rationale: "r" } : { target, rationale: "r" }), cost);
  });
}
/** Runs alarms until the game ends, checking the ledger never passes the limit. */
async function runToEnd(room: DurableObjectStub<GameRoom>, limit: number) {
  for (let i = 0; i < 120; i++) {
    await alarmNow(room);
    const { game, charged } = await inspect(room);
    expect(charged).toBeLessThanOrEqual(limit + 1e-12);
    if (game.status !== "running") return game;
  }
  throw new Error("game did not end");
}
function inspect(room: DurableObjectStub<GameRoom>) {
  return runInDurableObject(room, (_instance, state) => {
    const row = state.storage.sql.exec<{ state: string; reserved_usd: number; charged_usd: number }>("SELECT * FROM live_game").one();
    return { game: JSON.parse(row.state) as Game, reserved: row.reserved_usd, charged: row.charged_usd,
      turns: state.storage.sql.exec<{ turn_no: number; body: string; attempts: number; status: string; cost: number | null }>("SELECT * FROM live_turns ORDER BY turn_no").toArray(),
      events: state.storage.sql.exec<{ seq: number; type: string; payload: string }>("SELECT * FROM events ORDER BY seq").toArray() };
  });
}
function alarmNow(room: DurableObjectStub<GameRoom>) { return runInDurableObject(room, instance => instance.alarm()); }
async function alter(room: DurableObjectStub<GameRoom>, patch: Partial<Game>) {
  await runInDurableObject(room, (_instance, state) => {
    const row = state.storage.sql.exec<{ state: string }>("SELECT state FROM live_game").one();
    state.storage.sql.exec("UPDATE live_game SET state = ?", JSON.stringify({ ...JSON.parse(row.state), ...patch }));
  });
}

describe("durable live games", () => {
  it("finishes a game after eviction, reveals roles only at the end and never repeats an accepted move", async () => {
    const { room } = await start();
    const wolves = (await inspect(room)).game.players.filter(p => p.role === "Werewolf").map(p => p.id);
    setLlmCall(async request => {
      calls++;
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      const target = view.actor.role !== "Werewolf" ? wolves.find(id => view.allowedTargets.includes(id)) ?? view.allowedTargets[0]
        : view.allowedTargets.filter((id: string) => !wolves.includes(id)).at(-1);
      return ok(JSON.stringify(view.phase === "discuss" ? { text: "Let's compare our suspicions.", rationale: "private-rationale" }
        : { target, rationale: "private-rationale" }));
    });
    expect(await runDurableObjectAlarm(room)).toBe(true);
    await evictDurableObject(room);
    for (let i = 0; i < 80; i++) {
      if ((await room.getLiveSnapshot())!.game.status !== "running") break;
      expect(await runDurableObjectAlarm(room)).toBe(true);
    }
    const stored = await inspect(room);
    expect(stored.game).toMatchObject({ status: "finished", winner: "Village" });
    expect(stored.turns).toHaveLength(calls);
    expect(stored.turns.every(t => t.status === "done" && t.attempts === 1)).toBe(true);
    expect(stored.events.map(e => e.seq)).toEqual(stored.events.map((_, i) => i + 1));
    for (const e of stored.events.slice(0, -1)) {
      const visible = JSON.parse(e.payload);
      expect(visible.players.every((p: { role?: string }) => !p.role)).toBe(true);
      expect(e.payload).not.toContain("private-rationale");
    }
    expect((await room.getLiveSnapshot())!.game.players.every(p => p.role)).toBe(true);
    await alarmNow(room);
    expect((await inspect(room)).turns).toHaveLength(calls);
    expect(await runInDurableObject(room, (_i, s) => s.storage.getAlarm())).toBeNull();
  });

  it("retries the exact persisted request, reserves both attempts, and keeps unknown usage unknown", async () => {
    const { room } = await start();
    const bodies: string[] = [];
    setLlmCall(async request => {
      bodies.push(request.body);
      if (bodies.length === 1) return { ok: false, retryable: true, status: null, reason: "timeout" };
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      return ok(JSON.stringify({ target: view.allowedTargets[0], rationale: "decision" }), null);
    });
    await alarmNow(room);
    const first = await inspect(room);
    await alarmNow(room); // Quiet period: no second fetch.
    expect(bodies).toHaveLength(1);
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_turns SET last_attempt_at = ?", Date.now() - liveTuning.quietMs - 1); });
    await alarmNow(room);
    const next = await inspect(room);
    expect(bodies).toEqual([first.turns[0].body, first.turns[0].body]);
    expect(next.reserved).toBeCloseTo(first.reserved * 2);
    // Neither attempt reported a cost, so both keep their full charge.
    expect(next.charged).toBeCloseTo(first.reserved * 2);
    expect(next.turns[0]).toMatchObject({ attempts: 2, status: "done", cost: null });
  });

  it("aborts invalid output rather than inventing a move", async () => {
    const { room } = await start();
    await alarmNow(room);
    expect((await room.getLiveSnapshot())!.game).toMatchObject({ status: "aborted", abortReason: "invalid_model_response", winner: null });
    const stored = await inspect(room);
    expect(stored.game.turn).toBe(1);
    // The rejected reply is kept for diagnosis but the turn is not completed.
    expect(stored.turns[0]).toMatchObject({ status: "pending" });
    expect(await runInDurableObject(room, (_i, s) => s.storage.sql.exec<{ response_text: string }>("SELECT response_text FROM live_turns").one().response_text)).toBe("invalid");
  });

  it("aborts at the deadline after eviction without another provider call", async () => {
    const { room } = await start();
    await alter(room, { deadlineAt: Date.now() - 1 });
    await evictDurableObject(room);
    await alarmNow(room);
    expect((await room.getLiveSnapshot())!.game.abortReason).toBe("time_limit");
    expect(calls).toBe(0);
  });

  it("charges before a call and stops before the ledger could pass the default limit", async () => {
    const { room } = await start();
    expect((await room.getLiveSnapshot())!.game.spendLimitUsd).toBe(1);
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_game SET charged_usd = 0.999"); });
    await alarmNow(room);
    expect((await room.getLiveSnapshot())!.game.abortReason).toBe("spend_limit");
    expect(calls).toBe(0);
  });

  it("aborts mid-game at its spend limit when costs stay unknown, never calling past it", async () => {
    const { room } = await start(0.05);
    await playLegally(room, null);
    const game = await runToEnd(room, 0.05);
    expect(game).toMatchObject({ status: "aborted", abortReason: "spend_limit", winner: null });
    const stored = await inspect(room);
    expect(calls).toBeGreaterThan(1);
    // Every call was charged its full worst case, and the next one would not fit.
    expect(stored.charged).toBeCloseTo(stored.reserved);
    const pending = stored.turns.find(t => t.status === "pending")!;
    expect(stored.charged + attemptAllowance(pending.body)).toBeGreaterThan(0.05);
    expect(pending.attempts).toBe(0);
    const before = calls;
    await alarmNow(room);
    expect(calls).toBe(before);
  });

  it("settles known costs so a game finishes under a limit its gross reservations exceed", async () => {
    const { room } = await start(0.05);
    await playLegally(room, 0.0001);
    const game = await runToEnd(room, 0.05);
    expect(game).toMatchObject({ status: "finished" });
    const stored = await inspect(room);
    expect(stored.reserved).toBeGreaterThan(0.05);
    expect(stored.charged).toBeCloseTo(calls * 0.0001, 10);
  });

  it("keeps a failed attempt charged and settles only the attempt that returned", async () => {
    const { room } = await start();
    let attempt = 0;
    setLlmCall(async request => {
      if (++attempt === 1) return { ok: false, retryable: true, status: 503, reason: "http_503" };
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      return ok(JSON.stringify({ target: view.allowedTargets[0], rationale: "decision" }), 0);
    });
    await alarmNow(room);
    const first = await inspect(room);
    expect(first.charged).toBeCloseTo(first.reserved);
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_turns SET last_attempt_at = ?", Date.now() - liveTuning.quietMs - 1); });
    await alarmNow(room);
    const next = await inspect(room);
    expect(next.turns[0]).toMatchObject({ status: "done", attempts: 2 });
    // A free (cache-hit) success refunds its own charge; the failed attempt's stays.
    expect(next.charged).toBeCloseTo(first.reserved);
  });

  it("keeps a failed attempt charged and settles a paid (cache-miss) retry to its reported cost", async () => {
    const { room } = await start();
    let attempt = 0;
    setLlmCall(async request => {
      if (++attempt === 1) return { ok: false, retryable: true, status: 503, reason: "http_503" };
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      return ok(JSON.stringify({ target: view.allowedTargets[0], rationale: "decision" }), 0.0003);
    });
    await alarmNow(room);
    const first = await inspect(room);
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_turns SET last_attempt_at = ?", Date.now() - liveTuning.quietMs - 1); });
    await alarmNow(room);
    const next = await inspect(room);
    expect(next.turns[0]).toMatchObject({ status: "done", attempts: 2, cost: 0.0003 });
    expect(next.reserved).toBeCloseTo(first.reserved * 2, 10);
    expect(next.charged).toBeCloseTo(first.reserved + 0.0003, 10);
  });

  it("aborts before a retry call when the retry allowance would pass the spend limit", async () => {
    const { room } = await start(0.05);
    const allowance = attemptAllowance(buildRequest((await inspect(room)).game));
    const initialCharged = 0.05 - allowance * 1.5;
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_game SET charged_usd = ?", initialCharged); });
    setLlmCall(async () => { calls++; return { ok: false, retryable: true, status: null, reason: "timeout" }; });
    await alarmNow(room);
    expect(calls).toBe(1);
    const afterFirst = await inspect(room);
    expect(afterFirst.charged).toBeCloseTo(initialCharged + allowance, 10);
    expect(afterFirst.charged).toBeLessThanOrEqual(0.05);
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_turns SET last_attempt_at = ?", Date.now() - liveTuning.quietMs - 1); });
    await alarmNow(room);
    const afterRetryCheck = await inspect(room);
    expect(calls).toBe(1);
    expect(afterRetryCheck.game).toMatchObject({ status: "aborted", abortReason: "spend_limit" });
    expect(afterRetryCheck.charged).toBeCloseTo(initialCharged + allowance, 10);
    expect(afterRetryCheck.charged).toBeLessThanOrEqual(0.05);
  });

  it("keeps the full allowance charged on an invalid move or an in-flight cancellation", async () => {
    const invalid = await start();
    await alarmNow(invalid.room);
    const storedInvalid = await inspect(invalid.room);
    expect(storedInvalid.game).toMatchObject({ status: "aborted", abortReason: "invalid_model_response" });
    expect(storedInvalid.charged).toBeCloseTo(storedInvalid.reserved, 10);
    expect(storedInvalid.charged).toBeGreaterThan(0);

    liveTuning.timeoutMs = 5_000;
    const cancelled = await start();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    setLlmCall(async request => {
      entered = true;
      await gate;
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      return ok(JSON.stringify({ target: view.allowedTargets[0], rationale: "late" }), 0.0001);
    });
    const inFlight = alarmNow(cancelled.room);
    await vi.waitFor(() => expect(entered).toBe(true));
    await cancelled.room.cancelLive();
    release();
    await inFlight;
    const storedCancelled = await inspect(cancelled.room);
    expect(storedCancelled.game).toMatchObject({ status: "aborted", abortReason: "cancelled" });
    expect(storedCancelled.turns[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(storedCancelled.charged).toBeCloseTo(storedCancelled.reserved, 10);
  });

  it("keeps the reserved charge without corrupting the ledger if allowance_usd is null during settlement", async () => {
    liveTuning.timeoutMs = 5_000;
    const { room } = await start();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    setLlmCall(async request => {
      entered = true;
      await gate;
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      return ok(JSON.stringify({ target: view.allowedTargets[0], rationale: "decision" }), 0.0001);
    });
    const inFlight = alarmNow(room);
    await vi.waitFor(() => expect(entered).toBe(true));
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_turns SET allowance_usd = NULL WHERE turn_no = 1"); });
    release();
    await inFlight;
    const stored = await inspect(room);
    expect(stored.game.turn).toBe(2);
    expect(stored.turns[0]).toMatchObject({ status: "done", cost: 0.0001 });
    expect(stored.charged).toBeCloseTo(stored.reserved, 10);
  });

  it("upgrades a pre-ledger room in place, seeding its ledger from its gross reservations", async () => {
    const { room } = await start();
    await runInDurableObject(room, (_i, s) => {
      s.storage.sql.exec("ALTER TABLE live_game DROP COLUMN charged_usd");
      s.storage.sql.exec("ALTER TABLE live_turns DROP COLUMN allowance_usd");
      s.storage.sql.exec("UPDATE live_game SET reserved_usd = 0.3");
      const row = s.storage.sql.exec<{ state: string }>("SELECT state FROM live_game").one();
      const { spendLimitUsd: _, ...legacy } = JSON.parse(row.state) as Game;
      s.storage.sql.exec("UPDATE live_game SET state = ?", JSON.stringify(legacy));
    });
    await evictDurableObject(room);
    await playLegally(room, 0.0002);
    await alarmNow(room);
    const stored = await inspect(room);
    expect(stored.game.turn).toBe(2);
    expect(stored.charged).toBeCloseTo(0.3 + 0.0002, 10);
    expect((await room.getLiveSnapshot())!.game.spendLimitUsd).toBe(1);
  });

  it("bounds repeated provider failures", async () => {
    const { room } = await start();
    setLlmCall(async () => { calls++; return { ok: false, retryable: true, status: 503, reason: "unavailable" }; });
    for (let i = 0; i < 3; i++) {
      await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_turns SET last_attempt_at = 0"); });
      await alarmNow(room);
    }
    expect(calls).toBe(3);
    expect((await room.getLiveSnapshot())!.game.abortReason).toBe("attempts_exhausted");
    // No further turn: the only alarm left is the archive attempt.
    expect(await runInDurableObject(room, (_i, s) => s.storage.getAlarm())).toBeGreaterThan(Date.now() + HOUR - 60_000);
  });

  it("cancels a stalled call and reaches a terminal failure", async () => {
    const { room } = await start();
    Object.assign(liveTuning, { timeoutMs: 5, maxAttempts: 1 });
    setLlmCall(request => new Promise(resolve => {
      request.signal.addEventListener("abort", () => resolve({ ok: false, retryable: true, status: null, reason: "timeout" }), { once: true });
    }));
    await alarmNow(room);
    expect((await room.getLiveSnapshot())!.game.abortReason).toBe("attempts_exhausted");
  });

  it("cannot accept a successful result after the game deadline", async () => {
    const { room } = await start();
    await alter(room, { deadlineAt: Date.now() + 15 });
    setLlmCall(async request => {
      await new Promise(resolve => setTimeout(resolve, 25));
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      return ok(JSON.stringify({ target: view.allowedTargets[0], rationale: "late reply" }));
    });
    await alarmNow(room);
    const stored = await inspect(room);
    expect(stored.game).toMatchObject({ status: "aborted", abortReason: "time_limit", turn: 1 });
    expect(stored.turns.every(t => t.status === "pending")).toBe(true);
  });

  it("fails closed on unavailable or excessive pricing for any seated model", async () => {
    const seated = MODELS[2].id;
    const setup = { seats: DEFAULT_SETUP.seats.map(s => ({ ...s, model: seated })), pool: [] };
    const withPricing = (pricing: Record<string, string>) => () => Response.json({
      data: MODELS.map(m => ({ id: m.id, pricing: m.id === seated ? pricing : { prompt: "0.00000025", completion: "0.0000015" } })),
    });
    for (const [response, error] of [
      [() => new Response("outage", { status: 503 }), "safe model pricing"],
      [() => catalog({ overpriced: seated }), `pricing for ${seated}`],
      [withPricing({ prompt: "0.00000025", completion: "0.0000015", request: "0.001" }), `pricing for ${seated}`],
      [withPricing({ prompt: "0.00000025", completion: "0.0000015", internal_reasoning: "0.00001" }), `pricing for ${seated}`],
      [withPricing({ prompt: "0.00000025", completion: "0.0000015", internal_reasoning: "-1" }), `pricing for ${seated}`],
    ] as const) {
      vi.mocked(fetch).mockImplementationOnce(async () => response());
      const id = crypto.randomUUID(), room = liveRoom(env, id);
      expect(await room.startLive(id, 1, setup)).toMatchObject({ ok: false, status: 503, error: expect.stringContaining(error) });
      expect(await room.getLiveSnapshot()).toBeNull();
      expect(await runInDurableObject(room, (_i, s) => s.storage.getAlarm())).toBeNull();
    }
    expect(calls).toBe(0);
  });

  it("ignores pricing of pool models that no seat drew", async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => catalog({ overpriced: MODELS[5].id }));
    const setup = { seats: DEFAULT_SETUP.seats.map(s => ({ ...s, model: MODELS[0].id })), pool: [MODELS[5].id] };
    const id = crypto.randomUUID();
    expect(await liveRoom(env, id).startLive(id, 1, setup)).toEqual({ ok: true });
  });

  it("makes duplicate starts idempotent and rejects different settings", async () => {
    const { room, id } = await start();
    const initial = await room.getLiveSnapshot();
    expect(await room.startLive(id, 1)).toEqual({ ok: true });
    expect(await room.startLive(id, 2)).toMatchObject({ ok: false, status: 409 });
    expect(await room.getLiveSnapshot()).toEqual(initial);
    expect((await inspect(room)).events).toHaveLength(1);
    // Omitted setup is the default setup.
    expect(await room.startLive(id, 1, DEFAULT_SETUP)).toEqual({ ok: true });
    expect(await room.startLive(id, 1, { ...DEFAULT_SETUP, pool: [MODELS[0].id] })).toMatchObject({ ok: false, status: 409 });
    // Omitted limit is the default limit; a different limit is a different start.
    expect(await room.startLive(id, 1, undefined, 1)).toEqual({ ok: true });
    expect(await room.startLive(id, 1, undefined, 0.5)).toMatchObject({ ok: false, status: 409 });
  });

  it("keeps a chosen limit idempotent and rejects out-of-range limits in the room", async () => {
    const { room, id } = await start(0.25);
    expect(await room.startLive(id, 1, undefined, 0.25)).toEqual({ ok: true });
    expect(await room.startLive(id, 1)).toMatchObject({ ok: false, status: 409 });
    const other = crypto.randomUUID();
    expect(await liveRoom(env, other).startLive(other, 1, undefined, 9)).toMatchObject({ ok: false, status: 400 });
  });

  it("stores a manual mixed setup and sends each turn with its actor's model", async () => {
    const models = Array.from({ length: SEAT_COUNT }, (_, i) => MODELS[i % MODELS.length].id);
    const setup: GameSetup = { seats: models.map((model, i) => ({ model, persona: ["analyst", "accuser", "random", "random", "loyalist", "random", "random", "random"][i] })), pool: [] };
    const id = crypto.randomUUID(), room = liveRoom(env, id);
    expect(await room.startLive(id, 1, setup)).toEqual({ ok: true });
    expect(await room.startLive(id, 1, setup)).toEqual({ ok: true });
    expect(await room.startLive(id, 1)).toMatchObject({ ok: false, status: 409 });
    const { game } = await inspect(room);
    expect(game).toMatchObject({ version: 2, model: "mixed", setup });
    expect(game.players.map(p => p.model)).toEqual(models);
    const sent: { model: string; actor: string }[] = [];
    setLlmCall(async request => {
      const body = JSON.parse(request.body);
      const view = JSON.parse(body.messages[1].content);
      sent.push({ model: body.model, actor: view.actor.id });
      return ok(JSON.stringify(view.phase === "discuss" ? { text: "Hm.", rationale: "r" } : { target: view.allowedTargets[0], rationale: "r" }));
    });
    for (let i = 0; i < 6; i++) await alarmNow(room);
    expect(sent.length).toBe(6);
    for (const call of sent) expect(call.model).toBe(game.players.find(p => p.id === call.actor)!.model);
    expect(new Set(sent.map(c => c.model)).size).toBeGreaterThan(1);
  });

  it("rejects an invalid setup before touching the room", async () => {
    const id = crypto.randomUUID(), room = liveRoom(env, id);
    expect(await room.startLive(id, 1, { seats: [], pool: [] })).toMatchObject({ ok: false, status: 400 });
    const response = await handleGameRequest(new Request("https://example.test/api/games/start", {
      method: "POST", body: JSON.stringify({ requestId: id, discussionPasses: 1, setup: { seats: [], pool: [] } }),
    }), env);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "Configure exactly 8 seats." });
    expect(await room.getLiveSnapshot()).toBeNull();
  });

  it("keeps accepting a setup-less repeat for a version-1 room", async () => {
    const { room, id } = await start();
    await alter(room, { version: 1, setup: undefined });
    expect(await room.startLive(id, 1)).toEqual({ ok: true });
    expect(await room.startLive(id, 1, DEFAULT_SETUP)).toMatchObject({ ok: false, status: 409 });
  });

  it("upgrades a legacy spike room without changing its saved story or alarm loop", async () => {
    const oldFirstDelay = tuning.firstTurnDelayMs, oldTimeout = tuning.fetchTimeoutMs;
    tuning.firstTurnDelayMs = HOUR;
    tuning.fetchTimeoutMs = 10;
    try {
      const id = crypto.randomUUID(), room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(id));
      await room.start({ gameId: id, delayMs: HOUR, model: "test/model" });
      // Reproduce the pre-change schema: only the original spike tables exist.
      await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("DROP TABLE live_game; DROP TABLE live_turns;"); });
      await evictDurableObject(room);
      setLlmCall(async () => ok("The story continues."));
      for (let i = 0; i < 3; i++) expect(await runDurableObjectAlarm(room)).toBe(true);
      const saved = await room.getJournal();
      expect(saved.game?.status).toBe("finished");
      expect(saved.turns).toHaveLength(3);
      expect(await room.getLiveSnapshot()).toBeNull();
    } finally { tuning.firstTurnDelayMs = oldFirstDelay; tuning.fetchTimeoutMs = oldTimeout; }
  });
});

describe("live game HTTP boundary", () => {
  it("requires authentication for starts, snapshots and socket upgrades", async () => {
    const id = crypto.randomUUID();
    for (const [path, init] of [["start", { method: "POST" }], [id, {}], [`${id}/ws`, { headers: { Upgrade: "websocket" } }]] as const) {
      expect((await SELF.fetch(`https://example.test/api/games/${path}`, init)).status).toBe(404);
    }
    expect(calls).toBe(0);
  });

  it("validates input, blocks cross-origin starts and returns only public snapshots", async () => {
    expect((await handleGameRequest(new Request("https://example.test/api/games/start", { method: "POST", body: "{}" }), env))?.status).toBe(400);
    expect((await handleGameRequest(new Request("https://example.test/api/games/start", { method: "POST", headers: { Origin: "https://evil.test" }, body: "{}" }), env))?.status).toBe(403);
    for (const spendLimitUsd of [0.04, 5.01, "1", 0.055, null]) {
      const body = JSON.stringify({ requestId: crypto.randomUUID(), discussionPasses: 1, spendLimitUsd });
      const response = await handleGameRequest(new Request("https://example.test/api/games/start", { method: "POST", body }), env);
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ error: expect.stringContaining("spend limit") });
    }
    expect(calls).toBe(0);
    const { id } = await start();
    const response = await SELF.fetch(`https://example.test/api/games/${id}`, { headers: { Authorization: `Bearer ${env.ACCESS_KEY}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const visible = await response.json() as { game: { players: { role?: string }[] } };
    expect(visible.game.players.every(p => !p.role)).toBe(true);
    expect((await handleGameRequest(new Request(`https://example.test/api/games/${crypto.randomUUID()}`), env))?.status).toBe(404);
  });

  it("replays the public stream after a snapshot cursor and reconnects across socket expiry", async () => {
    const { room, id } = await start();
    const snapshot = (await room.getLiveSnapshot())!;
    setLlmCall(async request => {
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      return ok(JSON.stringify({ target: view.allowedTargets[0], rationale: "private-websocket-sentinel" }));
    });
    async function connect(after: number) {
      const response = await SELF.fetch(`https://example.test/api/games/${id}/ws?after=${after}`, {
        headers: { Authorization: `Bearer ${env.ACCESS_KEY}`, Upgrade: "websocket" },
      });
      expect(response.status).toBe(101);
      const ws = response.webSocket!;
      const messages: string[] = [];
      ws.addEventListener("message", event => { messages.push(String(event.data)); });
      const closed = new Promise<CloseEvent>(resolve => ws.addEventListener("close", resolve));
      ws.accept();
      return { ws, messages, closed };
    }
    const first = await connect(snapshot.seq);
    const startedAt = performance.now();
    await runDurableObjectAlarm(room);
    await vi.waitFor(() => expect(first.messages).toHaveLength(1));
    expect(performance.now() - startedAt).toBeLessThan(2000);
    expect(JSON.parse(first.messages[0]).seq).toBe(snapshot.seq + 1);
    expect(first.messages[0]).not.toContain("private-websocket-sentinel");
    first.ws.send("ping");
    await vi.waitFor(() => expect(first.messages).toContain("pong"));
    const originalAge = tuning.maxSocketAgeMs;
    try {
      tuning.maxSocketAgeMs = 0;
      await runDurableObjectAlarm(room);
      expect((await first.closed).code).toBe(SOCKET_EXPIRED_CLOSE_CODE);
    } finally { tuning.maxSocketAgeMs = originalAge; }
    const second = await connect(snapshot.seq + 1);
    await vi.waitFor(() => expect(second.messages).toHaveLength(1));
    expect(JSON.parse(second.messages[0]).seq).toBe(snapshot.seq + 2);
    expect(second.messages[0]).not.toContain("private-websocket-sentinel");
    second.ws.close();
  });
});
