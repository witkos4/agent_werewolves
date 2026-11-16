import { DurableObject } from "cloudflare:workers";

import { upsertBatch } from "./game/archive";
import { liveRoom } from "./game/routes";
import type { GameSetup } from "./game/setup";
import { ACTIVE_SLOT, available, committed, nextStart, planSlots, TERMINAL_SLOT, type BatchRequest, type SlotStatus } from "./batch/plan";
import { randomIndex } from "./game/engine";

/** Supervisor timing. Mutable only so tests can drive alarms by hand. */
export const batchTuning = {
  /** Delay before the pass that `start` and `cancel` arm. */
  firstPassDelayMs: 0,
  concurrency: 3,
  pollMs: 15_000,
  startRetryMs: 60_000,
  maxStartAttempts: 3,
  /** D1 sync failures back off from this ×4 per attempt, capped at `syncRetryMaxMs`. */
  syncRetryBaseMs: 30_000,
  syncRetryMaxMs: 3_600_000,
};

export type BatchStatus = "running" | "cancelling" | "done" | "cancelled";

export type BatchSlot = {
  index: number;
  gameId: string;
  status: SlotStatus;
  /** The game's spend limit; null until funded. */
  limitUsd: number | null;
  escrowUsd: number;
  chargedUsd: number;
  startAttempts: number;
  winner: "Village" | "Werewolves" | null;
  abortReason: string | null;
};

export type BatchSnapshot = {
  id: string;
  request: BatchRequest;
  status: BatchStatus;
  createdAt: number;
  endedAt: number | null;
  slots: BatchSlot[];
  settledUsd: number;
  escrowUsd: number;
  availableUsd: number;
};

export type BatchStartResult = { ok: true } | { ok: false; status: number; error: string };

type BatchDbRow = { id: string; request: string; status: BatchStatus; created_at: number; ended_at: number | null; version: number; d1_version: number; d1_attempts: number };
type SlotDbRow = {
  idx: number; game_id: string; setup: string; status: SlotStatus; limit_usd: number | null; escrow_usd: number; charged_usd: number;
  start_attempts: number; next_start_at: number | null; winner: BatchSlot["winner"]; abort_reason: string | null;
};

const TERMINAL_BATCH: readonly BatchStatus[] = ["done", "cancelled"];

/**
 * One batch per instance, named `batch:<uuid>`. All state lives in SQLite.
 * Each alarm runs one bounded pass: settle ended games, fund and start
 * pending slots under the escrow, apply cancel, budget skips and completion,
 * then copy the summary to D1 (an outbox, like a game's archive).
 *
 * The bound: settled charges plus the escrow held by starting or running
 * games never exceed the batch limit, and a game can never charge more than
 * the limit it was started with (S-07), so the batch never spends past it.
 */
