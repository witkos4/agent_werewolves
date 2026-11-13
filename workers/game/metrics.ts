import type { Role } from "./engine";

/**
 * S-08 metrics, computed from the D1 archive. Definitions are pinned in
 * context/changes/game-metrics/plan.md ("Metric definitions").
 *
 * The queries return game-granular rows (a few per game, never `state_json`),
 * and `computeMetrics` rolls them up, so every figure can count its distinct
 * games exactly, whatever the grouping.
 */

/** A ratio with what it is based on. `value` is null when `denominator` is 0. */
export type Figure = { value: number | null; numerator: number; denominator: number; games: number };

export type MetricFilter = { seats?: number };

export type MetricRows = {
  seatCounts: number[];
  /** Finished games: seats and wins per game, model and role. */
  seats: { game_id: string; model: string; role: Role; seats: number; wins: number }[];
  /** Finished games: day votes by non-wolf seats per game and voter model. */
  votes: { game_id: string; model: string; votes: number; on_wolf: number }[];
  /** Finished games: village eliminations per game. */
  eliminations: { game_id: string; eliminations: number; wolves: number }[];
  /** Finished games: one row per seat, with its voting rounds alive and the non-wolf votes it drew. */
  rounds: { game_id: string; seat: string; model: string; role: Role; died_by: "night" | "village" | null; rounds_held: number; seat_rounds: number; votes_received: number }[];
  /** Every archived game: committed turns per game and acting model. */
  turns: { game_id: string; model: string; turns: number; known_turns: number; cost_usd: number; latency_turns: number; latency_ms: number }[];
  /** Every archived game. */
  games: { id: string; status: "finished" | "aborted"; turns: number; total_cost_usd: number | null }[];
};

export type ModelFigure = { model: string; figure: Figure };

export type Metrics = {
  seatCounts: number[];
  finishedGames: number;
  winRate: { byModel: ModelFigure[]; byModelRole: (ModelFigure & { role: Role })[] };
  voteAccuracy: { perVote: Figure; perVoteByModel: ModelFigure[]; perElimination: Figure };
  /** Per wolf model; `model` null is every wolf. */
  deception: {
    model: string | null;
    /** Mean day rounds survived per wolf seat. */
    survival: Figure;
    /** Mean day rounds held in the games behind `survival`, for scale. */
    roundsHeld: number | null;
    misdirected: Figure;
    /** Non-wolf votes drawn per seat-round, by the wolves and by innocents at the same tables. */
    wolfRate: Figure;
    innocentRate: Figure;
    /** wolfRate / innocentRate; below 1 means the wolves drew less suspicion. */
    suspicionRatio: number | null;
  }[];
  cost: {
    byModel: { model: string; turns: number; unknownCostTurns: number; costUsd: number; costPerTurnUsd: number | null; meanLatencyMs: number | null; games: number }[];
    byStatus: { status: "finished" | "aborted"; games: number; meanCostUsd: number | null; unknownCostGames: number; meanTurns: number | null }[];
  };
};

export async function loadMetrics(db: D1Database, filter: MetricFilter = {}): Promise<Metrics> {
  return computeMetrics(await readMetricRows(db, filter));
}

// `?1` is the seat-count filter, or NULL for every table size.
const IN_SCOPE = "(?1 IS NULL OR g.seat_count = ?1)";
const FINISHED = `g.status = 'finished' AND ${IN_SCOPE}`;

