# Headless Batch Runs Implementation Plan

## Overview

Roadmap S-09 (US-02; FR-016, FR-003's rotation mode, FR-014's batch limit). The operator sets up a batch of 2–20 headless games, sees its estimated cost, sets a batch spend limit, and starts it. Up to three games run at once. The batch never spends past its limit, every game it starts lands in the archive, and a batch page shows progress, every game, and the S-08 metrics computed over just that batch.

## Current State Analysis

- **One game per Durable Object.** `GameRoom` (`workers/game-room.ts`) delegates real games to `LiveGame` (`workers/game/runtime.ts`), which runs one turn attempt per alarm, settles a per-game spend ledger (`live_game.charged_usd`, S-07), and archives terminal games to D1 through an outbox (`live_archive`) that retries forever. Rooms are named `live:<uuid>` (`liveRoom()` in `workers/game/routes.ts`).
- **Starting a game** goes through `POST /api/games/start` → `GameRoom.startLive(id, passes, setup?, limit?)` → `LiveGame.start`. That path is idempotent on `(id, passes, setup, limit)` and returns 409 if the same ID is reused with different settings. Before writing anything, it checks every seated model against the public OpenRouter catalog (`unsafePricing`) and returns 503 if the check fails.
- **The spend guarantee is per game.** Before every attempt, `LiveGame.run()` aborts with `spend_limit` if `charged_usd + attemptAllowance(body) > effectiveLimit(game)`. A finished game's `charged_usd` is at most its limit and at least its real spend.
- **Roles are always shuffled.** `createGame` (`workers/game/engine.ts:106`) resolves seats (`resolveSeats`, `workers/game/setup.ts`) and then shuffles `rolesFor(seats)`. That shuffle exists so that "a seat's model never decides its role" in single games. Nothing can yet force a model onto a role, which exact rotation needs.
- **The gate accepts `Authorization: Bearer <ACCESS_KEY>`** (`app/access.server.ts:107`), so the JSON API works from curl with no new auth.
- **Metrics take a filter.** `readMetricRows(db, { seats })` binds one parameter `?1` into `IN_SCOPE` (`workers/game/metrics.ts:65`). The page components (`Ratio`, `Rate`, `Table`, `Section`, `Body`) are local to `app/routes/metrics.tsx`.
- **The archive has no batch concept.** `games` has no batch column (`migrations/0001`–`0004`). `listRecentGames` returns every game.
- **The cost estimate** (`estimateCost(setup, passes, inputs)` in `workers/game/estimate.ts`) prices one game from archive history. A "Random" seat costs the pool mean.
- **Durable Object classes are one-way.** `wrangler.jsonc` has migration `v1` (GameRoom). A new class needs `v2`, after which `wrangler rollback` cannot go back past it. Tests load the same `wrangler.jsonc` via `test/worker.ts`, which re-exports the DO classes.

## Desired End State

- `/batches` lists batches (newest first: status, mode, games, spent/limit) and has a **New batch** form. It offers two modes:
  - **Repeat a setup:** the home page's seat/pool editor. "Random" seats are redrawn for every game.
  - **Rotate models:** pick a pool. Each model plays each role equally often, within one seat.
  The form also takes game count (2–20), discussion rounds, a batch limit ($0.10–$20, default $5) and a per-game limit ($0.05–$5, default $1). It shows "Estimated cost ≈ $x for N games" and warns when the estimate is above the batch limit.
- Starting redirects to `/batches/<id>`. That page shows status, spend ("$charged settled · $escrow held · limit $L"), one row per slot (pending, starting, running, finished, aborted, failed to start, skipped for budget, cancelled), and a link to each game. Below that are the S-08 metric sections over the batch's archived games. It refreshes while the batch runs and has a **Cancel batch** button.
- At most 3 games run at once. When a game ends, its unspent escrow returns to the batch and the next slot starts.
- At every moment, the settled charges plus the escrow held by running games are at most the batch limit. So is the batch's total spend.
- Cancel stops new starts and aborts every running game at its next turn with `cancelled`. Every game that started is archived.
- Batch games carry `batch_id` in the archive. Home's "Recent games" leaves them out and links "Batches →". A batch game's page links back to its batch.

Verify: the automated suite, then the Phase 4 drills in production.

### Key Discoveries:

