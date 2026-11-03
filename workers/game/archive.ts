import type { Game } from "./engine";
import { buildRecord, type GameRecord, type TurnData } from "./record";

export type RecentGame = Pick<GameRecord, "id" | "status" | "winner" | "abortReason" | "model" | "days" | "endedAt">;

/**
 * One atomic batch of idempotent inserts. A terminal game never changes, so a
 * repeated write (the room crashed after D1 committed) is a no-op.
 */
export async function writeArchive(db: D1Database, record: GameRecord, stateJson: string, archivedAt: number): Promise<void> {
  const r = record;
  await db.batch([
    db.prepare(
      `INSERT INTO games (id, status, winner, abort_reason, model, discussion_passes, seat_count, days, turns,
         total_cost_usd, unknown_cost_turns, reserved_usd, created_at, ended_at, archived_at, engine_version, state_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).bind(r.id, r.status, r.winner, r.abortReason, r.model, r.discussionPasses, r.players.length, r.days, r.turns,
      r.totalCostUsd, r.unknownCostTurns, r.reservedUsd, r.createdAt, r.endedAt, archivedAt, r.engineVersion, stateJson),
    ...r.players.map(p => db.prepare(
      `INSERT INTO game_players (game_id, seat, name, role, model, survived) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, seat) DO NOTHING`,
    ).bind(r.id, p.seat, p.name, p.role, p.model, p.survived ? 1 : 0)),
    ...r.moves.map(m => db.prepare(
      `INSERT INTO game_moves (game_id, turn_no, day, phase, actor, text, target, result_role, rationale,
         cost_usd, latency_ms, attempts, generation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, turn_no) DO NOTHING`,
    ).bind(r.id, m.turnNo, m.day, m.phase, m.actor, m.text, m.target, m.resultRole, m.rationale,
      m.costUsd, m.latencyMs, m.attempts, m.generationId)),
  ]);
}

/** Rebuilt through the same projection the room uses, from the archived state and moves. */
export async function readArchivedRecord(db: D1Database, id: string): Promise<GameRecord | null> {
  const [games, moves] = await db.batch([
    db.prepare("SELECT state_json, ended_at, reserved_usd FROM games WHERE id = ?").bind(id),
    db.prepare("SELECT turn_no, cost_usd, latency_ms, attempts, generation_id FROM game_moves WHERE game_id = ? ORDER BY turn_no").bind(id),
  ]);
  const row = (games.results as { state_json: string; ended_at: number; reserved_usd: number }[])[0];
  if (!row) return null;
  const turns = (moves.results as { turn_no: number; cost_usd: number | null; latency_ms: number | null; attempts: number; generation_id: string | null }[])
    .map((m): TurnData => ({ turnNo: m.turn_no, costUsd: m.cost_usd, latencyMs: m.latency_ms, attempts: m.attempts, generationId: m.generation_id }));
  return buildRecord(JSON.parse(row.state_json) as Game, turns, { endedAt: row.ended_at, reservedUsd: row.reserved_usd });
}

export async function listRecentGames(db: D1Database, limit = 20): Promise<RecentGame[]> {
  const { results } = await db.prepare(
    "SELECT id, status, winner, abort_reason, model, days, ended_at FROM games ORDER BY ended_at DESC, id LIMIT ?",
  ).bind(limit).all<{ id: string; status: GameRecord["status"]; winner: GameRecord["winner"]; abort_reason: string | null; model: string; days: number; ended_at: number }>();
  return results.map(r => ({ id: r.id, status: r.status, winner: r.winner, abortReason: r.abort_reason, model: r.model, days: r.days, endedAt: r.ended_at }));
}
