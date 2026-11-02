# Game Record With Private Reasoning Implementation Plan

## Overview

Roadmap S-03 (FR-009). The operator reopens any finished or aborted game and reads its full record: every public statement and every individual vote in order, each with the agent's private rationale beside it, plus the private night actions inline, with all roles revealed. Terminal games are archived to Cloudflare D1, the first persistence outside a game room, so later slices (S-07 spend aborts, S-08 metrics, S-10 browse, S-11 integrity) build on one queryable archive.

## Current State Analysis

- A live game is one JSON `Game` blob in the room's `live_game` table (`workers/game/runtime.ts:37`), with per-turn provider data in `live_turns` (body, response, cost, generation id, latency, attempts).
- Every move already has a private rationale in one model-agnostic shape: the request contract asks for `{text|target, rationale}` (`workers/game/engine.ts:100`), `validateMove` enforces it, and `applyMove` appends `{actor, phase, day, move}` to `game.privateMoves`. Native model reasoning is disabled (`reasoning: { enabled: false }`). FR-009's "same kind of rationale for every model" is therefore already true at capture time; S-03 persists and displays it.
- `privateMoves[i]` is the move of turn `i + 1` (`game.turn` increments once per move), which matches `live_turns.turn_no`.
- The public transcript (`Entry[]`) carries no turn numbers. Speech entries map 1:1, in order, to `discuss` moves. Votes appear as one combined `votes` entry per day. Investigations and kills have no public entry except the resulting death.
- On a terminal transition the room deletes its alarm (`runtime.ts:81`, `runtime.ts:142`) and nothing outside it ever reads the game. `publicGame` reveals roles only when `status === "finished"`.
- `/games/:gameId` (`app/routes/games.$gameId.tsx`) renders the live viewer from `getLiveSnapshot()` and a WebSocket of `PublicGame` events. Home (`app/routes/home.tsx`) has only the start form.
- No database binding exists. `wrangler.jsonc` has one DO binding and a one-way `v1` DO migration. Tests run in the Workers runtime via `@cloudflare/vitest-plugin`, which provides `readD1Migrations` (Node config side) and `applyD1Migrations(db, migrations)` (`cloudflare:test`).
- Production holds three finished S-02 drill games (IDs in `context/archive/2026-10-29-first-live-ai-game/verification.md`) and possibly a few more.

## Desired End State

- Every game that reaches `finished` or `aborted` is written once to D1 (`games`, `game_players`, `game_moves`, plus the full engine state JSON). The room retries until the write lands, so a D1 outage delays the archive but never loses a game.
- `/games/:id` for a terminal game shows the record: header (outcome or abort reason, date, duration, model, total known cost), all players with roles, and a single timeline in which public entries show their rationale beside them, each vote is listed individually with its rationale, and night actions appear inline as clearly marked private entries ("Cora (Seer) checked Dax → Werewolf"). It reads D1. If the game is not archived yet, it renders the identical record from the room with an "Archiving…" badge.
- A running game's viewer is unchanged and never receives rationale, roles or night actions. When its terminal event arrives, the page reloads into the record.
- Home lists the 20 most recently archived games, newest first, each linking to its record.
- The three drill games appear in the archive after being opened once.

Verify: the automated suite below, then the Phase 4 production drill (one new game, three reopened drill games, rows confirmed with `wrangler d1 execute --remote`).

### Key Discoveries:

- Move ↔ turn ↔ cost alignment: `privateMoves[i]` ↔ `live_turns.turn_no = i + 1` (`workers/game/engine.ts:166`, `workers/game/runtime.ts:130`).
- Investigation results live in `game.investigations`, in the same order as the Seer's `investigate` moves (`workers/game/engine.ts:168`).
- Terminal time is not in `Game`; the terminal event's `created_at` in the room's `events` table is available for both new and legacy games (`workers/game-room.ts:380`).
- The test entry (`test/worker.ts`) and the vitest config read `wrangler.jsonc`, so a D1 binding declared there is provisioned locally by Miniflare. Migrations still have to be applied in test setup.
- Roadmap S-08 risk: "check S-03's record covers every input first". Per-move cost, latency, attempts and generation id go into `game_moves` now, even though the page shows only totals.