export async function readMetricRows(db: D1Database, { seats }: MetricFilter = {}): Promise<MetricRows> {
  const seatFilter = seats ?? null;
  const q = (sql: string) => db.prepare(sql).bind(seatFilter);
  const [seatCounts, seatRows, votes, eliminations, rounds, turns, games] = await db.batch([
    db.prepare("SELECT DISTINCT seat_count FROM games ORDER BY seat_count"),
    q(`SELECT p.game_id, p.model, p.role, COUNT(*) AS seats,
         SUM(CASE WHEN (p.role = 'Werewolf') = (g.winner = 'Werewolves') THEN 1 ELSE 0 END) AS wins
       FROM game_players p JOIN games g ON g.id = p.game_id
       WHERE ${FINISHED} GROUP BY p.game_id, p.model, p.role`),
    q(`SELECT m.game_id, v.model, COUNT(*) AS votes, SUM(CASE WHEN t.role = 'Werewolf' THEN 1 ELSE 0 END) AS on_wolf
       FROM game_moves m JOIN games g ON g.id = m.game_id
         JOIN game_players v ON v.game_id = m.game_id AND v.seat = m.actor
         JOIN game_players t ON t.game_id = m.game_id AND t.seat = m.target
       WHERE m.phase = 'vote' AND v.role <> 'Werewolf' AND ${FINISHED} GROUP BY m.game_id, v.model`),
    q(`SELECT p.game_id, COUNT(*) AS eliminations, SUM(CASE WHEN p.role = 'Werewolf' THEN 1 ELSE 0 END) AS wolves
       FROM game_players p JOIN games g ON g.id = p.game_id
       WHERE p.died_by = 'village' AND ${FINISHED} GROUP BY p.game_id`),
    // A seat is alive when a round's voting begins unless it died on an earlier
    // day, or during that day's night.
    q(`WITH rounds AS (SELECT DISTINCT m.game_id, m.day FROM game_moves m JOIN games g ON g.id = m.game_id WHERE m.phase = 'vote' AND ${FINISHED})
       SELECT p.game_id, p.seat, p.model, p.role, p.died_by,
         (SELECT COUNT(*) FROM rounds r WHERE r.game_id = p.game_id) AS rounds_held,
         (SELECT COUNT(*) FROM rounds r WHERE r.game_id = p.game_id
            AND (p.died_day IS NULL OR r.day < p.died_day OR (r.day = p.died_day AND p.died_by = 'village'))) AS seat_rounds,
         (SELECT COUNT(*) FROM game_moves m JOIN game_players v ON v.game_id = m.game_id AND v.seat = m.actor
            WHERE m.game_id = p.game_id AND m.phase = 'vote' AND m.target = p.seat AND v.role <> 'Werewolf') AS votes_received
       FROM game_players p JOIN games g ON g.id = p.game_id WHERE ${FINISHED}`),
    q(`SELECT m.game_id, p.model, COUNT(*) AS turns, COUNT(m.cost_usd) AS known_turns, COALESCE(SUM(m.cost_usd), 0) AS cost_usd,
         COUNT(m.latency_ms) AS latency_turns, COALESCE(SUM(m.latency_ms), 0) AS latency_ms
       FROM game_moves m JOIN games g ON g.id = m.game_id JOIN game_players p ON p.game_id = m.game_id AND p.seat = m.actor
       WHERE ${IN_SCOPE} GROUP BY m.game_id, p.model`),
    q(`SELECT g.id, g.status, g.turns, g.total_cost_usd FROM games g WHERE ${IN_SCOPE}`),
  ]);
  return {
    seatCounts: (seatCounts.results as { seat_count: number }[]).map(r => r.seat_count),
    seats: seatRows.results as MetricRows["seats"],
    votes: votes.results as MetricRows["votes"],
    eliminations: eliminations.results as MetricRows["eliminations"],
    rounds: rounds.results as MetricRows["rounds"],
    turns: turns.results as MetricRows["turns"],
    games: games.results as MetricRows["games"],
  };
}

/** Sums numerator and denominator over rows and counts the distinct games that add to the denominator. */
function figure<T extends { game_id: string }>(rows: T[], numerator: (r: T) => number, denominator: (r: T) => number): Figure {
  let n = 0, d = 0;
  const games = new Set<string>();
  for (const r of rows) {
    const rd = denominator(r);
    n += numerator(r);
    d += rd;
    if (rd > 0) games.add(r.game_id);
  }
  return { value: d > 0 ? n / d : null, numerator: n, denominator: d, games: games.size };
}

