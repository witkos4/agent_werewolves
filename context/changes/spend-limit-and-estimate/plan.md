# Spend Limit and Estimate Implementation Plan

## Overview

Roadmap S-07 (FR-014). Before starting a game, the operator sees an estimated cost and sets a spend limit. A game that would pass its limit stops before the call that could cross it, and is archived as aborted for budget reasons. This is the spend gate S-09's batches multiply, so it lands first.

## Current State Analysis

- **A per-game cap already exists, fixed and gross.** Before every attempt, `LiveGame.run()` (`workers/game/runtime.ts`) computes a worst-case `allowance = (UTF-8 bytes of the body + 2048) × INPUT_RATE_CEILING + MAX_OUTPUT_TOKENS × OUTPUT_RATE_CEILING`, aborts with `safety_budget` if `reserved_usd + allowance > SAFETY_USD` ($1.00), and otherwise adds the allowance to `live_game.reserved_usd`. The reservation is never settled. A finished turn's real cost does not replace it, so the cap measures the sum of worst cases (about $0.43 for an 8-seat, two-round game before retries, per the comment in `engine.ts`), not spend.
- **The worst case is a true bound per attempt.** `buildRequest` sets `provider.max_price` to the rate ceilings, so OpenRouter routes only to endpoints at or under them, and `unsafePricing()` refuses to start a game whose seated models list prices above the ceilings. UTF-8 bytes over-count text tokens. `max_tokens` caps output.
- **Retries are already charged.** Every attempt reserves again, including after a timeout or a lost reply. The comment in `openrouter.ts` says so: "live-game safety reservations cover every attempt regardless of cache status."
- Actual cost per turn is `usage.cost` from OpenRouter, recorded in `live_turns.cost` and archived as `game_moves.cost_usd`. A cache HIT records 0. A missing cost records null (`unknown_cost_turns`).
- The archive has `games.reserved_usd`, `total_cost_usd`, `unknown_cost_turns`, `abort_reason`, `seat_count`, `discussion_passes`, `turns`. S-08's metrics already compute cost per turn per model (`workers/game/metrics.ts`).
- The start path is `home.tsx` action → `POST /api/games/start` (`workers/game/routes.ts`, strict key whitelist, 4 KB cap) → `GameRoom.startLive` → `LiveGame.start`, which is idempotent on `(id, discussionPasses, setup)`. Home already passes `safetyUsd` to the page.
- Abort reasons render through `abortMessage()` in `app/routes/games.$gameId.tsx`.

## Desired End State

- The start form has a **Spend limit** field (USD, default 1.00, 0.05–5.00) and shows **Estimated cost ≈ $x · from N games**, recomputed as seats, pool and discussion rounds change. If the estimate is above the limit, the form warns.
- A running game never makes an attempt whose worst case could take its ledger past the limit. When the next attempt would, the game aborts with `spend_limit`, shows "The game reached its spend limit of $y.", and archives as aborted.
- The record page shows "spent $x of $y limit" (ledger and limit).
- `games.spend_limit_usd` and `games.charged_usd` exist. They are null for games archived before this change.

Verify: the automated suite, then the Phase 4 production drill against OpenRouter's activity log.

### Key Discoveries:

- **The blocking unknown dissolves by design.** The roadmap blocks S-07 on proving that an in-DO retry gets a free cache HIT. The ledger below charges every attempt that did not return a known cost its full allowance, so the limit holds whether a retry is free or billed. A HIT only makes real spend lower than the ledger. ◆ **Operator confirmation wanted** to downgrade the unknown to non-blocking and drop the resend drill.
- Settling is what makes a user-set limit usable. Without it, a $0.50 limit would abort most 8-seat games on paper while they had spent cents.
- History beats a price table for the estimate. Turn count depends on how the game plays out, and prompt size grows with the transcript. Archived cost per turn already folds both in, and the six catalog models all have production games behind them.

## Spend rules