## What We're NOT Doing

- Filtering, search, pagination or batch views of the archive (S-10). The home list is a fixed "latest 20".
- Integrity verification or hashing (S-11). Crash handling beyond today's `aborted` states is not extended.
- Role visibility toggle on the live viewer (S-04). Live data stays exactly as private as today.
- Native model reasoning tokens. The normalized self-reported rationale is the record's reasoning form.
- Step-by-step replay (FR-017, parked).
- Deleting archived games, or an admin backfill endpoint. Legacy rooms archive when opened.
- Archiving spike rooms (`/spike/...`).
- Changing engine rules, prompts or the `Game` state shape.

## Implementation Approach

The room stays the source of truth during play and becomes an outbox at the end. The terminal transaction also marks an archive as pending and schedules the room's alarm. The alarm writes the record to D1 in one atomic `batch` of idempotent inserts, then marks it archived. A pure projection, `buildRecord(state, turns, endedAt)`, produces the same `GameRecord` from either source: the room (state + `live_turns`) or D1 (`state_json` + `game_moves`). Both read paths therefore render identically. The record page and home list are thin views over that type.

## Critical Implementation Details

- **Timing & lifecycle.** `LiveGame.alarm()` returns early for non-running games today, and `abort()`/finish delete the alarm. Both must instead schedule an archive attempt, and `alarm()` must route terminal games with a pending archive to the archive step before the running-game path. The pending mark must commit in the same transaction as the terminal state, so a crash between them cannot skip archiving.
- **State sequencing.** Mark the room `archived` only after the D1 batch resolves. A crash after D1 commits but before the mark causes one more batch, which the `ON CONFLICT DO NOTHING` inserts absorb. Never mark first.
- **Legacy rooms.** Rooms that finished before this ships have no archive row. Any read of a terminal room (snapshot or record) that finds no archive row inserts a pending row and sets an alarm for now. A terminal room never runs a game turn, so this only ever wakes the archive path.

## Phase 1: D1 archive foundation

### Overview

Add the D1 database, its schema and the plumbing that keeps schema and code in step locally, in tests and in CI. No behaviour changes yet.

### Changes Required:

#### 1. Binding and migrations

**File**: `wrangler.jsonc`, `migrations/0001_archive.sql`

**Intent**: Declare the archive database and its first additive migration. The remote database is created once by a human (`npx wrangler d1 create agent-werewolves-archive`); its `database_id` is committed.

**Contract**: `d1_databases: [{ binding: "ARCHIVE", database_name: "agent-werewolves-archive", database_id: "<from create>", migrations_dir: "migrations" }]`. Tables:
- `games(id TEXT PK, status TEXT CHECK IN ('finished','aborted'), winner TEXT NULL, abort_reason TEXT NULL, model TEXT, discussion_passes INT, seat_count INT, days INT, turns INT, total_cost_usd REAL NULL /* sum of known costs */, unknown_cost_turns INT, reserved_usd REAL, created_at INT, ended_at INT, archived_at INT, engine_version INT, state_json TEXT)`, index on `ended_at DESC`.
- `game_players(game_id TEXT, seat TEXT, name TEXT, role TEXT, model TEXT, survived INT, PK(game_id, seat))`, index on `(model, role)`.
- `game_moves(game_id TEXT, turn_no INT, day INT, phase TEXT, actor TEXT, text TEXT NULL, target TEXT NULL, result_role TEXT NULL, rationale TEXT, cost_usd REAL NULL, latency_ms INT NULL, attempts INT, generation_id TEXT NULL, PK(game_id, turn_no))`.

Migrations are additive only (rule recorded in README). `model` sits on `game_players` now, so S-06 needs no schema change.

#### 2. Tests apply migrations

**File**: `vitest.config.ts`, `test/setup.ts`, `test/archive-schema.test.ts`

**Intent**: Tests see a migrated local D1. The config reads the migrations with `readD1Migrations("./migrations")` and passes them as a binding. Setup applies them with `applyD1Migrations(env.ARCHIVE, …)`, which is idempotent.

**Contract**: Binding `TEST_MIGRATIONS` (test-only, declared in a `test/env.d.ts` augmentation). A schema test asserts the three tables and the CHECK constraint exist.

