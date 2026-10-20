import { DurableObject } from "cloudflare:workers";

import { callLlm, type LlmResult } from "./llm/client";
import { buildTurnRequest } from "./spike/story";

/** Loop limits. Mutable only so tests can shrink the waits. */
export const tuning = {
  firstTurnDelayMs: 0,
  maxAttempts: 3,
  /** Minimum gap after an attempt starts before the same turn is re-sent. */
  quietMs: 45_000,
  fetchTimeoutMs: 30_000,
  retryBackoffMs: 5_000,
};

export type GameStatus = "running" | "finished" | "aborted";

export type GameRow = {
  id: string;
  status: GameStatus;
  total_turns: number;
  next_turn: number;
  delay_ms: number;
  hold_ms: number;
  model: string;
  abort_reason: string | null;
  created_at: number;
};

export type TurnRow = {
  turn_no: number;
  idempotency_key: string;
  status: "pending" | "done";
  request_body: string;
  response_text: string | null;
  cost: number | null;
  latency_ms: number | null;
  attempts: number;
  last_attempt_at: number | null;
  cache_hit: number | null;
  generation_id: string | null;
};

type EventRow = {
  seq: number;
  type: string;
  payload: string;
  created_at: number;
};

export type GameEvent = {
  seq: number;
  type: "started" | "turn" | "finished" | "aborted";
  payload: unknown;
  createdAt: number;
};

export type StartOptions = {
  gameId: string;
  totalTurns?: number;
  delayMs: number;
  holdMs?: number;
  model: string;
};

const SCHEMA_VERSION = 1;

/**
 * One game per instance. All game state lives in SQLite; each alarm runs at
 * most one turn attempt, so the loop survives eviction and redeploys.
 */
