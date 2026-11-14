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
         total_cost_usd, unknown_cost_turns, reserved_usd, spend_limit_usd, charged_usd, created_at, ended_at, archived_at, engine_version, state_json, batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    ).bind(r.id, r.status, r.winner, r.abortReason, r.model, r.discussionPasses, r.players.length, r.days, r.turns,
      r.totalCostUsd, r.unknownCostTurns, r.reservedUsd, r.spendLimitUsd, r.chargedUsd, r.createdAt, r.endedAt, archivedAt, r.engineVersion, stateJson, r.batchId),
    ...r.players.map(p => db.prepare(
      `INSERT INTO game_players (game_id, seat, name, role, model, persona, survived, died_day, died_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, seat) DO NOTHING`,
    ).bind(r.id, p.seat, p.name, p.role, p.model, p.persona, p.survived ? 1 : 0, p.diedDay, p.diedBy)),
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
    db.prepare("SELECT state_json, ended_at, reserved_usd, charged_usd FROM games WHERE id = ?").bind(id),
    db.prepare("SELECT turn_no, cost_usd, latency_ms, attempts, generation_id FROM game_moves WHERE game_id = ? ORDER BY turn_no").bind(id),
  ]);
  const row = (games.results as { state_json: string; ended_at: number; reserved_usd: number; charged_usd: number | null }[])[0];
  if (!row) return null;
  const turns = (moves.results as { turn_no: number; cost_usd: number | null; latency_ms: number | null; attempts: number; generation_id: string | null }[])
    .map((m): TurnData => ({ turnNo: m.turn_no, costUsd: m.cost_usd, latencyMs: m.latency_ms, attempts: m.attempts, generationId: m.generation_id }));
  return buildRecord(JSON.parse(row.state_json) as Game, turns, { endedAt: row.ended_at, reservedUsd: row.reserved_usd, chargedUsd: row.charged_usd });
}

/** Single games only: batch games are reached through their batch. */
export async function listRecentGames(db: D1Database, limit = 20): Promise<RecentGame[]> {
  const { results } = await db.prepare(
    "SELECT id, status, winner, abort_reason, model, days, ended_at FROM games WHERE batch_id IS NULL ORDER BY ended_at DESC, id LIMIT ?",
  ).bind(limit).all<{ id: string; status: GameRecord["status"]; winner: GameRecord["winner"]; abort_reason: string | null; model: string; days: number; ended_at: number }>();
  return results.map(r => ({ id: r.id, status: r.status, winner: r.winner, abortReason: r.abort_reason, model: r.model, days: r.days, endedAt: r.ended_at }));
}

/** One `batches` row, the D1 copy of a BatchRoom (S-09). */
export type BatchRow = {
  id: string;
  status: string;
  mode: string;
  gameCount: number;
  discussionPasses: number;
  spendLimitUsd: number;
  gameLimitUsd: number;
  chargedUsd: number;
  createdAt: number;
  endedAt: number | null;
  /** Grows with every change in the room; an older version never overwrites a newer one. */
  version: number;
  summaryJson: string;
};

export async function upsertBatch(db: D1Database, b: BatchRow): Promise<void> {
  await db.prepare(
    `INSERT INTO batches (id, status, mode, game_count, discussion_passes, spend_limit_usd, game_limit_usd, charged_usd, created_at, ended_at, version, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET status = excluded.status, charged_usd = excluded.charged_usd, ended_at = excluded.ended_at,
       version = excluded.version, summary_json = excluded.summary_json
     WHERE excluded.version > batches.version`,
  ).bind(b.id, b.status, b.mode, b.gameCount, b.discussionPasses, b.spendLimitUsd, b.gameLimitUsd, b.chargedUsd, b.createdAt, b.endedAt, b.version, b.summaryJson).run();
}

type BatchDbRow = { id: string; status: string; mode: string; game_count: number; discussion_passes: number; spend_limit_usd: number;
  game_limit_usd: number; charged_usd: number; created_at: number; ended_at: number | null; version: number; summary_json: string };
const toBatchRow = (r: BatchDbRow): BatchRow => ({ id: r.id, status: r.status, mode: r.mode, gameCount: r.game_count, discussionPasses: r.discussion_passes,
  spendLimitUsd: r.spend_limit_usd, gameLimitUsd: r.game_limit_usd, chargedUsd: r.charged_usd, createdAt: r.created_at, endedAt: r.ended_at,
  version: r.version, summaryJson: r.summary_json });

export async function readBatch(db: D1Database, id: string): Promise<BatchRow | null> {
  const row = await db.prepare("SELECT * FROM batches WHERE id = ?").bind(id).first<BatchDbRow>();
  return row ? toBatchRow(row) : null;
}

/** Newest first. */
export async function listBatches(db: D1Database, limit = 20): Promise<BatchRow[]> {
  const { results } = await db.prepare("SELECT * FROM batches ORDER BY created_at DESC, id LIMIT ?").bind(limit).all<BatchDbRow>();
  return results.map(toBatchRow);
}