#### 3. Local dev and CI

**File**: `package.json`, `.github/workflows/ci.yml`

**Intent**: `npm run db:migrate:local` applies migrations to the dev database. The CI deploy job runs `npx wrangler d1 migrations apply ARCHIVE --remote` before `npm run deploy`, so a merge ships schema and code together. A failed migration stops the deploy, and the existing rollback instructions still print.

**Contract**: New script `db:migrate:local` = `wrangler d1 migrations apply ARCHIVE --local`. A new deploy-job step precedes `npm run deploy`. The check job is unchanged (`deploy --dry-run` validates the binding).

#### 4. Documentation of the decision

**File**: `context/foundation/tech-stack.md`, `context/foundation/infrastructure.md`, `README.md`

**Intent**: Record that the archive is D1, not Supabase via Hyperdrive (operator decision 2026-11-02), and why. Retire the Supabase pause and Hyperdrive risk rows, and add the D1 limits that matter (10 GB per database, 2 MB per row, batch is one transaction). The README gains a "Database" section covering create once, migrate locally, CI migrates on merge, additive-only migrations, and querying with `wrangler d1 execute --remote`.

**Contract**: The affected prose sections only. The roadmap's S-03 unknown about the Supabase pause is marked resolved.

### Success Criteria:

#### Automated Verification:

- Type checking passes with the new binding: `npm run typecheck`
- Schema test passes and the existing suite stays green: `npm test`
- Build and dry-run deploy pass: `npm run build && npx wrangler deploy --dry-run`
- Local migration applies cleanly: `npm run db:migrate:local`

#### Manual Verification:

- Operator created the remote database and its `database_id` is committed
- Operator confirmed the CI `CLOUDFLARE_API_TOKEN` has D1 edit permission

**Implementation Note**: Pause after this phase for the two human steps before Phase 4 can deploy; Phases 2–3 can proceed locally meanwhile.

---

## Phase 2: Record projection and archive outbox

### Overview

Build the shared record projection and make every terminal room archive itself to D1 reliably.

### Changes Required:

#### 1. Record projection

**File**: `workers/game/record.ts`

**Intent**: A pure function turns engine state plus per-turn data into the record the page renders and the archive writer stores. It also merges the turn-less transcript with the private moves into one ordered timeline.

**Contract**: `buildRecord(game: Game, turns: TurnData[], endedAt: number): GameRecord`, where `TurnData = { turnNo, costUsd, latencyMs, attempts, generationId }`. `GameRecord` holds summary fields matching the `games` columns, `players` with roles, `moves` matching `game_moves`, and `timeline: TimelineItem[]`. Timeline rules, applied per day in transcript order:
- Night moves (`investigate`, `kill`) follow that day's `Night N` phase entry as `private` items. An investigation includes its result role from `game.investigations`, paired in order.
- Each `speech` entry carries the rationale of the k-th `discuss` move for that day and actor.
- Each day's `vote` moves follow its `Voting begins` entry as individual `vote` items (voter → target, rationale), before the combined `votes` entry.
- Phase and death entries pass through.
- An aborted game ends after its last committed move. A move without a matching public entry (the abort landed mid-phase) is still emitted, in turn order, as the final items.

Throws if a move references an unknown actor, so a malformed state fails loudly in tests rather than rendering a wrong record.

#### 2. D1 archive writer and reader

**File**: `workers/game/archive.ts`

**Intent**: Write one `GameRecord` atomically and idempotently, and read records back for the page and home list.

**Contract**:
- `writeArchive(db: D1Database, record: GameRecord, stateJson: string): Promise<void>`: one `db.batch([...])` of `INSERT … ON CONFLICT DO NOTHING` across all three tables.
- `readArchivedRecord(db, id): Promise<GameRecord | null>`: rebuilds via `buildRecord` from `state_json` + `game_moves`.
- `listRecentGames(db, limit = 20)`: summary rows ordered by `ended_at DESC, id`.

#### 3. Outbox in the live room

**File**: `workers/game/runtime.ts`, `workers/game-room.ts`

**Intent**: The terminal transition records a pending archive and wakes the alarm. The alarm archives with retry and backoff. Any read of an unarchived terminal room enqueues it, which archives the legacy drill games.

