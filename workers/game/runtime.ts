import { callLlm, type LlmResult } from "../llm/client";
import { applyMove, buildRequest, createGame, INPUT_RATE_CEILING, MAX_OUTPUT_TOKENS, MODEL, OUTPUT_RATE_CEILING, publicGame, SAFETY_USD, validateMove, type Game, type PublicGame } from "./engine";

export const liveTuning = { firstDelayMs: 0, nextDelayMs: 250, timeoutMs: 30_000, quietMs: 45_000, maxAttempts: 3 };
type Turn = { turn_no: number; body: string; attempts: number; last_attempt_at: number | null; status: string };
export type Snapshot = { seq: number; game: PublicGame };
export type LiveStartResult = { ok: true } | { ok: false; status: number; error: string };

/** Public catalog check. No credential is sent to this endpoint. */
async function pricingAvailable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
    if (!response.ok) return false;
    const result = await response.json() as { data?: { id: string; pricing?: Record<string, string> }[] };
    const prices = result.data?.find(m => m.id === MODEL)?.pricing;
    if (!prices) return false;
    const input = Number(prices.prompt), output = Number(prices.completion);
    return Number.isFinite(input) && input > 0 && input <= INPUT_RATE_CEILING &&
      Number.isFinite(output) && output > 0 && output <= OUTPUT_RATE_CEILING &&
      (!prices.internal_reasoning || Number(prices.internal_reasoning) <= OUTPUT_RATE_CEILING) &&
      (!prices.request || Number(prices.request) === 0);
  } catch { return false; }
  finally { clearTimeout(timer); }
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
        reserved_usd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS live_turns (
        turn_no INTEGER PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
        response_text TEXT, cost REAL, generation_id TEXT, latency_ms INTEGER
      );
    `);
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

  async start(id: string, discussionPasses: number): Promise<LiveStartResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = this.read();
      if (existing) return existing.id === id && existing.discussionPasses === discussionPasses
        ? { ok: true } : { ok: false, status: 409, error: "This start request was already used with different settings." };
      if (!this.env.OPENROUTER_API_KEY?.trim()) return { ok: false, status: 503, error: "The game provider is not configured." };
      if (!(await pricingAvailable())) return { ok: false, status: 503, error: "Cannot verify safe model pricing. Try again later." };
      const game = createGame(id, discussionPasses, Date.now());
      const notify = this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("INSERT INTO live_game(singleton, state) VALUES (1, ?)", JSON.stringify(game));
        return this.emit("started", publicGame(game));
      });
      await this.schedule(game, Date.now() + liveTuning.firstDelayMs);
      notify();
      return { ok: true };
    });
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
    const notify = this.ctx.storage.transactionSync(() => this.save(game, "aborted"));
    await this.ctx.storage.deleteAlarm();
    notify();
  }

  async alarm(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const game = this.read();
      if (!game || game.status !== "running") return;
      if (Date.now() >= game.deadlineAt) return await this.abort(game, "time_limit");
      await this.run(game);
    } catch {
      const game = this.read();
      if (game?.status === "running") await this.abort(game, "internal_error");
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
    // UTF-8 bytes overbound text tokens, plus a conservative chat-envelope margin.
    // Keep every reservation, even on cache hits or unknown/failed responses.
    const allowance = (new TextEncoder().encode(turn.body).length + 2048) * INPUT_RATE_CEILING + MAX_OUTPUT_TOKENS * OUTPUT_RATE_CEILING;
    const reserved = sql.exec<{ reserved_usd: number }>("SELECT reserved_usd FROM live_game").one().reserved_usd;
    if (reserved + allowance > SAFETY_USD) return this.abort(game, "safety_budget");
    this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE live_game SET reserved_usd = reserved_usd + ?", allowance);
      sql.exec("UPDATE live_turns SET attempts = attempts + 1, last_attempt_at = ? WHERE turn_no = ?", now, game.turn);
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
    catch { return this.abort(game, "invalid_model_response"); }
    const notify = this.ctx.storage.transactionSync(() => {
      sql.exec("UPDATE live_turns SET status = 'done', response_text = ?, cost = ?, generation_id = ?, latency_ms = ? WHERE turn_no = ?",
        result.text, result.cost, result.generationId, result.latencyMs, game.turn);
      return this.save(next, next.status === "finished" ? "finished" : "turn");
    });
    if (next.status === "running") await this.schedule(next, Date.now() + liveTuning.nextDelayMs);
    else await this.ctx.storage.deleteAlarm();
    notify();
  }
}
