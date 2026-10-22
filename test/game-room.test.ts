import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type GameRoom, type GameRow, type TurnRow, tuning } from "../workers/game-room";
import { type LlmRequest, type LlmResult, setLlmCall } from "../workers/llm/client";

type Stub = DurableObjectStub<GameRoom>;

const defaultTuning = { ...tuning };
let calls: LlmRequest[] = [];

function stubLlm(respond: (request: LlmRequest, callNo: number) => LlmResult) {
  setLlmCall(async (request) => {
    calls.push(request);
    return respond(request, calls.length);
  });
}

const ok = (text: string): LlmResult => ({
  ok: true,
  text,
  cost: 0.0001,
  cacheHit: false,
  generationId: "gen-test",
  latencyMs: 5,
});

// Alarms due "now" fire on their own; keep every scheduled alarm an hour out
// so only runDurableObjectAlarm / runAlarmNow advance a game.
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  tuning.firstTurnDelayMs = HOUR;
  tuning.retryBackoffMs = HOUR;
  calls = [];
  setLlmCall(async (request) => {
    calls.push(request);
    throw new Error("unstubbed LLM call");
  });
});

afterEach(() => {
  Object.assign(tuning, defaultTuning);
});

// Every test uses a fresh game: storage is shared across tests (isolate: false).
async function startGame(overrides: { totalTurns?: number } = {}) {
  const gameId = crypto.randomUUID();
  const stub: Stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
  await stub.start({ gameId, delayMs: HOUR, model: "test/model", ...overrides });
  return { gameId, stub };
}

async function runAllAlarms(stub: Stub) {
  for (let i = 0; i < 20; i++) {
    if (!(await runDurableObjectAlarm(stub))) return;
  }
  throw new Error("alarm chain did not settle");
}

function journal(stub: Stub): Promise<{ game: GameRow | null; turns: TurnRow[] }> {
  return runInDurableObject(stub, (instance: GameRoom) => instance.getJournal());
}

function eventTypes(stub: Stub): Promise<string[]> {
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ type: string }>("SELECT type FROM events ORDER BY seq")
      .toArray()
      .map((row) => row.type),
  );
}

function pendingAlarm(stub: Stub): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/** Runs the alarm handler directly against seeded state. */
function runAlarmNow(stub: Stub): Promise<void> {
  return runInDurableObject(stub, (instance: GameRoom) => instance.alarm());
}