**Contract**:
- New table `live_archive(singleton INT PK CHECK (singleton = 1), status TEXT /* pending|archived */, attempts INT, last_error TEXT NULL, archived_at INT NULL)`, created with `CREATE TABLE IF NOT EXISTS` like the existing live tables.
- Finish and abort insert `pending` in their terminal transaction and set the alarm to now, instead of deleting it.
- `alarm()`: a terminal game with a pending archive runs `archive()`. Failure updates attempts and error, logs `archive_failed {gameId, attempts, error}`, and backs off 30 s, ×4 per attempt, capped at 1 h, retrying indefinitely. Success marks `archived` and logs `game_archived`.
- New DO method `getRecord(): { record: GameRecord; archived: boolean } | null` (terminal games only). It and `getLiveSnapshot()` enqueue an unarchived terminal room that has no archive row.
- A missing `ARCHIVE` binding is a retryable failure, not a crash.

### Success Criteria:

#### Automated Verification:

- Projection tests pass: a finished and an aborted engine-built game, a two-pass discussion, a tie vote, a dead Seer, and a drill-shaped legacy state with no `live_archive` row all yield the expected ordered timeline, with every move appearing exactly once: `npm test -- record`
- Outbox tests pass: a finish archives to D1 with correct rows; an abort archives with its reason; a D1 failure (stubbed `batch` rejects) retries on the alarm and then succeeds; a crash after the D1 commit but before the mark re-runs harmlessly (one row per table key); eviction between the terminal state and the archive still archives; opening a legacy terminal room enqueues and archives it: `npm test -- archive`
- Live privacy regression passes: no running snapshot or WebSocket event contains `rationale`, `privateMoves`, `investigations` or roles; `getRecord()` returns null for a running game: `npm test`
- Typecheck passes: `npm run typecheck`

---

## Phase 3: Record page and recent games list

### Overview

Show the record at the game's URL and give the operator a way back to past games.

### Changes Required:

#### 1. Game route: live or record

**File**: `app/routes/games.$gameId.tsx`

**Intent**: The loader returns either the live snapshot (running) or the record. It tries D1 first, then falls back to the room's `getRecord()` with `archived: false`. The live viewer revalidates the loader when it receives a terminal event, so the page turns into the record in place.

**Contract**: Loader data `{ kind: "live", snapshot } | { kind: "record", record: GameRecord, archived: boolean }`. A 404 for an unknown or invalid id stays as today. The record view shows:
- header: winner, or "Game stopped" with the existing abort message, plus date, duration, model, total known cost (with "n turns cost unknown" when applicable) and an "Archiving…" badge when not archived;
- player cards with roles (aborted games included);
- the timeline. Public items in the existing chronicle styling with the rationale in a visually distinct aside. Private night items styled as private, for example muted with a "Private" label. Vote items grouped under their day's vote header.

#### 2. Recent games on home

**File**: `app/routes/home.tsx`

**Intent**: Below the start form, list up to 20 archived games (date, outcome, model, days), each linking to `/games/:id`. If D1 is unavailable, the form still works and the list shows "Archive unavailable."

**Contract**: The loader adds `recent: RecentGame[] | null`, where null means unavailable. An empty array shows "No archived games yet."

### Success Criteria:

#### Automated Verification:

- Route tests pass: a terminal archived game renders the record from D1; a terminal unarchived game renders from the room with the archiving badge; a running game renders the live viewer without rationale in the HTML; the home list orders newest first and caps at 20; home renders when the D1 query throws: `npm test -- routes`
- Typecheck and build pass: `npm run typecheck && npm run build`

#### Manual Verification:

- In `npm run dev` with a stubbed or real cheap model, the record of a finished game reads clearly: rationale beside each statement and vote, private night actions distinct, roles shown
- A live game turns into its record when it ends without a manual reload

---

## Phase 4: Production rollout and drill

### Overview

Ship through CI, prove the archive on real games, and record the evidence.

### Changes Required:

#### 1. Verification record

**File**: `context/changes/game-record-with-reasoning/verification.md`

**Intent**: Record the deploy, one new production game, the three reopened drill games, D1 row counts, and a spot-check of rationale fidelity against the room. Mirrors the S-02 verification format.