export class BatchRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private inFlight = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS batch (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), id TEXT NOT NULL, request TEXT NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, ended_at INTEGER, version INTEGER NOT NULL, d1_version INTEGER NOT NULL DEFAULT 0,
        d1_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS slots (
        idx INTEGER PRIMARY KEY, game_id TEXT NOT NULL UNIQUE, setup TEXT NOT NULL, status TEXT NOT NULL,
        limit_usd REAL, escrow_usd REAL NOT NULL DEFAULT 0, charged_usd REAL NOT NULL DEFAULT 0,
        start_attempts INTEGER NOT NULL DEFAULT 0, next_start_at INTEGER, winner TEXT, abort_reason TEXT
      );
    `);
  }

  /** Plans and stores every slot, then arms the first pass. Idempotent on `(id, request)`. */
  async start(id: string, request: BatchRequest): Promise<BatchStartResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const existing = this.readBatch();
      if (existing) {
        return existing.id === id && existing.request === JSON.stringify(request)
          ? { ok: true } : { ok: false, status: 409, error: "This batch request was already used with different settings." };
      }
      if (!this.env.OPENROUTER_API_KEY?.trim()) return { ok: false, status: 503, error: "The game provider is not configured." };
      const slots = planSlots(request, randomIndex);
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("INSERT INTO batch (singleton, id, request, status, created_at, version) VALUES (1, ?, ?, 'running', ?, 1)",
          id, JSON.stringify(request), Date.now());
        slots.forEach((slot, idx) => this.sql.exec("INSERT INTO slots (idx, game_id, setup, status) VALUES (?, ?, ?, 'pending')",
          idx, slot.gameId, JSON.stringify(slot.setup)));
      });
      await this.ctx.storage.setAlarm(Date.now() + batchTuning.firstPassDelayMs);
      log("batch_started", { batchId: id, mode: request.mode, games: request.gameCount, limitUsd: request.spendLimitUsd, gameLimitUsd: request.gameLimitUsd });
      return { ok: true };
    });
  }

  async snapshot(): Promise<BatchSnapshot | null> {
    return this.buildSnapshot();
  }

  /**
   * Stops new starts; the next pass marks pending slots cancelled and cancels
   * every running game. Never waits for a pass, so it returns at once.
   */
  async cancel(): Promise<BatchSnapshot | null> {
    const batch = this.readBatch();
    if (!batch) return null;
    if (batch.status === "running") {
      this.mutate(() => this.sql.exec("UPDATE batch SET status = 'cancelling'"));
      await this.ctx.storage.setAlarm(Date.now() + batchTuning.firstPassDelayMs);
      log("batch_cancelling", { batchId: batch.id });
    }
    return this.buildSnapshot();
  }

  async alarm(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      await this.pass();
    } finally { this.inFlight = false; }
  }

  private async pass(): Promise<void> {
    const batch = this.readBatch();
    if (!batch) return;
    const request = JSON.parse(batch.request) as BatchRequest;

    if (!TERMINAL_BATCH.includes(batch.status)) {
      // A watchdog first: whatever happens below, the batch wakes again.
      await this.ctx.storage.setAlarm(Date.now() + batchTuning.pollMs);
      await this.settleAndRetry(batch, request);

      if (this.readBatch()!.status === "cancelling") {
        this.mutateIf(this.readSlots().some(s => s.status === "pending"), () => this.sql.exec("UPDATE slots SET status = 'cancelled' WHERE status = 'pending'"));
      } else {
        await this.fundAndStart(batch, request);
        const slots = this.readSlots();
        if (!slots.some(s => ACTIVE_SLOT.includes(s.status)) && slots.some(s => s.status === "pending") && !nextStart(request.spendLimitUsd, request.gameLimitUsd, toLedger(slots), batchTuning.concurrency)) {
          this.mutate(() => this.sql.exec("UPDATE slots SET status = 'skipped_budget' WHERE status = 'pending'"));
          log("batch_budget_skip", { batchId: batch.id, skipped: slots.filter(s => s.status === "pending").length });
        }
      }

      const slots = this.readSlots();
      if (slots.every(s => TERMINAL_SLOT.includes(s.status))) {
        const status: BatchStatus = this.readBatch()!.status === "cancelling" ? "cancelled" : "done";
        this.mutate(() => this.sql.exec("UPDATE batch SET status = ?, ended_at = ?", status, Date.now()));
        log("batch_ended", { batchId: batch.id, status, ...committed(toLedger(slots)) });
      }
    }

    const synced = await this.sync();
    const now = this.readBatch()!;
    if (!TERMINAL_BATCH.includes(now.status)) return; // The watchdog stands.
    if (synced) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Date.now() + Math.min(batchTuning.syncRetryBaseMs * 4 ** (now.d1_attempts - 1), batchTuning.syncRetryMaxMs));
  }

  /** Settles ended games, confirms or retries starts, and cancels games while cancelling. */
  private async settleAndRetry(batch: BatchDbRow, request: BatchRequest): Promise<void> {
    for (const slot of this.readSlots().filter(s => ACTIVE_SLOT.includes(s.status))) {
      const room = liveRoom(this.env, slot.game_id);
      if (slot.status === "starting") {
        if (this.readBatch()!.status === "cancelling" && slot.start_attempts > 0) {
          // A start that never landed can be dropped; one that did is cancelled below.
          if (await this.exists(slot) === false) { this.failStart(batch, slot, "cancelled"); continue; }
        }
        if ((slot.next_start_at ?? 0) <= Date.now()) await this.tryStart(batch, request, slot);
        continue;
      }
      let view;
      try { view = await room.getBatchView(); }
      catch (error) { log("batch_poll_failed", { batchId: batch.id, gameId: slot.game_id, error: String(error) }); continue; }
      if (!view) { log("batch_game_missing", { batchId: batch.id, gameId: slot.game_id }); continue; }
      if (view.status === "running") {
        if (this.readBatch()!.status === "cancelling") {
          try { await room.cancelLive(); } catch (error) { log("batch_cancel_failed", { batchId: batch.id, gameId: slot.game_id, error: String(error) }); }
        }
        continue;
      }
      this.mutate(() => this.sql.exec(
        "UPDATE slots SET status = ?, escrow_usd = 0, charged_usd = ?, winner = ?, abort_reason = ? WHERE idx = ?",
        view.status, view.chargedUsd, view.winner, view.abortReason, slot.idx));
      log("batch_slot_settled", { batchId: batch.id, gameId: slot.game_id, status: view.status, chargedUsd: view.chargedUsd, limitUsd: slot.limit_usd });
    }
  }

  /** Funds pending slots up to the concurrency cap; each escrow is durable before its start is sent. */
  private async fundAndStart(batch: BatchDbRow, request: BatchRequest): Promise<void> {
    for (;;) {
      const slots = this.readSlots();
      const next = nextStart(request.spendLimitUsd, request.gameLimitUsd, toLedger(slots), batchTuning.concurrency);
      if (!next) return;
      const slot = slots[next.index];
      this.mutate(() => this.sql.exec(
        "UPDATE slots SET status = 'starting', limit_usd = ?, escrow_usd = ?, start_attempts = 0, next_start_at = ? WHERE idx = ?",
        next.limitUsd, next.limitUsd, Date.now(), slot.idx));
      await this.tryStart(batch, request, { ...slot, status: "starting", limit_usd: next.limitUsd, escrow_usd: next.limitUsd, start_attempts: 0 });
    }
  }

  /** One idempotent start attempt with the slot's stored ID, setup and limit. */
  private async tryStart(batch: BatchDbRow, request: BatchRequest, slot: SlotDbRow): Promise<void> {
    const attempt = slot.start_attempts + 1;
    let result: { ok: true } | { ok: false; status: number | null; error: string };
    try {
      result = await liveRoom(this.env, slot.game_id).startLive(slot.game_id, request.discussionPasses, JSON.parse(slot.setup) as GameSetup, slot.limit_usd!, batch.id);
    } catch (error) {
      result = { ok: false, status: null, error: String(error) };
    }
    if (result.ok) {
      this.mutate(() => this.sql.exec("UPDATE slots SET status = 'running', start_attempts = ?, next_start_at = NULL WHERE idx = ?", attempt, slot.idx));
      log("batch_slot_started", { batchId: batch.id, gameId: slot.game_id, limitUsd: slot.limit_usd, attempt });
      return;
    }
    const retryable = result.status === null || result.status === 503;
    log("batch_start_failed", { batchId: batch.id, gameId: slot.game_id, attempt, status: result.status, error: result.error });
    if (retryable && attempt < batchTuning.maxStartAttempts) {
      this.mutate(() => this.sql.exec("UPDATE slots SET start_attempts = ?, next_start_at = ? WHERE idx = ?", attempt, Date.now() + batchTuning.startRetryMs, slot.idx));
      return;
    }
    // A thrown call may have started the game before the reply was lost. Fail
    // the slot (and release its escrow) only once the room shows no game.
    const exists = result.status === null ? await this.exists(slot) : false;
    if (exists === true) {
      this.mutate(() => this.sql.exec("UPDATE slots SET status = 'running', start_attempts = ?, next_start_at = NULL WHERE idx = ?", attempt, slot.idx));
      return;
    }
    if (exists === null) {
      this.mutate(() => this.sql.exec("UPDATE slots SET start_attempts = ?, next_start_at = ? WHERE idx = ?", attempt, Date.now() + batchTuning.startRetryMs, slot.idx));
      return;
    }
    this.failStart(batch, slot, "start_failed", result.error);
  }

  /** True if the slot's game exists, false if not, null if the room could not be asked. */
  private async exists(slot: SlotDbRow): Promise<boolean | null> {
    try { return (await liveRoom(this.env, slot.game_id).getBatchView()) !== null; }
    catch { return null; }
  }

  /** A start that wrote nothing spent nothing: the slot settles at $0. */
  private failStart(batch: BatchDbRow, slot: SlotDbRow, status: "start_failed" | "cancelled", error: string | null = null): void {
    this.mutate(() => this.sql.exec("UPDATE slots SET status = ?, escrow_usd = 0, charged_usd = 0, abort_reason = ? WHERE idx = ?",
      status, error?.slice(0, 300) ?? null, slot.idx));
    log("batch_slot_failed", { batchId: batch.id, gameId: slot.game_id, status, error });
  }

  /** Copies the summary to D1 when it is behind. Returns whether D1 is current. */
  private async sync(): Promise<boolean> {
    const batch = this.readBatch()!;
    if (batch.d1_version >= batch.version) return true;
    const snapshot = this.buildSnapshot()!;
    try {
      if (!this.env.ARCHIVE) throw new Error("archive_unbound");
      await upsertBatch(this.env.ARCHIVE, {
        id: batch.id, status: batch.status, mode: snapshot.request.mode, gameCount: snapshot.request.gameCount,
        discussionPasses: snapshot.request.discussionPasses, spendLimitUsd: snapshot.request.spendLimitUsd,
        gameLimitUsd: snapshot.request.gameLimitUsd, chargedUsd: snapshot.settledUsd, createdAt: batch.created_at,
        endedAt: batch.ended_at, version: batch.version, summaryJson: JSON.stringify(snapshot),
      });
    } catch (error) {
      this.sql.exec("UPDATE batch SET d1_attempts = d1_attempts + 1");
      log("batch_sync_failed", { batchId: batch.id, version: batch.version, error: String(error) });
      return false;
    }
    this.sql.exec("UPDATE batch SET d1_version = ?, d1_attempts = 0", batch.version);
    return true;
  }

  /** Every state change bumps the version in the same transaction, so D1 always catches up. */
  private mutate(change: () => void): void {
    this.ctx.storage.transactionSync(() => {
      change();
      this.sql.exec("UPDATE batch SET version = version + 1");
    });
  }

  private mutateIf(condition: boolean, change: () => void): void {
    if (condition) this.mutate(change);
  }

  private buildSnapshot(): BatchSnapshot | null {
    const batch = this.readBatch();
    if (!batch) return null;
    const request = JSON.parse(batch.request) as BatchRequest;
    const slots = this.readSlots().map((s): BatchSlot => ({
      index: s.idx, gameId: s.game_id, status: s.status, limitUsd: s.limit_usd, escrowUsd: s.escrow_usd, chargedUsd: s.charged_usd,
      startAttempts: s.start_attempts, winner: s.winner, abortReason: s.abort_reason,
    }));
    const ledger = toLedger(this.readSlots());
    return {
      id: batch.id, request, status: batch.status, createdAt: batch.created_at, endedAt: batch.ended_at, slots,
      ...committed(ledger), availableUsd: available(request.spendLimitUsd, ledger),
    };
  }

  private readBatch(): BatchDbRow | null {
    return this.sql.exec<BatchDbRow>("SELECT * FROM batch WHERE singleton = 1").toArray()[0] ?? null;
  }

  private readSlots(): SlotDbRow[] {
    return this.sql.exec<SlotDbRow>("SELECT * FROM slots ORDER BY idx").toArray();
  }
}

function toLedger(slots: SlotDbRow[]) {
  return slots.map(s => ({ status: s.status, escrowUsd: s.escrow_usd, chargedUsd: s.charged_usd }));
}

function log(evt: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ evt, ...fields }));
}
