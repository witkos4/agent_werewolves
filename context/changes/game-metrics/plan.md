# Game Metrics Implementation Plan

## Overview

Roadmap S-08 (FR-011). The operator opens `/metrics` and sees, computed from the D1 archive, win rate per model and per model × role, vote accuracy, deception success, and cost and latency. Every figure shows the number of games behind it. These are the measurements the product exists for: the comparison of how different models bluff and reason (PRD vision, `learn` goal).

## Current State Analysis

- The archive (`migrations/0001_archive.sql`, `0002_player_persona.sql`) has `games` (status, winner, seat_count, total_cost_usd, unknown_cost_turns, engine_version, state_json), `game_players` (seat, role, model, persona, survived) and `game_moves` (day, phase, actor, target, cost_usd, latency_ms, attempts). Index `game_players_model_role` already exists.
- Day votes are `game_moves` rows with `phase = 'vote'`, an `actor` and a `target`. Roles come from `game_players`, so per-vote accuracy is a join.
- **Deaths are not normalized.** The night kill and the village elimination are only `death` transcript entries inside `state_json`: `"{name} ({seat}) died during the night."` or `"... was eliminated by the village."` (`kill()`, `workers/game/engine.ts`). A tied vote is resolved at random, so the eliminated seat can't be rebuilt from vote rows. Per-elimination accuracy and wolf survival need the death day and cause.
- `survived` covers only the end state.
- Two table shapes exist: version-1 games (S-02/S-03, 5 seats, 1 wolf, one model) and version-2 games (S-06: 5 seats until PR #22, then 8 seats with 2 wolves). `seat_count` tells them apart.
- `game_moves.latency_ms` and `cost_usd` are per committed turn. `cost_usd` is null for unknown-cost turns.
- A day vote only happens while at least one wolf is alive: `victory()` ends the game as soon as the last wolf dies.
- The home loader already reads the archive and degrades when it fails (`app/routes/home.tsx`); the metrics page follows the same pattern.

## Desired End State

- `/metrics` (behind the access-key gate like every route) shows four sections: Win rate, Vote accuracy, Deception, Cost and latency. Each row is a model, using the catalog label (unknown ids show the bare id). Each figure shows its numerator, denominator and game count.
- A seat-count selector (`All`, plus each seat count present in the archive) filters every section.
- Home links to `/metrics`.
- `game_players` has `died_day` and `died_by` for every archived game, including those archived before this change.

Verify: the automated suite, then the Phase 4 production check against hand counts.

### Key Discoveries:

- The backfill can be pure SQL inside the migration: `json_each(games.state_json, '$.transcript')`, filtered to `kind = 'death'` and matching `'(' || seat || ')'` in the text. Seat ids run `p1`–`p9`, so `(p1)` never matches another seat. CI applies migrations before deploying, so no backfill script or manual step is needed, and an older Worker ignores the new nullable columns.
- Nothing on the metrics path reads `state_json`. Thousands of games at ~40 moves each fit comfortably in GROUP BY queries; loading full states would not.

## Metric definitions

These pin the PRD's scoring rules to the archive. **Operator confirmation wanted** on the attribution choices marked ◆.

Scope: outcome metrics (1–3) use `games.status = 'finished'`. Cost and latency (4) use every archived game. Each figure's game count is the number of distinct games that contributed at least one unit to its denominator.

1. **Win rate per model and role.** Unit: a seat. A win is a Werewolf seat in a game won by Werewolves, or a non-wolf seat in a game won by Village, alive or dead (PRD). Shown per model (all roles) and per model × role.
2. **Vote accuracy.**
   - (a) Per vote: day votes (`phase = 'vote'`) cast by non-wolf seats that target a Werewolf, ÷ all day votes cast by non-wolf seats. ◆ Attributed to the **voter's** model, plus an overall figure.
   - (b) Per elimination: village eliminations (`died_by = 'village'`) of a Werewolf ÷ all village eliminations. ◆ **Overall only** (and per seat-count filter): an elimination is a table outcome no single model causes.
3. **Deception success**, ◆ attributed to the **wolf seat's** model.
   - (a) Wolf survival: day rounds survived per wolf seat, averaged. A game's rounds are its distinct `day` values among vote moves. A wolf eliminated on day *d* survived the rounds before *d*. A surviving wolf survived every round held. Shown alongside the mean rounds held, for scale.
   - (b) Votes misdirected: non-wolf day votes that target a non-wolf, ÷ all non-wolf day votes, in games where the model held a wolf seat. Every day vote happens while a wolf is alive, so "while wolves are alive" holds by construction. This is 1 − (2a) computed over the tables that model's wolves sat at.
   - (c) Suspicion dodged: non-wolf votes received per wolf-seat-round, compared with non-wolf votes received per innocent-seat-round **in the same games**. A seat-round is a seat alive when a round's voting began. Shown as both rates and their ratio (below 1.0 means the wolves drew less suspicion than innocents).
4. **Cost and latency.**
   - Per model: total known cost, cost per turn, mean latency per turn, turns with unknown cost, and game count. Turns are attributed to the acting seat's model.
   - Per game: mean known cost per game and mean turns per game, split by status (finished / aborted).

## What We're NOT Doing

- Batch-level aggregation (S-09) and filters by model, role, outcome or date (S-10). Only the seat-count filter, because pooling table shapes makes the numbers misleading.
- Charts, confidence intervals or significance tests. Raw counts sit beside every percentage so small samples are obvious.
- Per-persona metrics (`persona` is already archived; easy to add later).
- Live, in-game metrics while watching.
- Changing the engine's behaviour or the `Game` state shape. `deaths()` reads the transcript the engine already writes.

## Implementation Approach

Normalize the one missing fact (who died when, and how) into `game_players`, then compute everything with a handful of aggregate SQL queries. Ratios and attribution live in a pure TypeScript function over the query rows, so the definitions are unit-tested without D1.

## Critical Implementation Details

- **One parser for deaths.** `deaths(game)` in `engine.ts` reads `death` entries. It is the only code that knows the transcript wording, and a test pins it to `kill()`'s output. The migration's SQL uses the same two phrases (`died during the night`, `eliminated by the village`); a test runs the migration's backfill against archives written by the real engine and compares it with `deaths()`.
- **Idempotent writes.** `writeArchive` already uses `ON CONFLICT DO NOTHING`. The new columns are part of the same insert. Rows archived by an older Worker during the rollout window get null deaths; Phase 4 reruns the backfill UPDATE once after the deploy, and the UPDATE only touches rows where `died_day IS NULL AND survived = 0`.
- **Wolves never die at night.** The kill phase excludes wolves from `allowedTargets`. The metrics treat a wolf with `died_by = 'night'` as a data error and leave it out of survival, rather than guessing.

## Phase 1: Death columns

### Overview

Record each seat's death day and cause in the archive, for new games and by backfill for existing ones.

### Changes Required:

#### 1. Death helper

**File**: `workers/game/engine.ts`

**Contract**: `deaths(game: Game): Record<string, { day: number; by: "night" | "village" }>`, keyed by seat id, built from `death` transcript entries. Throws on an unrecognised death entry.

#### 2. Record and archive

**Files**: `workers/game/record.ts`, `workers/game/archive.ts`

**Contract**: `RecordPlayer` gains `diedDay: number | null` and `diedBy: "night" | "village" | null`, filled by `buildRecord` from `deaths()`. `writeArchive` inserts them into `game_players`.

#### 3. Migration

**File**: `migrations/0003_player_death.sql` (new)

**Contract**: `ALTER TABLE game_players ADD COLUMN died_day INTEGER;`, `ALTER TABLE game_players ADD COLUMN died_by TEXT;`, then one `UPDATE game_players SET died_day = …, died_by = …` with correlated subqueries over `json_each(games.state_json, '$.transcript')`, limited to `survived = 0 AND died_day IS NULL`.

### Success Criteria:

#### Automated Verification:

- 1.1 Engine tests: `deaths()` on a finished 8-seat game matches the players who died, by day and cause: `npm test -- live-engine`
- 1.2 Archive tests: a newly archived game has `died_day`/`died_by`; running the migration's UPDATE over rows with the columns cleared restores the same values: `npm test -- archive`
- 1.3 Record tests stay green, including the version-1 fixture: `npm test -- record`
- 1.4 Local migration applies: `npm run db:migrate:local`
- 1.5 Typecheck passes: `npm run typecheck`

---

## Phase 2: Metrics queries and aggregation

### Overview

Compute every metric from the archive.

### Changes Required:

#### 1. Metrics module

**File**: `workers/game/metrics.ts` (new)

**Contract**:
- `readMetricRows(db, { seats?: number })` runs one `db.batch` of aggregate queries: seat outcomes by model × role; non-wolf votes joined to voter and target roles (counts by voter model, and by game); eliminations by game; wolf seats with died day and the game's rounds held; votes received per seat-round; per-model turn cost and latency; per-game cost and turns by status; and the distinct seat counts present.
- `computeMetrics(rows): Metrics`, pure: applies the definitions above and returns `{ seatCounts, winRate, voteAccuracy, deception, cost }`. Every figure is `{ value: number | null; numerator: number; denominator: number; games: number }`. `value` is null when the denominator is 0.
- `loadMetrics(db, filter)` = `computeMetrics(await readMetricRows(db, filter))`.

### Success Criteria:

#### Automated Verification:

- 2.1 Pure tests: hand-built row sets cover each definition, including ties, a wolf surviving to the end, a wolf eliminated on day 1, an aborted game (excluded from outcomes, included in cost), unknown-cost turns, and zero denominators: `npm test -- metrics`
- 2.2 D1 tests: three seeded archived games (one 5-seat v1, two 8-seat mixed) give hand-computed figures, with and without the seat filter: `npm test -- metrics`
- 2.3 Typecheck passes: `npm run typecheck`

---

## Phase 3: Metrics page

### Overview

Show the metrics to the operator.

### Changes Required:

#### 1. Route

**Files**: `app/routes/metrics.tsx` (new), `app/routes.ts`, `app/routes/home.tsx`

**Contract**: `GET /metrics?seats=N`. The loader validates `seats` against the seat counts present (anything else → all) and calls `loadMetrics`. On an archive failure it renders an error notice, not a 500. Tables per section, model labels from the catalog, figures formatted as "62% · 31/50 · 9 games". An empty archive shows "No finished games yet". Home gets a "Metrics" link. `Cache-Control: no-store`.

### Success Criteria:

#### Automated Verification:

- 3.1 Route tests: the page requires the access key, renders seeded figures, honours and validates `?seats`, and survives an unreachable archive: `npm test -- record-routes` (or a new `metrics-routes` file)
- 3.2 Typecheck and build pass: `npm run typecheck && npm run build`

#### Manual Verification:

- 3.3 Dev page with a few local games reads correctly and matches one game counted by hand.

---

## Phase 4: Production rollout and check

### Overview

Ship, backfill, and confirm the figures on real data.

### Changes Required:

#### 1. Verification record

**File**: `context/changes/game-metrics/verification.md` (new): the deploy, the backfill counts, the drill game and the hand count.

### Success Criteria:

#### Automated Verification:

- 4.1 CI applies migration `0003` and deploys; `/healthz` passes.
- 4.2 Remote D1: every `game_players` row with `survived = 0` has `died_day` and `died_by` (rerun the backfill UPDATE once if a game was archived during the rollout).

#### Manual Verification:

- 4.3 One 8-seat production game plays to the end and archives with deaths recorded (first production run of PR #22's table and pack kill votes).
- 4.4 `/metrics` matches a hand count for the 8-seat filter, from `wrangler d1 execute --remote` rows.

## Testing Strategy

- Pure aggregation tests carry the definitions; D1 tests prove the SQL feeds them correctly; one backfill test ties the migration's SQL to the engine's transcript wording.

## Performance Considerations

A fixed number of aggregate queries in one batch, using the `game_players (model, role)` index and the `game_moves` primary key. No `state_json` reads. A `game_moves (game_id, phase)` index is unnecessary while the primary key starts with `game_id`.

## Migration Notes

`0003` is additive (two nullable columns plus an UPDATE that only fills nulls), so it is safe to re-run and an older Worker keeps working. Rollback of the Worker needs no schema change.

## References

- PRD: `context/foundation/prd.md`, Business Logic → scoring definitions (lines 180–185), FR-011.
- Roadmap S-08: `context/foundation/roadmap.md`.
- Archive schema and writer: `migrations/`, `workers/game/archive.ts`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Death columns

#### Automated

- [x] 1.1 Engine death tests pass — b8acb61
- [x] 1.2 Archive death and backfill tests pass — b8acb61
- [x] 1.3 Record tests stay green — b8acb61
- [x] 1.4 Local migration applies — b8acb61
- [x] 1.5 Typecheck passes — b8acb61

### Phase 2: Metrics queries and aggregation

#### Automated

- [x] 2.1 Pure metrics tests pass — c043027
- [x] 2.2 D1 metrics tests pass — c043027
- [x] 2.3 Typecheck passes — c043027

### Phase 3: Metrics page

#### Automated

- [x] 3.1 Route tests pass — 09057a2
- [x] 3.2 Typecheck and build pass — 09057a2

#### Manual

- [x] 3.3 Dev page matches a hand count — 09057a2

### Phase 4: Production rollout and check

#### Automated

- [ ] 4.1 CI applies migration 0003 and deploys; healthz passes
- [ ] 4.2 Remote D1 deaths are filled for every dead seat

#### Manual

- [ ] 4.3 An 8-seat production game plays to the end
- [ ] 4.4 Metrics page matches a hand count
