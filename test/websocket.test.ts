import { evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type GameEvent,
  type GameRoom,
  KEY_ROTATED_CLOSE_CODE,
  SOCKET_EXPIRED_CLOSE_CODE,
  tuning,
} from "../workers/game-room";
import { setLlmCall } from "../workers/llm/client";

type Stub = DurableObjectStub<GameRoom>;

const HOUR = 60 * 60 * 1000;
const AUTH = { Authorization: `Bearer ${env.ACCESS_KEY}` };
const defaultTuning = { ...tuning };

beforeEach(() => {
  tuning.firstTurnDelayMs = HOUR;
  // Eviction waits for pending timers, including the fetch timeout.
  tuning.fetchTimeoutMs = 50;
  let callNo = 0;
  setLlmCall(async () => ({
    ok: true,
    text: `Sentence ${++callNo}.`,
    cost: 0.0001,
    cacheHit: false,
    generationId: "gen-test",
    latencyMs: 5,
  }));
});

afterEach(() => {
  Object.assign(tuning, defaultTuning);
});

async function startGame() {
  const gameId = crypto.randomUUID();
  const stub: Stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
  await stub.start({ gameId, delayMs: HOUR, model: "test/model" });
  return { gameId, stub };
}

async function connect(gameId: string, after: number) {
  const response = await SELF.fetch(`https://example.test/api/spike/${gameId}/ws?after=${after}`, {
    headers: { ...AUTH, Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const received: GameEvent[] = [];
  ws.addEventListener("message", (message) => {
    received.push(JSON.parse(message.data as string));
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve));
  ws.accept();
  return { ws, received, closed };
}

const seqs = (events: GameEvent[]) => events.map((event) => event.seq);

describe("viewer WebSocket", () => {
  it("replays the backlog after `after`, then streams live events without duplicates", async () => {
    const { gameId, stub } = await startGame();
    await runDurableObjectAlarm(stub); // turn 1 → seq 2
    await runDurableObjectAlarm(stub); // turn 2 → seq 3

    const { ws, received } = await connect(gameId, 1);
    await vi.waitFor(() => expect(seqs(received)).toEqual([2, 3]));

    await runDurableObjectAlarm(stub); // turn 3 → seq 4, finished → seq 5
    await vi.waitFor(() => expect(seqs(received)).toEqual([2, 3, 4, 5]));
    expect(received.map((event) => event.type)).toEqual(["turn", "turn", "turn", "finished"]);
    expect(received[2].payload).toMatchObject({ turnNo: 3, text: "Sentence 3.", cacheHit: false });
    ws.close();
  });

  it("resumes from the last seen seq after the room drops its sockets", async () => {
    const { gameId, stub } = await startGame();
    const first = await connect(gameId, 0);
    await runDurableObjectAlarm(stub); // turn 1 → seq 2
    await vi.waitFor(() => expect(seqs(first.received)).toEqual([1, 2]));

    await evictDurableObject(stub, { webSockets: "close" });
    await runDurableObjectAlarm(stub); // turn 2 → seq 3, while nobody is connected

    const second = await connect(gameId, 2);
    await vi.waitFor(() => expect(seqs(second.received)).toEqual([3]));
    await runDurableObjectAlarm(stub); // turn 3 → seq 4, finished → seq 5
    await vi.waitFor(() => expect(seqs(second.received)).toEqual([3, 4, 5]));
    second.ws.close();
  });

  it("keeps a hibernated socket across eviction while the key is unchanged", async () => {
    const { gameId, stub } = await startGame();
    const { ws, received } = await connect(gameId, 0);
    await vi.waitFor(() => expect(seqs(received)).toEqual([1]));

    await evictDurableObject(stub); // Sockets hibernate, as on a deploy.
    await runDurableObjectAlarm(stub); // turn 1 → seq 2
    await vi.waitFor(() => expect(seqs(received)).toEqual([1, 2]));
    ws.close();
  });

  it("closes a hibernated socket opened with a rotated key as soon as the room wakes", async () => {
    const { gameId, stub } = await startGame();
    const { received, closed } = await connect(gameId, 0);
    await vi.waitFor(() => expect(seqs(received)).toEqual([1]));
    // Stand in for a socket opened before `wrangler secret put ACCESS_KEY`.
    await runInDurableObject(stub, (_room, state) => {
      state.getWebSockets()[0].serializeAttachment({ keyFingerprint: "previous-key", openedAt: Date.now() });
    });

    await evictDurableObject(stub);
    await stub.getJournal(); // Constructing the room on the new key drops the socket.
    expect((await closed).code).toBe(KEY_ROTATED_CLOSE_CODE);
    expect(seqs(received)).toEqual([1]);
  });

  it("does not broadcast to a socket whose key no longer matches", async () => {
    const { gameId, stub } = await startGame();
    const { received, closed } = await connect(gameId, 0);
    await vi.waitFor(() => expect(seqs(received)).toEqual([1]));
    await runInDurableObject(stub, (room) => {
      (room as unknown as { keyFingerprint: string }).keyFingerprint = "rotated";
    });

    await runDurableObjectAlarm(stub); // turn 1 → seq 2, withheld
    expect((await closed).code).toBe(KEY_ROTATED_CLOSE_CODE);
    expect(seqs(received)).toEqual([1]);
  });

  it("closes a socket past its maximum age before broadcasting; the viewer resumes on reconnect", async () => {
    const { gameId, stub } = await startGame();
    const first = await connect(gameId, 0);
    await vi.waitFor(() => expect(seqs(first.received)).toEqual([1]));

    tuning.maxSocketAgeMs = 0;
    await runDurableObjectAlarm(stub); // turn 1 → seq 2, withheld from the expired socket
    expect((await first.closed).code).toBe(SOCKET_EXPIRED_CLOSE_CODE);
    expect(seqs(first.received)).toEqual([1]);

    tuning.maxSocketAgeMs = HOUR;
    const second = await connect(gameId, 1); // Back through the gate, replaying from seq 1.
    await vi.waitFor(() => expect(seqs(second.received)).toEqual([2]));
    second.ws.close();
  });

  it("returns 426 to a non-upgrade request", async () => {
    const { gameId } = await startGame();
    const response = await SELF.fetch(`https://example.test/api/spike/${gameId}/ws`, { headers: AUTH });
    expect(response.status).toBe(426);
  });

  it("returns 404 for an unknown game or a non-UUID id", async () => {
    for (const gameId of [crypto.randomUUID(), "not-a-uuid"]) {
      const response = await SELF.fetch(`https://example.test/api/spike/${gameId}/ws`, {
        headers: { ...AUTH, Upgrade: "websocket" },
      });
      expect(response.status).toBe(404);
    }
  });
});