export class GameRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      log("game_room_constructed", {
        gameId: this.readGame()?.id ?? null,
        versionId: env.CF_VERSION_METADATA?.id ?? null,
      });
    });
  }

  async start({
    gameId,
    totalTurns = 3,
    delayMs,
    holdMs = 0,
    model,
  }: StartOptions): Promise<void> {
    if (this.readGame()) return;

    const events = this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO game (id, status, total_turns, next_turn, delay_ms, hold_ms, model, created_at)
         VALUES (?, 'running', ?, 1, ?, ?, ?, ?)`,
        gameId,
        totalTurns,
        delayMs,
        holdMs,
        model,
        Date.now(),
      );
      return [this.appendEvent("started", { totalTurns, delayMs, model })];
    });
    await this.ctx.storage.setAlarm(Date.now() + tuning.firstTurnDelayMs);
    this.broadcast(events);
  }

  getJournal(): { game: GameRow | null; turns: TurnRow[] } {
    return {
      game: this.readGame(),
      turns: this.sql
        .exec<TurnRow>("SELECT * FROM turns ORDER BY turn_no")
        .toArray(),
    };
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const game = this.readGame();
    if (!game || game.status !== "running") return;

    try {
      await this.runTurn(game, alarmInfo?.isRetry ?? false);
    } catch (error) {
      // LLM failures never throw (see callLlmSafely), so this is a bug or a
      // runtime shutdown. If storage is gone the abort write throws too, and
      // the platform retries the alarm against the persisted journal.
      log("turn_error", { gameId: game.id, error: String(error) });
      this.abortGame(`internal_error: ${String(error)}`, game.next_turn);
    }
  }

  private async runTurn(game: GameRow, isRetry: boolean): Promise<void> {
    if (game.next_turn > game.total_turns) {
      this.finishGame(); // Repair path: the last turn commits `finished` itself.
      return;
    }

    let turn = this.readTurn(game.next_turn);

    if (turn?.status === "done") {
      // Repair path: `done` and the `next_turn` advance commit together.
      this.sql.exec("UPDATE game SET next_turn = ?", turn.turn_no + 1);
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }

    if (turn && turn.attempts >= tuning.maxAttempts) {
      this.abortGame("attempts_exhausted", turn.turn_no);
      return;
    }

    const now = Date.now();
    if (turn?.last_attempt_at != null && now - turn.last_attempt_at < tuning.quietMs) {
      // An earlier attempt may still be in flight upstream; re-sending now
      // would race it and be billed twice. Wait until its reply is cached.
      const wakeAt = turn.last_attempt_at + tuning.quietMs;
      log("turn_quiet_wait", { gameId: game.id, turn: turn.turn_no, isRetry, wakeAt });
      await this.ctx.storage.setAlarm(wakeAt);
      return;
    }

    if (!turn) {
      const body = buildTurnRequest({
        gameId: game.id,
        model: game.model,
        turnNo: game.next_turn,
        previous: this.doneTexts(),
      });
      this.sql.exec(
        `INSERT INTO turns (turn_no, idempotency_key, status, request_body, attempts)
         VALUES (?, ?, 'pending', ?, 0)`,
        game.next_turn,
        `${game.id}:${game.next_turn}`,
        body,
      );
      turn = this.readTurn(game.next_turn)!;
    }

    // Output gates hold the fetch below until this write is durable.
    const attempt = turn.attempts + 1;
    const attemptStartedAt = now;
    this.sql.exec(
      "UPDATE turns SET attempts = ?, last_attempt_at = ? WHERE turn_no = ?",
      attempt,
      attemptStartedAt,
      turn.turn_no,
    );

    if (game.hold_ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, game.hold_ms));
    }

    const result = await this.callLlmSafely(turn.request_body);
    log("turn_attempt", {
      gameId: game.id,
      turn: turn.turn_no,
      attempt,
      isRetry,
      cacheHit: result.ok ? result.cacheHit : null,
      cost: result.ok ? result.cost : null,
      latencyMs: result.ok ? result.latencyMs : null,
      bodySha256: await sha256Prefix(turn.request_body),
      versionId: this.env.CF_VERSION_METADATA?.id ?? null,
      outcome: result.ok ? "ok" : result.reason,
    });

    if (result.ok) {
      await this.commitTurn(game, turn.turn_no, result);
      return;
    }

    if (!result.retryable) {
      this.abortGame(`llm_error: ${result.reason}`, turn.turn_no);
    } else if (attempt >= tuning.maxAttempts) {
      this.abortGame("attempts_exhausted", turn.turn_no);
    } else {
      await this.ctx.storage.setAlarm(
        Math.max(Date.now() + tuning.retryBackoffMs, attemptStartedAt + tuning.quietMs),
      );
    }
  }

  private async commitTurn(
    game: GameRow,
    turnNo: number,
    result: Extract<LlmResult, { ok: true }>,
  ): Promise<void> {
    const isLast = turnNo >= game.total_turns;
    const events = this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE turns SET status = 'done', response_text = ?, cost = ?, latency_ms = ?,
           cache_hit = ?, generation_id = ? WHERE turn_no = ?`,
        result.text,
        result.cost,
        result.latencyMs,
        result.cacheHit ? 1 : 0,
        result.generationId,
        turnNo,
      );
      const committed = [
        this.appendEvent("turn", {
          turnNo,
          text: result.text,
          cost: result.cost,
          cacheHit: result.cacheHit,
          latencyMs: result.latencyMs,
        }),
      ];
      this.sql.exec(
        "UPDATE game SET next_turn = ?, status = ? WHERE id = ?",
        turnNo + 1,
        isLast ? "finished" : "running",
        game.id,
      );
      if (isLast) committed.push(this.appendEvent("finished", { turns: game.total_turns }));
      return committed;
    });
    // Issued before any other await, so it is stored atomically with the commit.
    if (!isLast) await this.ctx.storage.setAlarm(Date.now() + game.delay_ms);
    this.broadcast(events);
  }

  private async callLlmSafely(body: string): Promise<LlmResult> {
    try {
      return await callLlm({
        apiKey: this.env.OPENROUTER_API_KEY,
        body,
        signal: AbortSignal.timeout(tuning.fetchTimeoutMs),
      });
    } catch (error) {
      return { ok: false, retryable: true, status: null, reason: `llm_threw: ${String(error)}` };
    }
  }

  private finishGame(): void {
    const events = this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE game SET status = 'finished'");
      const game = this.readGame()!;
      return [this.appendEvent("finished", { turns: game.total_turns })];
    });
    this.broadcast(events);
  }

  private abortGame(reason: string, turnNo: number): void {
    const events = this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE game SET status = 'aborted', abort_reason = ?", reason);
      return [this.appendEvent("aborted", { reason, turnNo })];
    });
    log("game_aborted", { gameId: this.readGame()?.id ?? null, reason, turn: turnNo });
    this.broadcast(events);
  }

  private broadcast(events: GameEvent[]): void {
    for (const ws of this.ctx.getWebSockets()) {
      for (const event of events) {
        try {
          ws.send(JSON.stringify(event));
        } catch {
          // A dead socket reconnects and replays from its last seq.
        }
      }
    }
  }

  private appendEvent(type: GameEvent["type"], payload: unknown): GameEvent {
    const row = this.sql
      .exec<EventRow>(
        "INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?) RETURNING *",
        type,
        JSON.stringify(payload),
        Date.now(),
      )
      .one();
    return toEvent(row);
  }

  private readGame(): GameRow | null {
    return this.sql.exec<GameRow>("SELECT * FROM game LIMIT 1").toArray()[0] ?? null;
  }

  private readTurn(turnNo: number): TurnRow | null {
    return (
      this.sql.exec<TurnRow>("SELECT * FROM turns WHERE turn_no = ?", turnNo).toArray()[0] ??
      null
    );
  }

  private doneTexts(): string[] {
    return this.sql
      .exec<{ response_text: string }>(
        "SELECT response_text FROM turns WHERE status = 'done' ORDER BY turn_no",
      )
      .toArray()
      .map((row) => row.response_text);
  }

  /** Versioned in-code schema changes; the class itself never changes. */
  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const current =
      this.sql.exec<{ version: number }>("SELECT version FROM schema_version").toArray()[0]
        ?.version ?? 0;
    if (current >= SCHEMA_VERSION) return;

    this.ctx.storage.transactionSync(() => {
      if (current < 1) {
        this.sql.exec(`
          CREATE TABLE game (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            total_turns INTEGER NOT NULL,
            next_turn INTEGER NOT NULL,
            delay_ms INTEGER NOT NULL,
            hold_ms INTEGER NOT NULL,
            model TEXT NOT NULL,
            abort_reason TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE turns (
            turn_no INTEGER PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL,
            request_body TEXT NOT NULL,
            response_text TEXT,
            cost REAL,
            latency_ms INTEGER,
            attempts INTEGER NOT NULL,
            last_attempt_at INTEGER,
            cache_hit INTEGER,
            generation_id TEXT
          );
          CREATE TABLE events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
        `);
      }
      this.sql.exec("DELETE FROM schema_version");
      this.sql.exec("INSERT INTO schema_version (version) VALUES (?)", SCHEMA_VERSION);
    });
  }
}

function toEvent(row: EventRow): GameEvent {
  return {
    seq: row.seq,
    type: row.type as GameEvent["type"],
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

async function sha256Prefix(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function log(evt: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ evt, ...fields }));
}
