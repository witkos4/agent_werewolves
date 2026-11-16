import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batchTuning } from "../workers/batch-room";
import { handleBatchRequest } from "../workers/batch/routes";
import { MODELS } from "../workers/game/catalog";

const HOUR = 3600_000;
const defaults = { ...batchTuning };
beforeEach(() => { Object.assign(batchTuning, { firstPassDelayMs: HOUR, pollMs: HOUR }); });
afterEach(() => { Object.assign(batchTuning, defaults); });

const auth = { Authorization: `Bearer ${env.ACCESS_KEY}` };
const body = (patch: Record<string, unknown> = {}) => JSON.stringify({
  requestId: crypto.randomUUID(), mode: "rotation", pool: [MODELS[0].id], gameCount: 2, discussionPasses: 1, spendLimitUsd: 1, gameLimitUsd: 0.5, ...patch,
});
const post = (path: string, init: RequestInit = {}) => SELF.fetch(`https://example.test/api/batches/${path}`, { method: "POST", ...init, headers: { ...auth, ...init.headers } });

describe("batch API", () => {
  it("requires the access key for every batch route", async () => {
    const id = crypto.randomUUID();
    for (const [path, init] of [["start", { method: "POST", body: body() }], [id, {}], [`${id}/cancel`, { method: "POST" }]] as const) {
      expect((await SELF.fetch(`https://example.test/api/batches/${path}`, init)).status).toBe(404);
    }
  });

  it("starts a batch with the Bearer key, idempotently, and serves and cancels it", async () => {
    const payload = body();
    const response = await post("start", { body: payload });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { batchId, batchUrl } = await response.json() as { batchId: string; batchUrl: string };
    expect(batchId).toBe(JSON.parse(payload).requestId);
    expect(batchUrl).toBe(`/batches/${batchId}`);
    expect((await post("start", { body: payload })).status).toBe(200);
    expect((await post("start", { body: JSON.stringify({ ...JSON.parse(payload), gameCount: 3 }) })).status).toBe(409);

    const snapshot = await SELF.fetch(`https://example.test/api/batches/${batchId}`, { headers: auth });
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ id: batchId, status: "running", slots: [{ status: "pending" }, { status: "pending" }] });
    const cancelled = await post(`${batchId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: "cancelling" });
  });

  it("validates input and blocks cross-origin writes", async () => {
    for (const patch of [{ gameCount: 1 }, { gameCount: 21 }, { spendLimitUsd: 0.05 }, { spendLimitUsd: 20.5 }, { gameLimitUsd: 2 }, { requestId: "nope" }, { pool: [] }, { mode: "other" }, { extra: true }]) {
      const response = await post("start", { body: body(patch) });
      expect(response.status, JSON.stringify(patch)).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }
    expect((await post("start", { body: "[]" })).status).toBe(400);
    expect((await post("start", { body: "x".repeat(5000) })).status).toBe(413);
    expect((await handleBatchRequest(new Request("https://example.test/api/batches/start", { method: "POST", headers: { Origin: "https://evil.test" }, body: body() }), env))?.status).toBe(403);
    expect((await handleBatchRequest(new Request(`https://example.test/api/batches/${crypto.randomUUID()}/cancel`, { method: "POST", headers: { Origin: "https://evil.test" } }), env))?.status).toBe(403);
  });

  it("returns 404 for unknown batches and paths, and ignores other routes", async () => {
    const id = crypto.randomUUID();
    expect((await SELF.fetch(`https://example.test/api/batches/${id}`, { headers: auth })).status).toBe(404);
    expect((await post(`${id}/cancel`)).status).toBe(404);
    expect((await SELF.fetch("https://example.test/api/batches/nope", { headers: auth })).status).toBe(404);
    expect(await handleBatchRequest(new Request("https://example.test/api/games/start"), env)).toBeNull();
  });
});
