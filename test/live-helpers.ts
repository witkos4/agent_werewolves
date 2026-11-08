import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { GameRoom } from "../workers/game-room";
import type { Game } from "../workers/game/engine";
import { MODELS } from "../workers/game/catalog";
import type { GameSetup } from "../workers/game/setup";
import { liveRoom } from "../workers/game/routes";
import { setLlmCall } from "../workers/llm/client";

/** Public pricing catalog response the start check accepts; `overpriced` breaks one model's ceiling. */
export const catalog = ({ overpriced }: { overpriced?: string } = {}) => Response.json({
  data: MODELS.map(m => ({ id: m.id, pricing: m.id === overpriced ? { prompt: "1", completion: "1" } : { prompt: "0.00000025", completion: "0.0000015", internal_reasoning: "0.0000015" } })),
});
export const ok = (text: string) => ({ ok: true as const, text, cost: 0.0001, cacheHit: false, generationId: "gen", latencyMs: 5 });

export async function startLiveGame(setup?: GameSetup) {
  const id = crypto.randomUUID();
  const room = liveRoom(env, id);
  expect(await room.startLive(id, 1, setup)).toEqual({ ok: true });
  return { room, id };
}

export function readGame(room: DurableObjectStub<GameRoom>) {
  return runInDurableObject(room, (_i, s) => JSON.parse(s.storage.sql.exec<{ state: string }>("SELECT state FROM live_game").one().state) as Game);
}

/** Every agent gives `rationale`; non-wolves vote out the wolf, so the village wins. */
export async function stubVillageWin(room: DurableObjectStub<GameRoom>, rationale: string) {
  const wolf = (await readGame(room)).players.find(p => p.role === "Werewolf")!.id;
  setLlmCall(async request => {
    const view = JSON.parse(JSON.parse(request.body).messages[1].content);
    return ok(JSON.stringify(view.phase === "discuss" ? { text: "I have doubts.", rationale }
      : { target: view.actor.role !== "Werewolf" ? wolf : view.allowedTargets.at(-1), rationale }));
  });
}

/** Plays a stubbed game to a village win; any archive alarm is left to the caller. */
export async function playToFinish(room: DurableObjectStub<GameRoom>, rationale: string) {
  await stubVillageWin(room, rationale);
  for (let i = 0; i < 40 && (await readGame(room)).status === "running"; i++) await runDurableObjectAlarm(room);
  expect((await readGame(room)).status).toBe("finished");
}