function seedPendingTurn(stub: Stub, gameId: string, fields: { body: string; attempts: number; lastAttemptAt: number }) {
  return runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO turns (turn_no, idempotency_key, status, request_body, attempts, last_attempt_at)
       VALUES (1, ?, 'pending', ?, ?, ?)`,
      `${gameId}:1`,
      fields.body,
      fields.attempts,
      fields.lastAttemptAt,
    );
  });
}

describe("GameRoom turn loop", () => {
  it("chains three turns to finished", async () => {
    stubLlm((_request, callNo) => ok(`Sentence ${callNo}.`));
    const { stub } = await startGame();

    await runAllAlarms(stub);

    const { game, turns } = await journal(stub);
    expect(game?.status).toBe("finished");
    expect(turns.map((turn) => turn.status)).toEqual(["done", "done", "done"]);
    expect(calls).toHaveLength(3);
    expect(calls[2].body).toContain("1. Sentence 1.\\n2. Sentence 2.");
    expect(await eventTypes(stub)).toEqual(["started", "turn", "turn", "turn", "finished"]);
    expect(await pendingAlarm(stub)).toBeNull();
  });

  it("re-sends the stored body byte-for-byte after the quiet period", async () => {
    stubLlm(() => ok("Recovered."));
    const { gameId, stub } = await startGame();
    await seedPendingTurn(stub, gameId, {
      body: '{"stored":"exactly this"}',
      attempts: 1,
      lastAttemptAt: Date.now() - tuning.quietMs - 1_000,
    });

    await runAlarmNow(stub);

    expect(calls.map((call) => call.body)).toEqual(['{"stored":"exactly this"}']);
    const { turns } = await journal(stub);
    expect(turns[0]).toMatchObject({ status: "done", attempts: 2, response_text: "Recovered." });
  });

  it("never re-sends a turn that is already done", async () => {
    stubLlm(() => ok("Second."));
    const { gameId, stub } = await startGame();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO turns (turn_no, idempotency_key, status, request_body, response_text, attempts)
         VALUES (1, ?, 'done', 'turn-one-body', 'First.', 1)`,
        `${gameId}:1`,
      );
      state.storage.sql.exec("UPDATE game SET next_turn = 2");
    });

    await runAlarmNow(stub);

    expect(calls).toHaveLength(1);
    expect(calls[0].body).not.toBe("turn-one-body");
    expect(calls[0].body).toContain("1. First.");
  });

  it("waits out the quiet period instead of racing an in-flight attempt", async () => {
    const { gameId, stub } = await startGame();
    const lastAttemptAt = Date.now() - 1_000;
    await seedPendingTurn(stub, gameId, { body: "in-flight", attempts: 1, lastAttemptAt });

    await runAlarmNow(stub);

    expect(calls).toHaveLength(0);
    expect(await pendingAlarm(stub)).toBe(lastAttemptAt + tuning.quietMs);
  });

  it("resumes at the right turn after eviction", async () => {
    // Eviction waits for pending work to drain, including the fetch timeout timer.
    tuning.fetchTimeoutMs = 50;
    stubLlm((_request, callNo) => ok(`Sentence ${callNo}.`));
    const { stub } = await startGame();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(calls).toHaveLength(2);
    expect(calls[1].body).toContain("1. Sentence 1.");
    const { game } = await journal(stub);
    expect(game?.next_turn).toBe(3);
  });

  it("aborts after three retryable failures", async () => {
    tuning.quietMs = 0;
    stubLlm(() => ({ ok: false, retryable: true, status: 503, reason: "http_503" }));
    const { stub } = await startGame();

    await runAllAlarms(stub);

    expect(calls).toHaveLength(3);
    const { game } = await journal(stub);
    expect(game).toMatchObject({ status: "aborted", abort_reason: "attempts_exhausted" });
    expect((await eventTypes(stub)).at(-1)).toBe("aborted");
    expect(await pendingAlarm(stub)).toBeNull();
  });

  it("aborts at once on a non-retryable failure", async () => {
    stubLlm(() => ({ ok: false, retryable: false, status: 402, reason: "http_402" }));
    const { stub } = await startGame();

    await runAllAlarms(stub);

    expect(calls).toHaveLength(1);
    const { game } = await journal(stub);
    expect(game).toMatchObject({ status: "aborted", abort_reason: "llm_error: http_402" });
    expect(await pendingAlarm(stub)).toBeNull();
  });

  it("aborts on entry when a turn has used all attempts", async () => {
    const { gameId, stub } = await startGame();
    await seedPendingTurn(stub, gameId, {
      body: "spent",
      attempts: tuning.maxAttempts,
      lastAttemptAt: Date.now() - tuning.quietMs - 1_000,
    });

    await runAlarmNow(stub);

    expect(calls).toHaveLength(0);
    const { game } = await journal(stub);
    expect(game).toMatchObject({ status: "aborted", abort_reason: "attempts_exhausted" });
  });

  it("finishes without a call when every turn is already past", async () => {
    const { stub } = await startGame();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE game SET next_turn = 4");
    });

    await runAlarmNow(stub);

    expect(calls).toHaveLength(0);
    expect((await journal(stub)).game?.status).toBe("finished");
    expect((await eventTypes(stub)).at(-1)).toBe("finished");
  });

  it("treats a second start as a no-op", async () => {
    const { gameId, stub } = await startGame();
    await stub.start({ gameId, delayMs: HOUR, model: "test/model" });

    expect(await eventTypes(stub)).toEqual(["started"]);
  });
});
