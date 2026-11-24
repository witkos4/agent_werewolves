import { callLlm, type LlmResult } from "../llm/client";
import { writeArchive } from "./archive";
import { applyMove, attemptAllowance, buildRequest, createGame, effectiveLimit, INPUT_RATE_CEILING, OUTPUT_RATE_CEILING, publicGame, randomIndex, SAFETY_USD, validateMove, type Game, type PublicGame } from "./engine";
import { buildRecord, type GameRecord } from "./record";
import { canonicalSetup, DEFAULT_SETUP, type GameSetup } from "./setup";

export const liveTuning = { firstDelayMs: 0, nextDelayMs: 250, timeoutMs: 30_000, quietMs: 45_000, maxAttempts: 3 };
/**
 * The first archive attempt runs `firstDelayMs` after a game ends; failures back
 * off from `retryBaseMs` ×4 per attempt, capped at `retryMaxMs`, forever.
 */
export const archiveTuning = { firstDelayMs: 0, retryBaseMs: 30_000, retryMaxMs: 3_600_000 };
type Turn = { turn_no: number; body: string; attempts: number; last_attempt_at: number | null; status: string };
type ArchiveRow = { status: "pending" | "archived"; attempts: number };
export type Snapshot = { seq: number; game: PublicGame };
export type LiveStartResult = { ok: true } | { ok: false; status: number; error: string };
/** What a batch reads from one of its games (S-09). */
export type BatchView = { status: Game["status"]; chargedUsd: number; winner: Game["winner"]; abortReason: string | null };

/**
 * Public catalog check for every model a game seats. Returns null when all
 * pass, the first failing model, or "" when the catalog itself is unavailable.
 * No credential is sent to this endpoint.
 */
async function unsafePricing(models: string[]): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
    if (!response.ok) return "";
    const result = await response.json() as { data?: { id: string; pricing?: Record<string, string> }[] };
    return models.find(model => !safePrices(result.data?.find(m => m.id === model)?.pricing)) ?? null;
  } catch { return ""; }
  finally { clearTimeout(timer); }
}

function safePrices(prices: Record<string, string> | undefined): boolean {
  if (!prices) return false;
  const input = Number(prices.prompt), output = Number(prices.completion);
  const reasoning = prices.internal_reasoning ? Number(prices.internal_reasoning) : 0;
  return Number.isFinite(input) && input > 0 && input <= INPUT_RATE_CEILING &&
    Number.isFinite(output) && output > 0 && output <= OUTPUT_RATE_CEILING &&
    Number.isFinite(reasoning) && reasoning >= 0 && reasoning <= OUTPUT_RATE_CEILING &&
    (!prices.request || Number(prices.request) === 0);
}