**Contract**: Evidence sections for local checks, the deploy (version id, migration output) and the drill table (game id, status, moves, rows per table, archived_at).

### Success Criteria:

#### Automated Verification:

- CI deploy job applies migration `0001` remotely and deploys; `/healthz` smoke test passes
- `npx wrangler d1 execute agent-werewolves-archive --remote --command "SELECT id, status, turns FROM games ORDER BY ended_at DESC"` lists the new game and the three drill games

#### Manual Verification:

- Operator starts one production game, watches it end, and the page turns into its record
- Each drill game URL opens as a record and then appears in the home list
- For one game, every move's rationale on the page matches its `game_moves` row, and `game_moves` count equals the game's turn count

---

## Testing Strategy

### Unit Tests:

- `buildRecord`: ordering rules per phase, investigation results, tie votes, two discussion passes, dead Seer (night with a kill only), aborted mid-discussion and mid-vote, legacy state, and the unknown-actor throw.
- Cost totals: sum of known costs with a count of unknown ones; `null` when every cost is unknown.

### Integration Tests:

- Full stubbed game through the room → D1 rows → `readArchivedRecord` equals `getRecord()` (same projection, both sources).
- Outbox failure, retry, crash-after-commit and eviction paths (Phase 2).
- Route and loader behaviour for live, unarchived and archived games, and the home list (Phase 3).

### Manual Testing Steps:

1. Locally, run a stubbed game to completion and read the record.
2. Locally, finish a game before running `npm run db:migrate:local` on a fresh dev database. The record shows "Archiving…". Apply the migration and the badge clears after the next retry.
3. In production, the Phase 4 drill.

## Performance Considerations

A record is around 30–60 KB of state JSON plus about 40 rows, well within D1's 2 MB row and batch limits. The home list is one indexed query. Nothing here touches the live turn path except one extra row insert in the terminal transaction.

## Migration Notes

- No Durable Object migration, so `wrangler rollback` stays available. Rolling back to a pre-S-03 version only pauses archiving. Games that end during that window archive the next time they are opened after a roll-forward.
- D1 migrations are additive only. A rollback never needs a down-migration.
- Creating the remote database and confirming the token's D1 permission are human steps (infrastructure.md: production changes need human approval). Merging the PR approves the migration.

## References

- Roadmap item: `context/foundation/roadmap.md` (S-03)
- PRD: FR-009, FR-012 (archive), NFR "Archive kept indefinitely"
- Prior slice: `context/archive/2026-10-29-first-live-ai-game/` (plan, verification with drill game IDs)
- Engine and room: `workers/game/engine.ts`, `workers/game/runtime.ts`, `workers/game-room.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: D1 archive foundation

#### Automated

- [x] 1.1 Type checking passes with the new binding — b892623
- [x] 1.2 Schema test passes and the existing suite stays green — b892623
- [x] 1.3 Build and dry-run deploy pass — b892623
- [x] 1.4 Local migration applies cleanly — b892623

#### Manual

- [x] 1.5 Operator created the remote database and its database_id is committed — e094bea
- [ ] 1.6 Operator confirmed the CI token has D1 edit permission

### Phase 2: Record projection and archive outbox

#### Automated

- [x] 2.1 Projection tests pass — 1543d34
- [x] 2.2 Outbox tests pass — 1543d34
- [x] 2.3 Live privacy regression passes — 1543d34
- [x] 2.4 Typecheck passes — 1543d34

### Phase 3: Record page and recent games list

#### Automated

- [x] 3.1 Route tests pass — cf1d22a
- [x] 3.2 Typecheck and build pass — cf1d22a

#### Manual

- [ ] 3.3 Record of a finished game reads clearly in dev
- [ ] 3.4 A live game turns into its record when it ends

### Phase 4: Production rollout and drill

#### Automated

- [ ] 4.1 CI applies migration 0001 remotely and deploys; healthz passes
- [ ] 4.2 Remote D1 query lists the new game and the three drill games

#### Manual

- [ ] 4.3 Operator plays one production game and sees its record
- [ ] 4.4 Drill game URLs open as records and appear in the home list
- [ ] 4.5 Rationale and move counts match between page and D1 for one game