- **Escrow reuses S-07 instead of reworking it.** A game started with limit `l` can never charge more than `l` (the S-07 invariant, already tested). The batch only has to make sure the limits it hands out plus the charges already settled never exceed the batch limit. No call goes from the game to the batch on any turn.
- **`charged_usd` is the right thing to settle against, not `total_cost_usd`.** It is at least the real spend: unknown-cost and lost attempts keep their worst-case charge. Settling against it keeps the batch bound true even if the provider under-reports cost.
- **Starts are already idempotent by game ID.** If the batch picks a slot's game ID and limit before calling `startLive`, a retry after a crash or a lost RPC reply resumes the same game instead of starting a second one.
- **Exact rotation needs forced roles,** but single games must keep their shuffle. Seats with forced roles are accepted only on the internal path the batch uses. The public start API keeps rejecting them.

## What We're NOT Doing

- No shared per-turn batch ledger, and no moving budget between games that are already running.
- No dedicated CLI script. The JSON API with the Bearer key is the headless path.
- Aborted games are not replaced, and a batch does not retry until N games finish.
- Concurrency is not configurable (fixed at 3 in a tuning constant), and batches are not scheduled or recurring.
- Personalities are not balanced in rotation mode. They stay random per game, distinct within a game.
- No archive filters for model, role, outcome or date (S-10), and no batch filter on the global `/metrics` page. Batch-scoped metrics live on the batch page.
- No per-batch comparison or charts. No change to seat count or roles (S-05).
- Batch games are not re-run with a different setup, and slot settings cannot be edited after start.

## Implementation Approach

Bottom-up, so each phase can be tested on its own. Phase 1 makes a game "batch-aware": it carries a batch ID, can take forced roles on an internal path, reports its ledger, and can be cancelled. It also adds the D1 columns that the archive and metrics need. Phase 2 adds pure planning and escrow functions, then the `BatchRoom` Durable Object. That object is an alarm-driven supervisor that keeps all its state in its own SQLite, polls its games, and copies its summary to D1 through an outbox, following `LiveGame`'s patterns. Phase 3 adds the pages. Phase 4 deploys and drills.

## Batch rules

These pin the behaviour that tests assert:

