import type { Game, Role } from "./engine";
import { buildRecord, type GameRecord, type TurnData } from "./record";

export type RecentGame = Pick<GameRecord, "id" | "status" | "winner" | "abortReason" | "model" | "days" | "endedAt">;

export const ARCHIVE_OUTCOMES = ["village", "werewolves", "aborted"] as const;
export type ArchiveOutcome = (typeof ARCHIVE_OUTCOMES)[number];
export const ARCHIVE_PAGE_SIZE = 25;
export const STANDARD_ROLES: readonly Role[] = ["Werewolf", "Seer", "Villager"];

export type ArchiveFilter = {
  model?: string;
  role?: string;
  outcome?: ArchiveOutcome;
  /** Inclusive UTC calendar date lower bound (`YYYY-MM-DD`). */
  from?: string;
  /** Inclusive UTC calendar date upper bound (`YYYY-MM-DD`). */
  to?: string;
};

export type ArchiveSeatSummary = {
  seat: string;
  role: string;
  model: string;
  survived: boolean;
};

export type ArchivedGameSummary = {
  id: string;
  status: GameRecord["status"];
  winner: GameRecord["winner"];
  abortReason: string | null;
  model: string;
  seatCount: number;
  days: number;
  turns: number;
  totalCostUsd: number | null;
  endedAt: number;
  players: ArchiveSeatSummary[];
};

export type ArchivePage = {
  games: ArchivedGameSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Distinct model ids present in `game_players`. */
  models: string[];
  /** Distinct role names present in `game_players`. */
  roles: string[];
};

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const POSITIVE_INT = /^[1-9]\d*$/;
const OUTCOME_SET = new Set<string>(ARCHIVE_OUTCOMES);
const MAX_ARCHIVE_PAGE_SIZE = 50;
// Keeps `(page - 1) * pageSize` within signed 32-bit integer range (and JS safe integers / SQLite INTEGER).
const MAX_SAFE_ARCHIVE_PAGE = Math.floor(2_147_483_647 / MAX_ARCHIVE_PAGE_SIZE);

/** Parses a `YYYY-MM-DD` UTC calendar date to epoch ms at 00:00:00.000Z, or null if invalid. */
export function parseUtcDateStart(value: string): number | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return ms;
}

