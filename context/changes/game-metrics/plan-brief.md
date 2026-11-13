# Game Metrics — Plan Brief

## Outcome

A new `/metrics` page shows, from the D1 archive: win rate per model and per model × role; vote accuracy (per vote and per elimination); deception success (wolf survival, misdirected votes, suspicion dodged); and cost and latency per game and per model. Every figure shows how many games it is based on. This delivers roadmap S-08 (FR-011).

## Proposed defaults

- Outcome metrics (win rate, votes, deception) count **finished** games only. Cost and latency count **every** archived game, because aborted games still spent money.
- A seat-count filter (`?seats=5|8`, default: all). Version-1 games have 5 seats and one wolf, version-2 games have 8 seats and two. Pooling them skews win rates, and S-05 will add 5–9 seats.
- Vote accuracy belongs to the **voter's** model. Deception belongs to the **wolf's** model. Per-elimination accuracy is a table-level figure (no single model causes an elimination), so it is shown overall and per seat count only.
- Percentages are shown with their raw counts (e.g. "62% · 31/50 votes · 9 games"). No confidence intervals in v1.

## Approach

Deaths are only in the transcript text today, so migration `0003` adds `game_players.died_day` and `game_players.died_by` (`night` | `village`), with a backfill computed in SQL from the archived `state_json`. New archives fill the columns from a pure `deaths(game)` helper. `workers/game/metrics.ts` runs a few GROUP BY queries over `games`, `game_players` and `game_moves` and computes the ratios in a pure function. Nothing loads `state_json` on the metrics path, so the page scales to thousands of games.

## Delivery order

1. Death columns: the engine helper, record and archive fields, and migration `0003` with its backfill.
2. Metrics queries and a pure aggregation, tested against seeded archives with hand-computed figures.
3. The `/metrics` route and a link from home.
4. Production: CI applies `0003`, check the backfill on remote D1, run one 8-seat drill game (PR #22 has not been drilled), and compare the page against hand counts.

## Scope boundary

Batch aggregation (S-09), archive filters by model/role/date (S-10), charts, confidence intervals and per-persona metrics stay out. Per-persona breakdowns are cheap to add later because `persona` is already archived.

See [plan.md](plan.md) for implementation and verification details.
