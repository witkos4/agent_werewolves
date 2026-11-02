import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("archive schema", () => {
  it("has the three archive tables", async () => {
    const { results } = await env.ARCHIVE.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('games', 'game_players', 'game_moves') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual(["game_moves", "game_players", "games"]);
  });

  it("only accepts terminal statuses", async () => {
    const insert = (status: string) => env.ARCHIVE.prepare(
      `INSERT INTO games (id, status, model, discussion_passes, seat_count, days, turns, unknown_cost_turns,
         reserved_usd, created_at, ended_at, archived_at, engine_version, state_json)
       VALUES (?, ?, 'm', 1, 5, 1, 1, 0, 0, 0, 0, 0, 1, '{}')`,
    ).bind(crypto.randomUUID(), status).run();
    await expect(insert("running")).rejects.toThrow(/CHECK constraint/);
    await expect(insert("finished")).resolves.toBeTruthy();
  });
});