/** Real-game state is separate from legacy spike tables. All public output is projected. */
export class LiveGame {
  private inFlight = false;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
    private emit: (type: "started" | "turn" | "finished" | "aborted", game: PublicGame) => () => void,
  ) {
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS live_game (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state TEXT NOT NULL,
        reserved_usd REAL NOT NULL DEFAULT 0, charged_usd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS live_turns (
        turn_no INTEGER PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
        response_text TEXT, cost REAL, generation_id TEXT, latency_ms INTEGER, allowance_usd REAL
      );
      CREATE TABLE IF NOT EXISTS live_archive (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, archived_at INTEGER
      );
    `);
    // Rooms created before S-07: add the ledger columns in place. A mid-game
    // room starts its ledger at its gross reservations, a safe over-count.
    if (!this.hasColumn("live_game", "charged_usd")) {
      ctx.storage.transactionSync(() => {
        ctx.storage.sql.exec("ALTER TABLE live_game ADD COLUMN charged_usd REAL NOT NULL DEFAULT 0");
        ctx.storage.sql.exec("UPDATE live_game SET charged_usd = reserved_usd");
      });
    }
    if (!this.hasColumn("live_turns", "allowance_usd")) ctx.storage.sql.exec("ALTER TABLE live_turns ADD COLUMN allowance_usd REAL");
  }

  private hasColumn(table: string, column: string): boolean {
    return this.ctx.storage.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().some(c => c.name === column);
  }

  read(): Game | null {
    const row = this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM live_game WHERE singleton = 1").toArray()[0];
    return row ? JSON.parse(row.state) as Game : null;
  }

  snapshot(): Snapshot | null {
    const game = this.read();
    if (!game) return null;
    const seq = this.ctx.storage.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").one().seq;
    return { seq, game: publicGame(game) };
  }

  /**
   * `setup` undefined means the default; a version-1 room matches only an
   * omitted setup. `spendLimitUsd` undefined means `SAFETY_USD`. `batchId` is
   * part of the request, so reusing an ID across batches is a conflict.
   */
  async start(id: string, discussionPasses: number, setup?: GameSetup, spendLimitUsd?: number, batchId?: string): Promise<LiveStartResult> {
    const limit = spendLimitUsd ?? SAFETY_USD;
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = this.read();
      if (existing) {
        const sameSetup = existing.setup ? canonicalSetup(existing.setup) === canonicalSetup(setup ?? DEFAULT_SETUP) : setup === undefined;
        return existing.id === id && existing.discussionPasses === discussionPasses && sameSetup && effectiveLimit(existing) === limit
          && (existing.batchId ?? null) === (batchId ?? null)
          ? { ok: true } : { ok: false, status: 409, error: "This start request was already used with different settings." };
      }
      if (!this.env.OPENROUTER_API_KEY?.trim()) return { ok: false, status: 503, error: "The game provider is not configured." };
      // Seats are drawn first so that only models the game will call are checked.
      const game = createGame(id, discussionPasses, Date.now(), setup ?? DEFAULT_SETUP, randomIndex, limit, batchId);
      const unsafe = await unsafePricing([...new Set(game.players.map(p => p.model!))]);
      if (unsafe !== null) return { ok: false, status: 503, error: `Cannot verify safe ${unsafe ? `pricing for ${unsafe}` : "model pricing"}. Try again later.` };
      const notify = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("INSERT INTO live_game(singleton, state) VALUES (1, ?)", JSON.stringify(game));
        return this.emit("started", publicGame(game));
      });
      await this.schedule(game, Date.now() + liveTuning.firstDelayMs);
      notify();
      return { ok: true };
    });
  }

  /** Status and settled ledger, for the batch that started this game. */
  batchView(): BatchView | null {
    const game = this.read();
    if (!game) return null;
    const { charged_usd } = this.ctx.storage.sql.exec<{ charged_usd: number }>("SELECT charged_usd FROM live_game").one();
    return { status: game.status, chargedUsd: charged_usd, winner: game.winner, abortReason: game.abortReason };
  }

  /**
   * Aborts a running game with `cancelled`; a no-op once terminal. A turn whose
   * call is in flight keeps its charge, and its reply is dropped by `run()`'s
   * stale-result check because the game is no longer running.
   */
  async cancel(): Promise<void> {
    const game = this.read();
    if (game?.status !== "running") return;
    await this.abort(game, "cancelled");
  }

  private save(game: Game, type: "turn" | "finished" | "aborted") {
    this.ctx.storage.sql.exec("UPDATE live_game SET state = ? WHERE singleton = 1", JSON.stringify(game));
    return this.emit(type, publicGame(game));
  }

  private async schedule(game: Game, at: number) {
    await this.ctx.storage.setAlarm(Math.min(at, game.deadlineAt));
  }

  private async abort(game: Game, reason: string) {
    game = { ...game, status: "aborted", abortReason: reason, queue: [] };
    const notify = this.ctx.storage.transactionSync(() => {
      this.queueArchive();
      return this.save(game, "aborted");
    });
    await this.ctx.storage.setAlarm(Date.now() + archiveTuning.firstDelayMs);
    notify();
  }

  /** Outbox entry; committed in the same transaction as the terminal state. */
  private queueArchive() {
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO live_archive(singleton, status) VALUES (1, 'pending')");
  }

  private archiveRow(): ArchiveRow | null {
    return this.ctx.storage.sql.exec<ArchiveRow>("SELECT status, attempts FROM live_archive").toArray()[0] ?? null;
  }

  /**
   * Called on every read. A terminal room without an outbox entry finished
   * before archiving existed; queue it so it archives on its next alarm. A
   * pending entry whose alarm was lost (a failed setAlarm) is re-armed here.
   */
  async touch(): Promise<void> {
    const game = this.read();
    if (!game || game.status === "running") return;
    const row = this.archiveRow();
    if (row?.status === "archived") return;
    try {
      if (!row) this.queueArchive();
      if (await this.ctx.storage.getAlarm() !== null) return;
      await this.ctx.storage.setAlarm(Date.now() + archiveTuning.firstDelayMs);
    } catch (error) {
      console.log(JSON.stringify({ evt: "archive_rearm_failed", gameId: game.id, error: String(error) }));
    }
  }

  /** The full record, private reasoning included. Terminal games only. */
  record(): { record: GameRecord; archived: boolean } | null {
    const game = this.read();
    if (!game || game.status === "running") return null;
    return { record: this.buildRecord(game), archived: this.archiveRow()?.status === "archived" };
  }

  private buildRecord(game: Game): GameRecord {
    const sql = this.ctx.storage.sql;
    const turns = sql.exec<{ turn_no: number; cost: number | null; latency_ms: number | null; attempts: number; generation_id: string | null }>(
      "SELECT turn_no, cost, latency_ms, attempts, generation_id FROM live_turns WHERE status = 'done' ORDER BY turn_no",
    ).toArray().map(t => ({ turnNo: t.turn_no, costUsd: t.cost, latencyMs: t.latency_ms, attempts: t.attempts, generationId: t.generation_id }));
    const ended = sql.exec<{ created_at: number }>("SELECT created_at FROM events WHERE type IN ('finished', 'aborted') ORDER BY seq DESC LIMIT 1").toArray()[0];
    const ledger = sql.exec<{ reserved_usd: number; charged_usd: number }>("SELECT reserved_usd, charged_usd FROM live_game").one();
    return buildRecord(game, turns, { endedAt: ended?.created_at ?? game.createdAt, reservedUsd: ledger.reserved_usd, chargedUsd: ledger.charged_usd });
  }

  /** Writes the record to D1; on failure retries on the alarm with backoff, indefinitely. */
  private async archive(game: Game) {
    const row = this.archiveRow();
    if (row?.status !== "pending") return;
    try {
      if (!this.env.ARCHIVE) throw new Error("archive_unbound");
      await writeArchive(this.env.ARCHIVE, this.buildRecord(game), JSON.stringify(game), Date.now());
    } catch (error) {
      const attempts = row.attempts + 1;
      this.ctx.storage.sql.exec("UPDATE live_archive SET attempts = ?, last_error = ?", attempts, String(error).slice(0, 500));
      const delay = Math.min(archiveTuning.retryBaseMs * 4 ** (attempts - 1), archiveTuning.retryMaxMs);
      console.log(JSON.stringify({ evt: "archive_failed", gameId: game.id, attempts, retryInMs: delay, error: String(error) }));
      await this.ctx.storage.setAlarm(Date.now() + delay);
      return;
    }
    // Only after D1 committed; a crash before this line re-runs a no-op batch.
    this.ctx.storage.sql.exec("UPDATE live_archive SET status = 'archived', archived_at = ?, last_error = NULL", Date.now());
    await this.ctx.storage.deleteAlarm();
    console.log(JSON.stringify({ evt: "game_archived", gameId: game.id, attempts: row.attempts + 1 }));
  }

  async alarm(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const game = this.read();
      if (!game) return;
      if (game.status !== "running") return await this.archive(game);
      if (Date.now() >= game.deadlineAt) return await this.abort(game, "time_limit");
      await this.run(game);
    } catch (error) {
      const game = this.read();
      if (game?.status === "running") await this.abort(game, "internal_error");
      else if (game && this.archiveRow()?.status === "pending") throw error;
    } finally { this.inFlight = false; }
  }

  private async run(game: Game) {
    const sql = this.ctx.storage.sql;
    let turn = sql.exec<Turn>("SELECT * FROM live_turns WHERE turn_no = ?", game.turn).toArray()[0];
    if (!turn) {
      let body: string;
      try { body = buildRequest(game); } catch { return this.abort(game, "context_limit"); }
      sql.exec("INSERT INTO live_turns(turn_no, body, status) VALUES (?, ?, 'pending')", game.turn, body);
      turn = sql.exec<Turn>("SELECT * FROM live_turns WHERE turn_no = ?", game.turn).one();
    }
    if (turn.status !== "pending") return this.abort(game, "invalid_turn_state");
    if (turn.attempts >= liveTuning.maxAttempts) return this.abort(game, "attempts_exhausted");
    const now = Date.now();
    if (turn.last_attempt_at !== null && now < turn.last_attempt_at + liveTuning.quietMs) {
      return this.schedule(game, turn.last_attempt_at + liveTuning.quietMs);
    }
    // Spend ledger: every attempt is charged its worst case before the call and
    // settled to its known cost when the turn commits. Failed, lost and
    // unknown-cost attempts keep the full charge, so the limit holds whether or
    // not a retry is served free from the provider cache.
    const allowance = attemptAllowance(turn.body);
    const charged = sql.exec<{ charged_usd: number }>("SELECT charged_usd FROM live_game").one().charged_usd;
    if (charged + allowance > effectiveLimit(game)) return this.abort(game, "spend_limit");
    this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE live_game SET reserved_usd = reserved_usd + ?, charged_usd = charged_usd + ?", allowance, allowance);
      sql.exec("UPDATE live_turns SET attempts = attempts + 1, last_attempt_at = ?, allowance_usd = ? WHERE turn_no = ?", now, allowance, game.turn);
    });
    // Persist a watchdog before yielding to the provider. A lost reply is retried
    // from the stored body after the quiet interval, with another reservation.
    await this.schedule(game, now + liveTuning.quietMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(liveTuning.timeoutMs, game.deadlineAt - Date.now())));
    let result: LlmResult;
    try {
      result = await callLlm({ apiKey: this.env.OPENROUTER_API_KEY.trim(), body: turn.body, signal: controller.signal });
    } catch {
      result = { ok: false, retryable: true, status: null, reason: "provider_error" };
    } finally { clearTimeout(timer); }
    // A stale result cannot advance a different turn or resurrect a terminal game.
    const current = this.read();
    if (!current || current.status !== "running" || current.turn !== game.turn) return;
    if (Date.now() >= game.deadlineAt) return this.abort(game, "time_limit");
    if (!result.ok) {
      if (!result.retryable) return this.abort(game, "provider_error");
      if (turn.attempts + 1 >= liveTuning.maxAttempts) return this.abort(game, "attempts_exhausted");
      return this.schedule(game, Math.max(Date.now() + 1000, now + liveTuning.quietMs));
    }
    let next: Game;
    try { next = applyMove(game, validateMove(game, result.text)); }
    catch (error) {
      // Keep the rejected reply for diagnosis; the turn stays pending and is never replayed.
      sql.exec("UPDATE live_turns SET response_text = ? WHERE turn_no = ?", result.text.slice(0, 4000), game.turn);
      console.log(JSON.stringify({ evt: "invalid_model_response", gameId: game.id, turn: game.turn,
        model: JSON.parse(turn.body).model, error: String(error), text: result.text.slice(0, 300) }));
      return this.abort(game, "invalid_model_response");
    }
    const notify = this.ctx.storage.transactionSync(() => {
      // Settle this attempt; a turn reserved before S-07 (null allowance) keeps its charge.
      if (result.cost !== null) {
        sql.exec("UPDATE live_game SET charged_usd = charged_usd + COALESCE((SELECT ? - allowance_usd FROM live_turns WHERE turn_no = ?), 0)", result.cost, game.turn);
      }
      sql.exec("UPDATE live_turns SET status = 'done', response_text = ?, cost = ?, generation_id = ?, latency_ms = ? WHERE turn_no = ?",
        result.text, result.cost, result.generationId, result.latencyMs, game.turn);
      if (next.status !== "running") this.queueArchive();
      return this.save(next, next.status === "finished" ? "finished" : "turn");
    });
    if (next.status === "running") await this.schedule(next, Date.now() + liveTuning.nextDelayMs);
    else await this.ctx.storage.setAlarm(Date.now() + archiveTuning.firstDelayMs);
    notify();
  }
}