- **Ledger.** `charged_usd` starts at 0. Before an attempt: if `charged_usd + allowance > spendLimitUsd`, abort `spend_limit`. Otherwise `charged_usd += allowance` in the same transaction that bumps `attempts`.
- **Settlement.** When a turn commits with a known `cost` (including 0 for a HIT), `charged_usd += cost − allowance` for that attempt. The allowance is stored on the turn row so settlement uses the exact amount reserved. An attempt that fails, times out, is lost or returns an unknown cost keeps its full allowance.
- **Guarantee.** Real spend ≤ `charged_usd` ≤ limit at all times, given that each allowance bounds its call. That is stricter than the NFR's "limit plus one turn".
- **Wasted headroom.** A game stops while it still has up to one allowance (about $0.01–0.02 at today's body sizes) of unspent limit. That is acceptable.
- `reserved_usd` keeps its meaning (the gross sum of allowances) for continuity with archived games and metrics. `SAFETY_USD` becomes the default limit, and the `safety_budget` reason is kept for rendering old games only.
- **Bounds.** `spendLimitUsd` is a number with 0.05 ≤ x ≤ 5.00, at most two decimals. The server cap guards a fat-fingered value, since the access key is the only other gate. Omitted means 1.00.

## Estimate rules

- **Inputs** (one D1 query batch over `games`/`game_moves`/`game_players`): (a) per model, the sum of known `cost_usd` and the count of known-cost turns, all statuses; (b) per `(seat_count, discussion_passes)`, the mean `turns` and the count of finished games.
- **Per-seat turns** = mean turns for the game's shape ÷ seat count. With no finished game of that shape, fall back to the closest shape with the same seat count, else the worst case (below).
- **Per-seat cost per turn**: a fixed model uses its history. A "Random" seat uses the unweighted mean over the pool's models that have history.
- **Estimate** = Σ seats (per-seat turns × per-seat cost per turn). It is shown with the number of finished games behind the turn count and the minimum known-turn count across the models used.
- **No history** for a needed model or shape: the estimate uses the worst-case allowance for the median body size from history (or 20 KB with no history) and is labelled "upper bound, no history for X".
- ◆ **Operator confirmation wanted**: history as the pricing source (the roadmap's open unknown), instead of a maintained table or live catalog prices.

## What We're NOT Doing

- Batch-level limits and estimates (S-09). The ledger rule is written so a batch can sum game ledgers later.
- Live spend in the viewer during a game.
- Changing the rate ceilings, `max_price` routing, `MAX_OUTPUT_TOKENS` or `unsafePricing()`.
- A maintained price table or live catalog prices in the estimate.
- Ranges or confidence intervals on the estimate. The game count beside it shows how much to trust it.

## Implementation Approach

Keep the existing reservation point. It already runs before every LLM call, which is exactly what the roadmap's risk asks for. Make it settle, and compare it with a per-game limit instead of a constant. The estimate is a pure function over a few archive aggregates, and the form evaluates it in the browser as the setup changes.

## Critical Implementation Details

- **One allowance formula.** Move the allowance expression from `run()` into an exported `attemptAllowance(body)` in `engine.ts`, so the runtime and the estimate's worst-case fallback share it.
- **Settlement is exact and idempotent.** `live_turns` gains `allowance_usd` (the last attempt's reservation, written in the reserve transaction). Settlement happens inside the transaction that marks the turn `done`, so a crash either leaves the full allowance charged (safe) or settles exactly once.
- **Durable Object schema change.** `live_game.charged_usd REAL NOT NULL DEFAULT 0` and `live_turns.allowance_usd REAL` are added with guarded `ALTER TABLE` statements: check `pragma_table_info` before each ALTER, because `CREATE TABLE IF NOT EXISTS` does not add columns to an existing table. A room that was mid-game during the deploy starts its ledger at its current `reserved_usd`. That is a safe over-count.
- **Limit in state.** `Game.spendLimitUsd?: number`. A missing value reads as `SAFETY_USD`. Idempotency compares the effective limit, so a repeat start with a different limit returns 409 like any other changed setting.
- **Abort ordering.** The limit check runs after the deadline check and before the reservation, in the same place as today's `safety_budget` check, which it replaces.

## Phase 1: Ledger and limit in the game room

### Overview

Enforce a per-game spend limit with a settling ledger.

### Changes Required:

#### 1. Engine

**File**: `workers/game/engine.ts`

**Contract**: `attemptAllowance(body: string): number`. `Game.spendLimitUsd?: number`. `createGame(…, spendLimitUsd = SAFETY_USD)`. `SPEND_LIMIT_MIN = 0.05`, `SPEND_LIMIT_MAX = 5`. `effectiveLimit(game)`. `PublicGame` gains `spendLimitUsd` (the effective limit) so the live viewer can name it.

#### 2. Runtime

**File**: `workers/game/runtime.ts`

**Contract**: The ledger and settlement above, the guarded ALTERs, abort reason `spend_limit`. `start(id, passes, setup?, spendLimitUsd?)` includes the limit in the idempotency check.

#### 3. Start API

**Files**: `workers/game/routes.ts`, `workers/game-room.ts`

**Contract**: The body may include `spendLimitUsd` (validated to the bounds, two decimals). It is passed through `startLive`.

### Success Criteria:

#### Automated Verification:

- 1.1 Live-game tests: with stubbed costs, a limit hit mid-game aborts with `spend_limit` before the provider call and archives as aborted. Settled known costs let a game finish under a limit that the gross reservations would exceed. An unknown-cost turn and a failed attempt keep their full allowance. A timed-out attempt plus its retry are both charged. `charged_usd` never exceeds the limit: `npm test -- live-game`
- 1.2 Idempotency: a repeat start with the same limit returns ok, one with a different limit returns 409, and an omitted limit equals 1.00: `npm test -- live-game`
- 1.3 HTTP boundary: an out-of-range, non-numeric or three-decimal limit returns 400: `npm test -- live-game`
- 1.4 A room created before the change (no `charged_usd` column, mid-game) keeps playing with its ledger seeded from `reserved_usd`: `npm test -- live-game`
- 1.5 Typecheck passes: `npm run typecheck`

---

## Phase 2: Archive and record

### Overview

Keep the limit and ledger with every archived game and show them.

### Changes Required:

#### 1. Migration

**File**: `migrations/0004_spend_limit.sql` (new)

**Contract**: `ALTER TABLE games ADD COLUMN spend_limit_usd REAL;`, `ALTER TABLE games ADD COLUMN charged_usd REAL;`. No backfill: older games had no per-game limit.

#### 2. Record and archive

**Files**: `workers/game/record.ts`, `workers/game/archive.ts`, `workers/game/runtime.ts`

**Contract**: `GameRecord` gains `spendLimitUsd: number | null` and `chargedUsd: number | null`. `buildRecord`'s meta takes them, and `writeArchive`/`readArchive` round-trip them.

#### 3. Pages

**File**: `app/routes/games.$gameId.tsx`

**Contract**: The record summary line adds "spent $x of $y limit" when both are known. `abortMessage("spend_limit")` reads "The game reached its spend limit of $y." (the limit comes from the record, or from the snapshot during live view).

### Success Criteria:

#### Automated Verification:

- 2.1 Archive tests: a budget-aborted game archives with `abort_reason = 'spend_limit'`, its limit and its ledger, and reads back the same. An old-shape record reads with nulls: `npm test -- archive`
- 2.2 Record and route tests stay green, and the record page shows the spend line and the new abort message: `npm test -- record`
- 2.3 Local migration applies: `npm run db:migrate:local`
- 2.4 Typecheck passes: `npm run typecheck`

---

## Phase 3: Estimate on the start form

### Overview

Show the estimated cost before starting and let the operator set the limit.

### Changes Required:

#### 1. Estimate module

**File**: `workers/game/estimate.ts` (new)

**Contract**: `readEstimateInputs(db)` returns `{ models: { model, knownTurns, costUsd }[]; shapes: { seats, passes, games, meanTurns }[]; medianBodyBytes: number | null }`. `estimateCost(setup, passes, inputs)` is pure and returns `{ usd: number; games: number; minModelTurns: number; upperBound: boolean; missing: string[] }`.

#### 2. Home

**File**: `app/routes/home.tsx`

**Contract**: The loader adds `estimateInputs` (null if the archive read fails, like `recent`). The form adds a `spendLimitUsd` number input (step 0.01, min/max from the engine) and an estimate line computed client-side from the current selections. A warning appears when the estimate exceeds the limit. The action forwards `spendLimitUsd` and echoes it on error. With no inputs, the form says "No estimate: the archive is unavailable" and still starts games.

### Success Criteria:

#### Automated Verification:

- 3.1 Pure estimate tests: fixed seats, random seats over a pool, a missing model (upper bound and `missing`), a missing shape (fallback), and zero history: `npm test -- estimate`
- 3.2 D1 test: seeded archives give the hand-computed inputs: `npm test -- estimate`
- 3.3 Route tests: home renders the limit field and the estimate, forwards the limit, echoes it after a failed start, and still renders with an unreachable archive: `npm test -- routes`
- 3.4 Typecheck and build pass: `npm run typecheck && npm run build`

#### Manual Verification:

- 3.5 On the dev page, the estimate updates as seats change, the warning appears when the limit is set below the estimate, and a game started with a $0.05 limit (stub or real key) aborts with the spend message.

---

## Phase 4: Production rollout and check

### Overview

Ship and prove the limit holds against real provider billing.

### Changes Required:

#### 1. Verification record

**File**: `context/changes/spend-limit-and-estimate/verification.md` (new): the deploy, both drill games, the ledger against OpenRouter activity, and the estimate against actual cost.

### Success Criteria:

#### Automated Verification:

- 4.1 CI applies migration `0004` and deploys, and `/healthz` passes.

#### Manual Verification:

- 4.2 An 8-seat production game with a $0.05 limit aborts with `spend_limit`. Its archived `charged_usd` ≤ 0.05, and the sum of its generations in OpenRouter activity ≤ `charged_usd`.
- 4.3 An 8-seat production game at the default limit finishes. Its archived `total_cost_usd` is within the estimate's ballpark (recorded, not gated), and `charged_usd` ≥ `total_cost_usd`.
- 4.4 No game archived after the deploy is missing `spend_limit_usd` or `charged_usd`.

## Testing Strategy

The live-game tests carry the guarantee: stubbed provider costs drive the ledger through every outcome (known, HIT, unknown, failed, timed out, lost) and assert `charged_usd ≤ limit` after every alarm. The estimate is pure and tested without D1, plus one D1 test for the input query. Phase 4 ties the ledger to real billing once.

## Performance Considerations

The estimate inputs are two GROUP BY queries over `games` and `game_moves ⋈ game_players`, read once per home load, the same cost class as S-08's metrics. The runtime adds one column write per attempt and per settled turn.

## Migration Notes

`0004` is additive (two nullable columns). An older Worker ignores them, and a rollback needs no schema change. The Durable Object columns are added in place with guarded ALTERs. A rolled-back Worker ignores them.

## References

- PRD: `context/foundation/prd.md`, FR-014 (line 137), NFR "Spend never overshoots" (line 156), guardrail "LLM spend stays capped" (line 64).
- Roadmap S-07: `context/foundation/roadmap.md`.
- F-02 re-bill finding: `context/archive/2026-10-19-game-room-turn-loop-spike/spike-findings.md` (4.7).
- Reservation code: `workers/game/runtime.ts` (`run()`), `workers/game/engine.ts` (`SAFETY_USD`, rate ceilings).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Ledger and limit in the game room

#### Automated

- [x] 1.1 Ledger and limit tests pass — f812349
- [x] 1.2 Idempotency with the limit passes — f812349
- [x] 1.3 Limit validation at the HTTP boundary passes — f812349
- [x] 1.4 Pre-change room keeps playing — f812349
- [x] 1.5 Typecheck passes — f812349

### Phase 2: Archive and record

#### Automated

- [x] 2.1 Archive spend tests pass — 009f2b9
- [x] 2.2 Record and page tests pass — 009f2b9
- [x] 2.3 Local migration applies — 009f2b9
- [x] 2.4 Typecheck passes — 009f2b9

### Phase 3: Estimate on the start form

#### Automated

- [x] 3.1 Pure estimate tests pass — 99d4660
- [x] 3.2 D1 estimate input test passes — 99d4660
- [x] 3.3 Home route tests pass — 99d4660
- [x] 3.4 Typecheck and build pass — 99d4660

#### Manual

- [ ] 3.5 Dev form estimate and a budget abort work (server-rendered estimate checked 99d4660; live browser estimate recompute and over-limit warning verified locally with synthetic D1 on 2026-11-24; manual dev budget-abort drill with a stub or real key not yet run)

### Phase 4: Production rollout and check

#### Automated

- [ ] 4.1 CI applies migration 0004 and deploys; healthz passes

#### Manual

- [ ] 4.2 A $0.05-limit production game aborts under its limit
- [ ] 4.3 A default-limit production game finishes; estimate recorded
- [ ] 4.4 New archives carry limit and ledger