const byModel = <T extends { model: string }>(rows: T[]) => [...new Set(rows.map(r => r.model))].sort();
const mean = (sum: number, count: number) => count > 0 ? sum / count : null;

export function computeMetrics(rows: MetricRows): Metrics {
  const wolfModels = byModel(rows.rounds.filter(r => r.role === "Werewolf"));
  return {
    seatCounts: rows.seatCounts,
    finishedGames: rows.games.filter(g => g.status === "finished").length,
    winRate: {
      byModel: byModel(rows.seats).map(model => ({ model, figure: figure(rows.seats.filter(r => r.model === model), r => r.wins, r => r.seats) })),
      byModelRole: byModel(rows.seats).flatMap(model => [...new Set(rows.seats.filter(r => r.model === model).map(r => r.role))].sort().map(role => ({
        model, role, figure: figure(rows.seats.filter(r => r.model === model && r.role === role), r => r.wins, r => r.seats),
      }))),
    },
    voteAccuracy: {
      perVote: figure(rows.votes, r => r.on_wolf, r => r.votes),
      perVoteByModel: byModel(rows.votes).map(model => ({ model, figure: figure(rows.votes.filter(r => r.model === model), r => r.on_wolf, r => r.votes) })),
      perElimination: figure(rows.eliminations, r => r.wolves, r => r.eliminations),
    },
    deception: [...wolfModels, null].map(model => deception(rows, model)),
    cost: {
      byModel: byModel(rows.turns).map(model => {
        const own = rows.turns.filter(r => r.model === model);
        const sum = (f: (r: MetricRows["turns"][number]) => number) => own.reduce((s, r) => s + f(r), 0);
        const known = sum(r => r.known_turns);
        return {
          model, turns: sum(r => r.turns), unknownCostTurns: sum(r => r.turns - r.known_turns), costUsd: sum(r => r.cost_usd),
          costPerTurnUsd: mean(sum(r => r.cost_usd), known), meanLatencyMs: mean(sum(r => r.latency_ms), sum(r => r.latency_turns)),
          games: new Set(own.map(r => r.game_id)).size,
        };
      }),
      byStatus: (["finished", "aborted"] as const).map(status => {
        const games = rows.games.filter(g => g.status === status);
        const known = games.filter(g => g.total_cost_usd !== null);
        return {
          status, games: games.length,
          meanCostUsd: mean(known.reduce((s, g) => s + g.total_cost_usd!, 0), known.length),
          unknownCostGames: games.length - known.length,
          meanTurns: mean(games.reduce((s, g) => s + g.turns, 0), games.length),
        };
      }),
    },
  };
}

function deception(rows: MetricRows, model: string | null): Metrics["deception"][number] {
  // Wolves are never night targets; a wolf with a night death is bad data and is left out.
  const wolves = rows.rounds.filter(r => r.role === "Werewolf" && r.died_by !== "night" && (model === null || r.model === model));
  const tables = new Set(wolves.map(r => r.game_id));
  const innocents = rows.rounds.filter(r => r.role !== "Werewolf" && tables.has(r.game_id));
  const survival = figure(wolves.map(r => ({ ...r, one: 1 })), r => r.seat_rounds - (r.died_by === "village" ? 1 : 0), r => r.one);
  const heldPerGame = new Map(wolves.map(r => [r.game_id, r.rounds_held]));
  const wolfRate = figure(wolves, r => r.votes_received, r => r.seat_rounds);
  const innocentRate = figure(innocents, r => r.votes_received, r => r.seat_rounds);
  const votes = rows.votes.filter(r => tables.has(r.game_id));
  return {
    model, survival,
    roundsHeld: mean([...heldPerGame.values()].reduce((s, n) => s + n, 0), heldPerGame.size),
    misdirected: figure(votes, r => r.votes - r.on_wolf, r => r.votes),
    wolfRate, innocentRate,
    suspicionRatio: wolfRate.value !== null && innocentRate.value ? wolfRate.value / innocentRate.value : null,
  };
}
