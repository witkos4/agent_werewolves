import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameRoom } from "../workers/game-room";
import { SOCKET_EXPIRED_CLOSE_CODE, tuning } from "../workers/game-room";
import type { Game } from "../workers/game/engine";
import { liveRoom, handleGameRequest } from "../workers/game/routes";
import { archiveTuning, liveTuning } from "../workers/game/runtime";
import { setLlmCall, type LlmCall } from "../workers/llm/client";
import { MODELS } from "../workers/game/catalog";
import { DEFAULT_SETUP, type GameSetup } from "../workers/game/setup";
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

async function start() {
  const id = crypto.randomUUID();
  const room = liveRoom(env, id);
  expect(await room.startLive(id, 1)).toEqual({ ok: true });
  return { room, id };
}
function inspect(room: DurableObjectStub<GameRoom>) {
  return runInDurableObject(room, (_instance, state) => {
    const row = state.storage.sql.exec<{ state: string; reserved_usd: number }>("SELECT * FROM live_game").one();
    return { game: JSON.parse(row.state) as Game, reserved: row.reserved_usd,
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
    const wolf = (await inspect(room)).game.players.find(p => p.role === "Werewolf")!.id;
    setLlmCall(async request => {
      calls++;
      const view = JSON.parse(JSON.parse(request.body).messages[1].content);
      return ok(JSON.stringify(view.phase === "discuss" ? { text: "Let's compare our suspicions.", rationale: "private-rationale" }
        : { target: view.actor.role !== "Werewolf" ? wolf : view.allowedTargets.at(-1), rationale: "private-rationale" }));
    });
    expect(await runDurableObjectAlarm(room)).toBe(true);
    await evictDurableObject(room);
    for (let i = 0; i < 30; i++) {
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
    expect(next.turns[0]).toMatchObject({ attempts: 2, status: "done", cost: null });
  });

  it("aborts invalid output rather than inventing a move", async () => {
    const { room } = await start();
    await alarmNow(room);
    expect((await room.getLiveSnapshot())!.game).toMatchObject({ status: "aborted", abortReason: "invalid_model_response", winner: null });
    expect((await inspect(room)).game.turn).toBe(1);
  });

  it("aborts at the deadline after eviction without another provider call", async () => {
    const { room } = await start();
    await alter(room, { deadlineAt: Date.now() - 1 });
    await evictDurableObject(room);
    await alarmNow(room);
    expect((await room.getLiveSnapshot())!.game.abortReason).toBe("time_limit");
    expect(calls).toBe(0);
  });

  it("reserves before a call and stops before exceeding the safety allowance", async () => {
    const { room } = await start();
    await runInDurableObject(room, (_i, s) => { s.storage.sql.exec("UPDATE live_game SET reserved_usd = 0.25"); });
    await alarmNow(room);
    expect((await room.getLiveSnapshot())!.game.abortReason).toBe("safety_budget");
    expect(calls).toBe(0);
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
    for (const [response, error] of [[() => new Response("outage", { status: 503 }), "safe model pricing"], [() => catalog({ overpriced: seated }), `pricing for ${seated}`]] as const) {
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
  });

  it("stores a manual mixed setup and sends each turn with its actor's model", async () => {
    const setup: GameSetup = { seats: MODELS.slice(0, 5).map((m, i) => ({ model: m.id, persona: ["analyst", "accuser", "random", "random", "observer"][i] })), pool: [] };
    const id = crypto.randomUUID(), room = liveRoom(env, id);
    expect(await room.startLive(id, 1, setup)).toEqual({ ok: true });
    expect(await room.startLive(id, 1, setup)).toEqual({ ok: true });
    expect(await room.startLive(id, 1)).toMatchObject({ ok: false, status: 409 });
    const { game } = await inspect(room);
    expect(game).toMatchObject({ version: 2, model: "mixed", setup });
    expect(game.players.map(p => p.model)).toEqual(MODELS.slice(0, 5).map(m => m.id));
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
    expect(await response?.json()).toEqual({ error: "Configure exactly 5 seats." });
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