/** Parses and validates archive browse query parameters; invalid enum/date/page values are ignored. */
export function parseArchiveQuery(params: URLSearchParams): { filter: ArchiveFilter; page: number } {
  const rawModel = params.get("model")?.trim() ?? "";
  const model = rawModel.length > 0 && rawModel.length <= 200 ? rawModel : undefined;
  const rawRole = params.get("role")?.trim() ?? "";
  const role = rawRole.length > 0 && rawRole.length <= 100 ? rawRole : undefined;
  const rawOutcome = params.get("outcome")?.trim() ?? "";
  const outcome = OUTCOME_SET.has(rawOutcome) ? (rawOutcome as ArchiveOutcome) : undefined;
  const rawFrom = params.get("from")?.trim() ?? "";
  const from = parseUtcDateStart(rawFrom) !== null ? rawFrom : undefined;
  const rawTo = params.get("to")?.trim() ?? "";
  const to = parseUtcDateStart(rawTo) !== null ? rawTo : undefined;
  const rawPage = params.get("page")?.trim() ?? "";
  const parsedPage = POSITIVE_INT.test(rawPage) ? Number(rawPage) : NaN;
  const page = Number.isSafeInteger(parsedPage) && parsedPage <= MAX_SAFE_ARCHIVE_PAGE ? parsedPage : 1;
  return {
    filter: {
      ...(model ? { model } : {}),
      ...(role ? { role } : {}),
      ...(outcome ? { outcome } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    },
    page,
  };
}

export function hasActiveArchiveFilters(filter: ArchiveFilter): boolean {
  return Boolean(filter.model || filter.role || filter.outcome || filter.from || filter.to);
}

/** Builds a clean query string (with leading `?`, or `""`) preserving active filters and page > 1. */
export function buildArchiveSearchParams(filter: ArchiveFilter, page = 1): string {
  const params = new URLSearchParams();
  if (filter.model) params.set("model", filter.model);
  if (filter.role) params.set("role", filter.role);
  if (filter.outcome) params.set("outcome", filter.outcome);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

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

type ArchiveGameDbRow = {
  id: string;
  status: GameRecord["status"];
  winner: GameRecord["winner"];
  abort_reason: string | null;
  model: string;
  seat_count: number;
  days: number;
  turns: number;
  total_cost_usd: number | null;
  ended_at: number;
};

type ArchiveSeatDbRow = {
  game_id: string;
  seat: string;
  role: string;
  model: string;
  survived: number;
};

/**
 * Lists archived games (newest first) filtered by model, role, outcome, and/or
 * UTC date range. When both `model` and `role` are given, a game matches only
 * if some seat played that model in that role. Never reads `state_json`.
 */
export async function listArchivedGames(
  db: D1Database,
  filter: ArchiveFilter = {},
  options: { page?: number; pageSize?: number } = {},
): Promise<ArchivePage> {
  const rawPageSize = options.pageSize ?? ARCHIVE_PAGE_SIZE;
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.min(Math.max(1, Math.trunc(rawPageSize)), MAX_ARCHIVE_PAGE_SIZE)
    : ARCHIVE_PAGE_SIZE;
  const rawPage = options.page ?? 1;
  let page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.trunc(rawPage) : 1;
  const safeOffset = Number.isSafeInteger(page) && page <= MAX_SAFE_ARCHIVE_PAGE ? (page - 1) * pageSize : null;

  const clauses: string[] = [];
  const binds: (string | number)[] = [];

  if (filter.model || filter.role) {
    const seatClauses = ["p.game_id = g.id"];
    if (filter.model) {
      seatClauses.push("p.model = ?");
      binds.push(filter.model);
    }
    if (filter.role) {
      seatClauses.push("p.role = ?");
      binds.push(filter.role);
    }
    clauses.push(`EXISTS (SELECT 1 FROM game_players p WHERE ${seatClauses.join(" AND ")})`);
  }

  if (filter.outcome === "village") {
    clauses.push("g.status = 'finished' AND g.winner = 'Village'");
  } else if (filter.outcome === "werewolves") {
    clauses.push("g.status = 'finished' AND g.winner = 'Werewolves'");
  } else if (filter.outcome === "aborted") {
    clauses.push("g.status = 'aborted'");
  }

  const fromMs = filter.from ? parseUtcDateStart(filter.from) : null;
  if (fromMs !== null) {
    clauses.push("g.ended_at >= ?");
    binds.push(fromMs);
  }

  const toMs = filter.to ? parseUtcDateStart(filter.to) : null;
  if (toMs !== null) {
    clauses.push("g.ended_at < ?");
    binds.push(toMs + DAY_MS);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const selectGamesSql =
    `SELECT g.id, g.status, g.winner, g.abort_reason, g.model, g.seat_count, g.days, g.turns, g.total_cost_usd, g.ended_at
     FROM games g ${where}
     ORDER BY g.ended_at DESC, g.id ASC
     LIMIT ? OFFSET ?`;

  let total: number;
  let gameRows: ArchiveGameDbRow[];
  let modelsRes: D1Result;
  let rolesRes: D1Result;

  if (safeOffset !== null) {
    const [countRes, gamesRes, mRes, rRes] = await db.batch([
      db.prepare(`SELECT COUNT(*) AS total FROM games g ${where}`).bind(...binds),
      db.prepare(selectGamesSql).bind(...binds, pageSize, safeOffset),
      db.prepare("SELECT DISTINCT model FROM game_players ORDER BY model"),
      db.prepare("SELECT DISTINCT role FROM game_players ORDER BY role"),
    ]);
    total = (countRes.results as { total: number }[])[0]?.total ?? 0;
    gameRows = gamesRes.results as ArchiveGameDbRow[];
    modelsRes = mRes;
    rolesRes = rRes;
  } else {
    const [countRes, mRes, rRes] = await db.batch([
      db.prepare(`SELECT COUNT(*) AS total FROM games g ${where}`).bind(...binds),
      db.prepare("SELECT DISTINCT model FROM game_players ORDER BY model"),
      db.prepare("SELECT DISTINCT role FROM game_players ORDER BY role"),
    ]);
    total = (countRes.results as { total: number }[])[0]?.total ?? 0;
    gameRows = [];
    modelsRes = mRes;
    rolesRes = rRes;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) {
    page = 1;
  } else if (safeOffset === null || page > totalPages) {
    page = Math.min(page, totalPages);
    const retry = await db.prepare(selectGamesSql).bind(...binds, pageSize, (page - 1) * pageSize).all<ArchiveGameDbRow>();
    gameRows = retry.results;
  }

  const playersByGame = new Map<string, ArchiveSeatSummary[]>();
  if (gameRows.length > 0) {
    const placeholders = gameRows.map(() => "?").join(", ");
    const seatRes = await db.prepare(
      `SELECT game_id, seat, role, model, survived
       FROM game_players
       WHERE game_id IN (${placeholders})
       ORDER BY game_id, seat`,
    ).bind(...gameRows.map(g => g.id)).all<ArchiveSeatDbRow>();
    for (const row of seatRes.results) {
      let list = playersByGame.get(row.game_id);
      if (!list) {
        list = [];
        playersByGame.set(row.game_id, list);
      }
      list.push({ seat: row.seat, role: row.role, model: row.model, survived: row.survived === 1 });
    }
  }

  return {
    games: gameRows.map(r => ({
      id: r.id,
      status: r.status,
      winner: r.winner,
      abortReason: r.abort_reason,
      model: r.model,
      seatCount: r.seat_count,
      days: r.days,
      turns: r.turns,
      totalCostUsd: r.total_cost_usd,
      endedAt: r.ended_at,
      players: playersByGame.get(r.id) ?? [],
    })),
    total,
    page,
    pageSize,
    totalPages,
    models: (modelsRes.results as { model: string }[]).map(r => r.model),
    roles: (rolesRes.results as { role: string }[]).map(r => r.role),
  };
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
