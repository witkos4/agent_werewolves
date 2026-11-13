import { env } from "cloudflare:workers";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { cloudflareContext } from "../app/cloudflare-context";
import { loader } from "../app/routes/metrics";
import { writeArchive } from "../workers/game/archive";
import { applyMove, createGame } from "../workers/game/engine";
import { buildRecord } from "../workers/game/record";
import { gate } from "../workers/gate";

const G = "google/gemini-3.1-flash-lite";

function args(path: string, routeEnv: Env = env) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: routeEnv, ctx: {} as ExecutionContext });
  const request = new Request(`https://example.test${path}`);
  return { request, context, params: {}, url: new URL(request.url), pattern: path } as never;
}
async function page(path: string, routeEnv?: Env) {
  return (await loader(args(path, routeEnv)) as unknown as { data: Awaited<ReturnType<typeof loader>>["data"] }).data;
}

/** A 6-seat game (no other test uses 6 seats) that aborts after the Seer and one wolf act. */
async function seedAbortedSixSeatGame() {
  const id = crypto.randomUUID();
  let game = createGame(id, 1, 100, { seats: Array.from({ length: 6 }, (_, i) => ({ model: G, persona: ["analyst", "accuser", "diplomat", "contrarian", "storyteller", "cautious"][i] })), pool: [] }, n => n - 1);
  game = applyMove(applyMove(game, { target: "p1", rationale: "r" }), { target: "p4", rationale: "r" });
  game = { ...game, status: "aborted", abortReason: "provider_error" };
  const turns = [1, 2].map(turnNo => ({ turnNo, costUsd: 0.001, latencyMs: 50, attempts: 1, generationId: "g" }));
  await writeArchive(env.ARCHIVE, buildRecord(game, turns, { endedAt: 1, reservedUsd: 0 }), JSON.stringify(game), 1);
}

describe("metrics page", () => {
  it("filters by a seat count present in the archive and ignores any other value", async () => {
    await seedAbortedSixSeatGame();
    const six = await page("/metrics?seats=6");
    expect(six).toMatchObject({ seats: 6, error: false });
    expect(six.metrics!.seatCounts).toContain(6);
    expect(six.metrics!.finishedGames).toBe(0);
    expect(six.metrics!.cost.byStatus.find(s => s.status === "aborted")!.games).toBeGreaterThanOrEqual(1);
    expect(six.metrics!.winRate.byModel).toEqual([]);
    for (const path of ["/metrics", "/metrics?seats=42", "/metrics?seats=abc", "/metrics?seats="]) {
      const all = await page(path);
      expect(all.seats).toBeNull();
      expect(all.metrics!.seatCounts).toEqual(six.metrics!.seatCounts);
    }
  });

  it("shows an error notice instead of failing when the archive is unreachable", async () => {
    const broken = { ...env, ARCHIVE: { prepare() { throw new Error("D1 down"); } } } as unknown as Env;
    expect(await page("/metrics", broken)).toEqual({ metrics: null, seats: null, error: true });
  });

  it("sits behind the access key", async () => {
    const refused = await gate(new Request("https://example.test/metrics?seats=8"), env);
    expect(refused?.status).toBe(302);
    expect(refused?.headers.get("Location")).toBe(`/login?next=${encodeURIComponent("/metrics?seats=8")}`);
  });
});