- **Slot plan.** At start, the batch writes N slots, each with a UUID game ID and a concrete per-game setup. In template mode every slot gets the template unchanged, and its "Random" seats are drawn in `createGame` as usual. In rotation mode every slot gets 8 concrete seats with a model, a personality and a forced role.
- **Rotation balance.** Over the batch, for each role (Werewolf, Seer, Villager), the counts any two pool models received differ by at most 1, and so do their total seat counts. Seat order within a game is shuffled, so a seat's position says nothing about its role. A single-model pool is allowed: it is a mirror batch.
- **Escrow.** `available = batchLimit − Σ settled charges − Σ escrow of starting/running slots`, floored to whole cents. A pending slot starts only while fewer than 3 slots are starting or running and `available ≥ $0.05`. Its limit is `min(gameLimit, available)`. The escrow is recorded together with the slot's move to `starting`, in one transaction, before the RPC. When the game is terminal, the slot settles: escrow becomes 0 and its settled charge is the game's `charged_usd`.
- **Budget skip.** When `available < $0.05` and no slot is starting or running, every pending slot becomes `skipped_budget`.
- **Start failures.** A 503 or a thrown RPC is retried with the same ID and limit, at most 3 attempts, `startRetryMs` apart. After that the slot becomes `start_failed`. Any other non-OK result (400/409) fails it at once. A failed slot releases its escrow and settles at $0. That is safe because a failed `startLive` writes nothing and so spends nothing.
- **Cancel.** The batch moves to `cancelling`. Pending slots become `cancelled`. Starting/running slots get `cancelLive()` on every alarm until they are terminal, then settle like any other game. Once nothing is starting or running, the batch becomes `cancelled`.
- **Completion.** When every slot is terminal, a running batch becomes `done`, or `cancelled` if it was cancelling. The batch does not wait for its games to be archived; the batch page notes games still archiving.
- **Bounds.** 2–20 games. Batch limit $0.10–$20 (default $5), whole cents. Per-game limit $0.05–$5 (default $1, S-07's `parseSpendLimit`). The per-game limit must not exceed the batch limit.

## Critical Implementation Details

**State sequencing.** The slot's move to `starting`, its game ID, its limit and its escrow commit in one `transactionSync` before `startLive` is called, and the alarm is re-armed before the RPC is awaited. A crash mid-call then leaves a `starting` slot whose escrow is still counted. The next alarm re-sends the identical, idempotent start. If the escrow were recorded after the call, a crash could start a game whose limit the batch never counted.

**Timing & lifecycle.** `BatchRoom` follows `LiveGame`'s rules. All state lives in SQLite. Each alarm does one bounded pass (settle, start, persist, re-arm), guarded by an in-memory `inFlight` flag. The alarm is always re-armed while the batch is not terminal or its D1 copy is not current. RPCs to game rooms can be slow, so `cancel()` and `snapshot()` must never wait for a pass to finish. Cancel only writes the status, and the next pass acts on it.

**Cancel racing an in-flight turn.** `LiveGame.cancel()` aborts through the existing `abort()`. If a turn's LLM call is in flight, its reply hits the existing "stale result" check in `run()` (status no longer `running`) and is dropped. That attempt's allowance stays charged, so the ledger is still at least the real spend.

## Phase 1: Batch-aware games and the archive

### Overview

Games can belong to a batch, can be started with forced roles on an internal path, report their ledger, and can be cancelled. The archive and metrics learn about batches.

### Changes Required:

#### 1. Setup and engine

**File**: `workers/game/setup.ts`, `workers/game/engine.ts`

**Intent**: Allow a seat to carry a forced role, accepted only when the batch asks for it, so rotation can balance roles exactly while single games keep their shuffle.

**Contract**: `SeatChoice` gains an optional `role?: Role`. `parseSetup(value, { allowRoles = false } = {})`: with `allowRoles`, roles are all-or-none; when present, every seat's model and personality must be concrete (not `"random"`), and the role multiset must equal `rolesFor(seats.length)`. Without `allowRoles`, any `role` key is rejected with the existing "Each seat needs a model and a personality." error. `canonicalSetup` includes roles when present. `createGame` uses forced roles in seat order instead of shuffling when every seat has one. `Game` gains an optional `batchId?: string`, and `createGame` takes it as an option. `PublicGame` exposes `batchId: string | null`.

#### 2. Game room

**File**: `workers/game/runtime.ts`, `workers/game-room.ts`

**Intent**: Give the batch the three calls it needs (start as part of a batch, read the ledger, cancel) without changing single-game behaviour.

**Contract**:
- `GameRoom.startLive(gameId, passes, setup?, limit?, batchId?)`. The `batchId` is stored on the game and is part of the idempotency comparison (same ID with a different `batchId` → 409). When `batchId` is set, `setup` is parsed with `allowRoles: true`. The HTTP route never passes `batchId`.
- `GameRoom.getBatchView(): Promise<{ status: "running" | "finished" | "aborted"; chargedUsd: number; winner; abortReason } | null>`. This reads `live_game.state` and `live_game.charged_usd`, and calls `touch()` first like the other readers.
- `GameRoom.cancelLive(): Promise<void>`. If the live game is running, it aborts with reason `cancelled` through `LiveGame.abort`. Otherwise it does nothing. It is idempotent.

#### 3. Migration and archive

**File**: `migrations/0005_batches.sql`, `workers/game/archive.ts`, `workers/game/record.ts`

**Intent**: Persist which batch a game belongs to and keep a durable, listable copy of each batch.

**Contract**: Migration `0005` (additive):
- `ALTER TABLE games ADD COLUMN batch_id TEXT` plus the index `games_batch_id (batch_id)`.
- `CREATE TABLE batches (id TEXT PRIMARY KEY, status TEXT NOT NULL, mode TEXT NOT NULL, game_count INTEGER NOT NULL, discussion_passes INTEGER NOT NULL, spend_limit_usd REAL NOT NULL, game_limit_usd REAL NOT NULL, charged_usd REAL NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER, version INTEGER NOT NULL, summary_json TEXT NOT NULL)`, where `summary_json` holds the slot list and the request, plus the index on `created_at DESC`.

`GameRecord` gains `batchId: string | null` (from `game.batchId`). `writeArchive` writes `batch_id`. `listRecentGames` adds `WHERE batch_id IS NULL`. New `upsertBatch(db, row)` does `INSERT … ON CONFLICT (id) DO UPDATE … WHERE excluded.version > batches.version`, so a delayed write can never roll a batch back. New `listBatches(db, limit)`.

#### 4. Metrics filter

**File**: `workers/game/metrics.ts`

**Intent**: Let the batch page compute S-08 metrics over one batch with the same definitions.

**Contract**: `MetricFilter` gains `batchId?: string`. `IN_SCOPE` becomes `(?1 IS NULL OR g.seat_count = ?1) AND (?2 IS NULL OR g.batch_id = ?2)`, and every query binds both. `seatCounts` stays global.

#### 5. Game page and abort reason

**File**: `app/routes/games.$gameId.tsx`

**Intent**: Explain the new abort reason and link a batch game back to its batch.

**Contract**: `abortMessage("cancelled")` → "The batch was cancelled." When `batchId` is set on the live or archived game, show a "Part of a batch →" link to `/batches/<batchId>`.

### Success Criteria:

#### Automated Verification:

- Setup tests pass: forced roles are accepted only with `allowRoles`, are all-or-none, must be concrete, and must match the composition. `createGame` keeps forced roles in seat order and still shuffles without them.
- Game room tests pass: a batch start is idempotent including `batchId`; `getBatchView` reports the ledger; `cancelLive` aborts a running game with `cancelled` and archives it; a reply that arrives after cancel is dropped; `cancelLive` on a terminal game does nothing; the HTTP start route rejects a `role` key.
- Archive and metrics tests pass: `batch_id` round-trips; `listRecentGames` excludes batch games; `upsertBatch` ignores an older version; metrics filtered by `batchId` count only that batch's games.
- Local migration applies: `npm run db:migrate:local`
- Typecheck passes: `npm run typecheck`

**Implementation Note**: After automated verification passes, pause for the operator before Phase 2.

---

## Phase 2: Batch engine and API

### Overview

Pure planning and escrow functions, the `BatchRoom` Durable Object that runs a batch, and its JSON API.

### Changes Required:

#### 1. Planning and escrow

**File**: `workers/batch/plan.ts` (new)

**Intent**: Keep every batch decision pure and unit-testable: parsing a request, planning slots, rotation balance, escrow arithmetic and the batch estimate.

**Contract**:
- `parseBatchRequest(value): BatchRequest | { error }`, where `BatchRequest = { mode: "template", setup: GameSetup } | { mode: "rotation", pool: string[] }` plus `{ gameCount, discussionPasses, spendLimitUsd, gameLimitUsd }`. It enforces the bounds in **Batch rules**, reuses `parseSetup` and `parseSpendLimit`, and rejects a per-game limit above the batch limit.
- `planRotation(pool, gameCount, pick): GameSetup[]` returns concrete seats with forced roles that meet **Rotation balance**, with distinct personalities per game.
- `planSlots(request, pick): { gameId: string; setup: GameSetup }[]`.
- `available(limit, slots)` and `nextStart(limit, gameLimit, slots, concurrency)`. The latter returns the slot to start and its limit, or `null`, and applies the whole-cent floor and the $0.05 minimum.
- `estimateBatch(request, inputs): Estimate & { perGameUsd }`. This is `gameCount × estimateCost(...)`; rotation prices every seat as "Random" over the pool, because balance makes the pool mean exact on average.

One way to build rotation, as a hint and not a requirement: list every role slot in the batch grouped by role, deal pool models to that list in one continuous cycle from a shuffled pool, give game `g` the `g`-th Seer and the `g`-th block of Werewolf and Villager slots, then shuffle each game's seats. The tests check the contract, not the algorithm.

#### 2. BatchRoom Durable Object

**File**: `workers/batch-room.ts` (new), `wrangler.jsonc`, `workers/app.ts`, `test/worker.ts`

**Intent**: Supervise one batch durably: start games under the escrow, settle them, handle retries, cancel and budget skips, and keep the D1 copy current.

**Contract**:
- Binding `BATCH_ROOM`, class `BatchRoom`, DO migration `{ "tag": "v2", "new_sqlite_classes": ["BatchRoom"] }` with a comment that it is one-way, like `v1`. Exported from both entries. `npm run cf-typegen` regenerates `Env`.
- Named `batch:<uuid>`; `batchRoom(env, id)` helper in `workers/batch/routes.ts`.
- SQLite tables: `batch` (singleton: request JSON, status, created/ended, version, `d1_version`) and `slots` (index, game_id, setup JSON, status, limit_usd, escrow_usd, charged_usd, start_attempts, next_start_at, winner, abort_reason).
- RPC methods:
  - `start(id, request): Promise<{ ok: true } | { ok: false; status; error }>`. Idempotent on `(id, request)`; 409 if reused with a different request.
  - `snapshot(): Promise<BatchSnapshot | null>`: request, status, slots, settled, escrow, available.
  - `cancel(): Promise<BatchSnapshot | null>`: no-op if terminal.
- `alarm()`, one pass:
  1. For each starting/running slot, `getBatchView()`. Settle terminal ones; move `starting` → `running` once the game exists.
  2. If cancelling, `cancelLive()` every non-terminal game.
  3. Start pending slots through `nextStart`. Each start runs the sequence in **Critical Implementation Details**, then calls `liveRoom(env, gameId).startLive(gameId, passes, setup, limit, batchId)`.
  4. Apply budget skip and completion.
  5. Bump `version` on any change, and if `d1_version < version`, call `upsertBatch` (failure logged and retried next pass).
  6. Re-arm after `pollMs` while non-terminal or the D1 copy is stale, using the backoff `archiveTuning` uses for repeated D1 failures.
- Tuning (mutable for tests): `batchTuning = { concurrency: 3, pollMs: 15_000, startRetryMs: 60_000, maxStartAttempts: 3 }`.
- Structured logs: `batch_started`, `batch_slot_started`, `batch_slot_settled`, `batch_slot_failed`, `batch_ended`, `batch_sync_failed`.

#### 3. API routes

**File**: `workers/batch/routes.ts` (new), wired from `workers/app.ts` and `test/worker.ts` after the gate

**Intent**: A headless JSON surface, usable with the Bearer key, that the pages also call through, as `home.tsx` does for games.

**Contract**:
- `POST /api/batches/start` with `{ requestId, mode, gameCount, discussionPasses, setup? | pool?, spendLimitUsd?, gameLimitUsd? }`. Same Origin check and 4 KB cap as the game start, strict key whitelist. Returns `{ batchId, batchUrl: "/batches/<id>" }`.
- `GET /api/batches/<id>` → snapshot or 404.
- `POST /api/batches/<id>/cancel` → snapshot or 404, with the Origin check.
- `Cache-Control: no-store` throughout.

### Success Criteria:

#### Automated Verification:

- Plan tests pass: request bounds and errors; rotation balance for pool sizes 1, 2, 3 and 6 against 2, 7, 12 and 20 games (per-role and total counts within 1, distinct personalities per game, forced roles match the composition); escrow arithmetic, whole-cent floor, $0.05 minimum, and per-game limit capped by what is available.
- BatchRoom tests pass, with stubbed provider responses as in `test/live-game.test.ts`:
  - A 4-game batch never runs more than 3 games at once and finishes `done` with every game archived under its `batch_id`.
  - The bound holds after every alarm: settled + escrow ≤ limit.
  - A tight limit ($0.10, per-game $0.05) skips the remaining slots for budget, and the spend sums stay ≤ $0.10.
  - A 503 start is retried and then fails the slot.
  - A crash between the escrow write and the RPC resumes the same game.
  - Cancel aborts running games with `cancelled` and marks pending slots cancelled.
  - The D1 copy matches the final snapshot, and a failed D1 write is retried.
- Route tests pass: auth through the gate (cookie and Bearer), bounds → 400, idempotent start, 409 on reuse, cancel, and 404 for unknown IDs.
- Typecheck and build pass: `npm run typecheck && npm run build`

**Implementation Note**: After automated verification passes, pause for the operator before Phase 3.

---

## Phase 3: Batch pages

### Overview

Start, follow, cancel and review batches in the browser.

### Changes Required:

#### 1. Shared metrics components

**File**: `app/components/metrics.tsx` (new), `app/routes/metrics.tsx`

**Intent**: Render the same metric sections on the batch page without forking S-08's presentation.

**Contract**: Move `Ratio`, `Rate`, `Table`, `Section` and `Body` (exported as `MetricSections`) out of `metrics.tsx`. The `/metrics` page renders exactly as before.

#### 2. Batch list and new-batch form

**File**: `app/routes/batches.tsx` (new), `app/routes.ts`

**Intent**: The US-02 entry point: set up a batch, see its estimate, and start it.

**Contract**:
- The loader returns `listBatches(db, 20)` and estimate inputs. Each is null if the archive fails, so the form still works.
- The form has:
  - a mode switch;
  - template mode: the seat/pool editor (extract `StartForm`'s seat and pool fieldsets from `home.tsx` into a shared component);
  - rotation mode: pool checkboxes;
  - game count, discussion rounds, batch limit and per-game limit.
- The estimate line is recomputed in the browser like home's: "Estimated cost ≈ $x for N games (≈ $y each)". An amber warning appears when the estimate is above the batch limit, saying later games will likely be skipped.
- The action posts to `/api/batches/start` the way home's action does, echoes choices on error, and redirects to `batchUrl` on success.

#### 3. Batch page

**File**: `app/routes/batches.$batchId.tsx` (new)

**Intent**: Follow a batch live and review its aggregated results.

**Contract**:
- The loader reads `batchRoom(env, id).snapshot()`, falling back to the D1 row's `summary_json` if the room has no state. It returns 404 when neither exists. It also loads `loadMetrics(db, { batchId })`, which is null on failure.
- The page shows:
  - a status header with "N of M games done · X running";
  - spend: settled, held in escrow, limit;
  - a slot table with status, winner or abort reason, the game's limit and charge, and a link to `/games/<id>` for any slot that started;
  - a note when finished games are still archiving (slot terminal but not yet counted in metrics);
  - `MetricSections` under "Results across this batch".
- While the batch is running or cancelling, the page revalidates every 15 s.
- Cancel is a form whose action calls the cancel route. It is only shown while running.

#### 4. Home

**File**: `app/routes/home.tsx`

**Intent**: Point to batches and keep the recent list for single games.

**Contract**: Add a "Batches →" link beside "Metrics →". The seat/pool fieldsets come from the shared component, with no visible change.

### Success Criteria:

#### Automated Verification:

- Route tests pass:
  - `/batches` renders with and without an archive, and the action validates and redirects.
  - `/batches/<id>` renders a running and a finished batch from the room, and a finished batch from D1 alone; unknown IDs return 404.
  - The cancel action works.
  - `/metrics` output is unchanged.
  - Home shows the Batches link and excludes batch games from recent.
- Typecheck and build pass: `npm run typecheck && npm run build`

#### Manual Verification:

- In dev (`npm run dev`, real OpenRouter key in `.dev.vars`), a 2-game rotation batch with a $0.30 limit:
  - the estimate updates as the mode, pool and count change;
  - the batch page shows games starting and settling and refreshes itself;
  - the game links open the live viewer;
  - results appear when it ends.
- In dev, cancelling a running batch aborts its games with "The batch was cancelled.", and both games appear in the archive.

**Implementation Note**: After automated and manual verification pass, pause for the operator before Phase 4.

---

## Phase 4: Production rollout and drills

### Overview

Deploy, then prove the budget bound and the US-02 path in production with two small batches.

### Changes Required:

#### 1. Verification record

**File**: `context/changes/headless-batch-runs/verification.md` (new)

**Intent**: Record the automated results, the dev checks and both drills with their numbers, as the earlier slices did.

**Contract**: Sections for Automated, Dev, Production, with each drill's batch ID, limit, settled charge, OpenRouter activity total for its window, and hand counts.

### Success Criteria:

#### Automated Verification:

- CI applies migration 0005, deploys with DO migration `v2`, and healthz passes.

#### Manual Verification:

- **Budget drill:** a 3-game rotation batch with a $0.30 batch limit and a $0.15 per-game limit:
  - at most 2 games start at once, because of escrow;
  - any slot that cannot be funded is skipped for budget;
  - the batch's settled charge is ≤ $0.30;
  - OpenRouter's activity total for the batch window is ≤ $0.30.
- **Results drill:** a 10-game template batch at default limits (all seats random over the full pool):
  - it finishes;
  - every started game is archived with its `batch_id`;
  - the estimate shown before start is recorded next to the settled charge;
  - one batch metric (win rate for one model) matches a hand count over that batch's games in remote D1.
- Home's recent list shows no batch games, and the Batches link and batch list work in production.

---

## Testing Strategy

### Unit Tests:

- `parseSetup` with forced roles (all-or-none, concrete, composition, `allowRoles` gate). `createGame` with and without forced roles.
- `parseBatchRequest` bounds and errors. `planRotation` balance across a grid of pool sizes and game counts. `nextStart` escrow arithmetic, including the whole-cent floor, the $0.05 minimum, and a per-game limit larger than what is available.
- `estimateBatch` for both modes, with no history and with mixed history.

### Integration Tests:

- `BatchRoom` against stubbed provider responses (the `test/live-game.test.ts` fetch stubs):
  - concurrency cap;
  - settle and refill;
  - budget skip;
  - start retry then failure;
  - crash between the escrow write and the RPC (simulate by running the start transaction and then re-running the alarm);
  - cancel mid-turn;
  - D1 outbox retry.

  Assert the bound (settled + escrow ≤ limit) after every alarm, as S-07's tests do for the per-game ledger.
- Archive: `batch_id` round-trip, recent-list exclusion, batch-filtered metrics against hand-computed figures on a seeded archive with two batches and some single games.
- Routes: gate, bounds, idempotency, cancel, 404.

### Manual Testing Steps:

1. Dev: start a 2-game rotation batch with a $0.30 limit and watch the batch page through to results.
2. Dev: start a batch and cancel it while games run. Both games are archived as cancelled.
3. Production: the budget drill, compared against OpenRouter activity.
4. Production: the 10-game results drill, with a hand count of one metric.

## Performance Considerations

- Three running games are three live game DOs plus one batch DO waking every 15 s. A 20-game batch is about 50 turns × 20 games = 1,000 turn alarms plus about 200 supervisor alarms, well within Workers limits. The batch DO is billed only while its short passes run.
- Batch-filtered metrics use the new `games_batch_id` index, and nothing on the batch page loads `state_json`.
- Three concurrent 8-seat games stay well under the per-model rate limits the catalog was checked against. 429s are already retried per turn.

## Migration Notes

- `0005` is additive. Existing games read `batch_id` as null and stay in home's recent list. CI applies it before the deploy that needs it.
- DO migration `v2` is one-way. After deploying, `wrangler rollback` cannot go back to a version without `BatchRoom`. A bad release is fixed forward. Never rename or remove `BatchRoom`, and evolve its SQLite schema in code as `GameRoom` does.
- Rooms from before this change have no `batchId`. `startLive` without `batchId` behaves exactly as before.

## References

- Roadmap: `context/foundation/roadmap.md` (S-09)
- PRD: US-02, FR-003, FR-014, FR-016 in `context/foundation/prd.md`
- Per-game ledger this builds on: `context/changes/spend-limit-and-estimate/plan.md`, `workers/game/runtime.ts` (`LiveGame.run`)
- Metrics definitions: `context/archive/2026-11-14-game-metrics/plan.md`
- Outbox pattern: `workers/game/runtime.ts` (`archive`, `touch`)
- Similar start path: `workers/game/routes.ts`, `app/routes/home.tsx` (`action`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Batch-aware games and the archive

#### Automated

- [x] 1.1 Setup tests pass
- [x] 1.2 Game room tests pass
- [x] 1.3 Archive and metrics tests pass
- [x] 1.4 Local migration applies
- [x] 1.5 Typecheck passes

### Phase 2: Batch engine and API

#### Automated

- [ ] 2.1 Plan tests pass
- [ ] 2.2 BatchRoom tests pass
- [ ] 2.3 Route tests pass
- [ ] 2.4 Typecheck and build pass

### Phase 3: Batch pages

#### Automated

- [ ] 3.1 Route tests pass
- [ ] 3.2 Typecheck and build pass

#### Manual

- [ ] 3.3 Dev rotation batch runs end to end
- [ ] 3.4 Dev cancel aborts and archives running games

### Phase 4: Production rollout and drills

#### Automated

- [ ] 4.1 CI applies 0005 and deploys v2; healthz passes

#### Manual

- [ ] 4.2 Budget drill stays under its limit
- [ ] 4.3 Results drill finishes and matches a hand count
- [ ] 4.4 Home excludes batch games; batch pages work in production
