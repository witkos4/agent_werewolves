import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type GameRoom, tuning } from "../workers/game-room";
import { handleSpikeRequest } from "../workers/spike/routes";

const KEY = "test-spike-key";
const HOUR = 60 * 60 * 1000;
const defaultTuning = { ...tuning };

// Started games must not reach their first turn during the test.
beforeEach(() => {
  tuning.firstTurnDelayMs = HOUR;
});

afterEach(() => {
  Object.assign(tuning, defaultTuning);
});

function request(path: string, init: RequestInit & { key?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.key) headers.set("x-spike-key", init.key);
  return new Request(`https://example.test${path}`, { ...init, headers });
}

async function start(body?: unknown) {
  const response = await handleSpikeRequest(
    request("/api/spike/start", {
      method: "POST",
      key: KEY,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return response!;
}

describe("spike routes", () => {
  it("leaves non-spike paths to React Router", async () => {
    expect(await handleSpikeRequest(request("/healthz"), env)).toBeNull();
    expect(await handleSpikeRequest(request("/spike/abc"), env)).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["wrong", "not-the-key"],
  ])("returns 404 on start with a %s key", async (_label, key) => {
    const response = await handleSpikeRequest(
      request("/api/spike/start", { method: "POST", key }),
      env,
    );
    expect(response?.status).toBe(404);
  });

  it("returns 404 when SPIKE_KEY is unset, whatever the header", async () => {
    const unset = { ...env, SPIKE_KEY: undefined } as unknown as Env;
    for (const key of [KEY, "undefined", ""]) {
      const response = await handleSpikeRequest(
        request("/api/spike/start", { method: "POST", key }),
        unset,
      );
      expect(response?.status).toBe(404);
    }
  });

  it("starts a game and returns its UUID and viewer URL", async () => {
    const response = await start({ delayMs: 999_999, holdMs: -5 });

    expect(response.status).toBe(200);
    const { gameId, viewerUrl } = await response.json<{ gameId: string; viewerUrl: string }>();
    expect(gameId).toMatch(/^[0-9a-f-]{36}$/);
    expect(viewerUrl).toBe(`/spike/${gameId}`);

    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
    const { game } = await runInDurableObject(stub, (instance: GameRoom) => instance.getJournal());
    expect(game).toMatchObject({
      id: gameId,
      status: "running",
      delay_ms: 300_000,
      hold_ms: 0,
      model: env.SPIKE_MODEL,
    });
  });

  it("uses default timings without a body and rejects a non-JSON body", async () => {
    const { gameId } = await (await start()).json<{ gameId: string }>();
    const stub = env.GAME_ROOM.get(env.GAME_ROOM.idFromName(gameId));
    const { game } = await runInDurableObject(stub, (instance: GameRoom) => instance.getJournal());
    expect(game).toMatchObject({ delay_ms: 30_000, hold_ms: 0 });

    const bad = await handleSpikeRequest(
      request("/api/spike/start", { method: "POST", key: KEY, body: "{nope" }),
      env,
    );
    expect(bad?.status).toBe(400);
  });

  it("returns the journal only with the key", async () => {
    const { gameId } = await (await start()).json<{ gameId: string }>();
    const path = `/api/spike/${gameId}/turns`;

    expect((await handleSpikeRequest(request(path), env))?.status).toBe(404);

    const response = await handleSpikeRequest(request(path, { key: KEY }), env);
    expect(response?.status).toBe(200);
    const journal = await response!.json<{ game: { id: string }; turns: unknown[] }>();
    expect(journal.game.id).toBe(gameId);
    expect(journal.turns).toEqual([]);
  });

  it("returns 404 for a non-UUID game id or an unknown game", async () => {
    for (const gameId of ["not-a-uuid", "start", crypto.randomUUID()]) {
      const response = await handleSpikeRequest(
        request(`/api/spike/${gameId}/turns`, { key: KEY }),
        env,
      );
      expect(response?.status).toBe(404);
    }
  });

  it("returns 404 for other methods and paths under /api/spike/", async () => {
    expect((await handleSpikeRequest(request("/api/spike/start", { key: KEY }), env))?.status).toBe(404);
    expect((await handleSpikeRequest(request("/api/spike/other", { key: KEY }), env))?.status).toBe(404);
  });
});
