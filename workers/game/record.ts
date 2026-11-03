import type { Game, Phase, Role } from "./engine";

/** Provider data for one committed move, from `live_turns` or `game_moves`. */
export type TurnData = {
  turnNo: number;
  costUsd: number | null;
  latencyMs: number | null;
  attempts: number;
  generationId: string | null;
};

/** One row of `game_moves`: a move, its private rationale and what it cost. */
export type RecordMove = {
  turnNo: number;
  day: number;
  phase: Phase;
  actor: string;
  text: string | null;
  target: string | null;
  /** The role a Seer learned; investigations only. */
  resultRole: Role | null;
  rationale: string;
  costUsd: number | null;
  latencyMs: number | null;
  attempts: number;
  generationId: string | null;
};

export type RecordPlayer = { seat: string; name: string; role: Role; model: string; survived: boolean };

/** The game in reading order: public entries with their rationale, private night actions inline. */
export type TimelineItem =
  | { kind: "phase" | "death" | "votes"; day: number; text: string }
  | { kind: "speech"; day: number; turnNo: number; actor: string; text: string; rationale: string }
  | { kind: "vote"; day: number; turnNo: number; actor: string; target: string; rationale: string }
  | { kind: "night"; day: number; turnNo: number; actor: string; action: "investigate" | "kill"; target: string; resultRole: Role | null; rationale: string };

export type GameRecord = {
  id: string;
  status: "finished" | "aborted";
  winner: Game["winner"];
  abortReason: string | null;
  model: string;
  discussionPasses: number;
  days: number;
  turns: number;
  /** Sum of known per-turn costs; null when no turn reported one. */
  totalCostUsd: number | null;
  unknownCostTurns: number;
  reservedUsd: number;
  createdAt: number;
  endedAt: number;
  engineVersion: number;
  players: RecordPlayer[];
  moves: RecordMove[];
  timeline: TimelineItem[];
};

/**
 * The single projection both read paths use (the room before archiving, D1
 * after), so a game renders identically from either. Terminal games only.
 */
export function buildRecord(
  game: Game,
  turns: TurnData[],
  { endedAt, reservedUsd }: { endedAt: number; reservedUsd: number },
): GameRecord {
  if (game.status === "running") throw new Error("record_of_running_game");
  const seats = new Set(game.players.map(p => p.id));
  const byTurn = new Map(turns.map(t => [t.turnNo, t]));

  const investigations = [...game.investigations];
  // privateMoves[i] is the move of turn i + 1: the engine increments `turn` once per move.
  const moves = game.privateMoves.map((move, i): RecordMove => {
    if (!seats.has(move.actor)) throw new Error(`record_unknown_actor: ${move.actor}`);
    let resultRole: Role | null = null;
    if (move.phase === "investigate") {
      const found = investigations.shift();
      if (!found || found.actor !== move.actor || found.target !== move.move.target) throw new Error("record_investigation_mismatch");
      resultRole = found.role;
    }
    const turn = byTurn.get(i + 1);
    return {
      turnNo: i + 1, day: move.day, phase: move.phase, actor: move.actor,
      text: move.move.text ?? null, target: move.move.target ?? null, resultRole,
      rationale: move.move.rationale,
      costUsd: turn?.costUsd ?? null, latencyMs: turn?.latencyMs ?? null,
      attempts: turn?.attempts ?? 0, generationId: turn?.generationId ?? null,
    };
  });

  const known = moves.filter(m => m.costUsd !== null);
  return {
    id: game.id,
    status: game.status,
    winner: game.winner,
    abortReason: game.abortReason,
    model: game.model,
    discussionPasses: game.discussionPasses,
    days: game.day,
    turns: moves.length,
    totalCostUsd: known.length ? known.reduce((sum, m) => sum + m.costUsd!, 0) : null,
    unknownCostTurns: moves.length - known.length,
    reservedUsd,
    createdAt: game.createdAt,
    endedAt,
    engineVersion: game.version,
    players: game.players.map(p => ({ seat: p.id, name: p.name, role: p.role, model: game.model, survived: p.alive })),
    moves,
    timeline: timeline(game, moves),
  };
}

/**
 * Transcript entries carry no turn numbers, so moves are placed by day and
 * phase: night actions after that day's night header, speeches onto their
 * speech entries (1:1, in order), individual votes after the voting header.
 * A move that finds no public entry throws, so a mismatch fails loudly.
 */
function timeline(game: Game, moves: RecordMove[]): TimelineItem[] {
  const used = new Set<number>();
  const pending = (day: number, phases: Phase[]) => moves.filter(m => m.day === day && phases.includes(m.phase) && !used.has(m.turnNo));
  const items: TimelineItem[] = [];
  const emit = (move: RecordMove) => {
    used.add(move.turnNo);
    items.push(moveItem(move));
  };

  for (const entry of game.transcript) {
    if (entry.kind === "speech") {
      const move = pending(entry.day, ["discuss"])[0];
      if (!move || move.actor !== entry.actor) throw new Error("record_speech_mismatch");
      used.add(move.turnNo);
      items.push({ kind: "speech", day: entry.day, turnNo: move.turnNo, actor: move.actor, text: entry.text, rationale: move.rationale });
      continue;
    }
    items.push({ kind: entry.kind, day: entry.day, text: entry.text });
    if (entry.kind === "phase" && entry.text.startsWith("Night ")) pending(entry.day, ["investigate", "kill"]).forEach(emit);
    if (entry.kind === "phase" && entry.text.startsWith("Voting begins")) pending(entry.day, ["vote"]).forEach(emit);
  }
  if (moves.some(m => !used.has(m.turnNo))) throw new Error("record_unplaced_move");
  return items;
}

function moveItem(move: RecordMove): TimelineItem {
  const base = { day: move.day, turnNo: move.turnNo, actor: move.actor, rationale: move.rationale };
  if (move.phase === "discuss") return { kind: "speech", ...base, text: move.text ?? "" };
  if (move.phase === "vote") return { kind: "vote", ...base, target: move.target! };
  return { kind: "night", ...base, action: move.phase, target: move.target!, resultRole: move.resultRole };
}
