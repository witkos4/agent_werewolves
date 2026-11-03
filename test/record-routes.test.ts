import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflareContext } from "../app/cloudflare-context";
import { loader as gameLoader } from "../app/routes/games.$gameId";
import { loader as homeLoader } from "../app/routes/home";
import { archiveTuning, liveTuning } from "../workers/game/runtime";
import { setLlmCall, type LlmCall } from "../workers/llm/client";
import { catalog, ok, playToFinish, startLiveGame, stubVillageWin } from "./live-helpers";

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

// Call the route modules directly; the React Router build is not in the test entry.
function args(path: string, params: Record<string, string> = {}, routeEnv: Env = env) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: routeEnv, ctx: {} as ExecutionContext });
  const request = new Request(`https://example.test${path}`);
  return { request, context, params, url: new URL(request.url), pattern: path } as never;
}
async function gamePage(id: string) {
  const result = await gameLoader(args(`/games/${id}`, { gameId: id }));
  return (result as unknown as { data: Awaited<ReturnType<typeof gameLoader>>["data"] }).data;
}

describe("game record page", () => {
  it("shows an archived game's record from D1 with rationale and roles", async () => {
    const { room, id } = await startLiveGame();
    await playToFinish(room, "route-rationale");
    await runDurableObjectAlarm(room); // Archive.
    const page = await gamePage(id);
    expect(page).toMatchObject({ kind: "record", archived: true, record: { id, status: "finished", winner: "Village" } });
    if (page.kind !== "record") throw new Error("expected a record");
    expect(page.record.players.every(p => p.role)).toBe(true);
    expect(page.record.timeline.some(i => i.kind === "speech" && i.rationale === "route-rationale")).toBe(true);
    expect(page.record.timeline.some(i => i.kind === "night")).toBe(true);
  });

  it("renders an unarchived terminal game from the room, marked as archiving", async () => {
    const { room, id } = await startLiveGame();
    await runDurableObjectAlarm(room); // Invalid output aborts; archive alarm is an hour out.
    expect(await gamePage(id)).toMatchObject({ kind: "record", archived: false, record: { status: "aborted", abortReason: "invalid_model_response" } });
  });

  it("falls back to the room when the archive read fails", async () => {
    const { room, id } = await startLiveGame();
    await playToFinish(room, "fallback-rationale");
    await runDurableObjectAlarm(room);
    vi.spyOn(env.ARCHIVE, "batch").mockRejectedValueOnce(new Error("D1 down"));
    expect(await gamePage(id)).toMatchObject({ kind: "record", archived: true, record: { status: "finished" } });
  });

  it("keeps a running game on the live viewer with no private data", async () => {
    const { room, id } = await startLiveGame();
    await stubVillageWin(room, "running-secret-rationale");
    await runDurableObjectAlarm(room); // Seer's private investigation.
    await runDurableObjectAlarm(room); // Wolf's private kill.
    const page = await gamePage(id);
    expect(page.kind).toBe("live");
    const serialized = JSON.stringify(page);
    for (const secret of ["running-secret-rationale", "privateMoves", "investigations", "Werewolf", "Seer"]) expect(serialized).not.toContain(secret);
  });

  it("returns 404 for unknown and invalid ids", async () => {
    for (const id of ["not-a-uuid", crypto.randomUUID()]) {
      await expect(gameLoader(args(`/games/${id}`, { gameId: id }))).rejects.toMatchObject({ status: 404 });
    }
  });
});

describe("home recent games", () => {
  it("lists the newest 20 archived games, newest first", async () => {
    const base = 9_000_000_000_000;
    for (let i = 0; i < 22; i++) {
      await env.ARCHIVE.prepare(
        `INSERT INTO games (id, status, winner, model, discussion_passes, seat_count, days, turns, unknown_cost_turns,
           reserved_usd, created_at, ended_at, archived_at, engine_version, state_json)
         VALUES (?, 'finished', 'Village', 'test/model', 1, 5, 1, 1, 0, 0, 0, ?, 0, 1, '{}')`,
      ).bind(crypto.randomUUID(), base + i).run();
    }
    const { data } = await homeLoader(args("/")) as unknown as { data: { recent: { endedAt: number }[] } };
    expect(data.recent).toHaveLength(20);
    expect(data.recent.map(g => g.endedAt)).toEqual(Array.from({ length: 20 }, (_, i) => base + 21 - i));
  });

  it("still renders the start form when the archive is unavailable", async () => {
    const broken = { ...env, ARCHIVE: { prepare() { throw new Error("D1 down"); } } } as unknown as Env;
    const { data } = await homeLoader(args("/", {}, broken)) as unknown as { data: { recent: unknown; requestId: string } };
    expect(data.recent).toBeNull();
    expect(data.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
