# Game Metrics — Verification

Date: 2026-11-14. Status: phases 1–3 verified locally; Phase 4 verified in production by the operator on 2026-11-14.

## Automated (phases 1–3)

`npm run typecheck`, `npm run build` and `npx vitest run` pass: 18 files, 180 tests. They include:

- `deaths()` against a scripted 8-seat game, and the migration 0003 backfill rebuilding the exact `died_day`/`died_by` values that a real archive write stored.
- Every metric for two scripted 7-seat games plus an aborted one, compared with figures counted by hand (`test/metrics.test.ts`).
- The route: seat filter validation, the unreachable-archive notice, and the access-key gate.

## Dev page (3.3)

There was no OpenRouter key in the worktree, so the local D1 was seeded with 20 engine-played 8-seat games: random legal moves, synthetic costs and latencies, no LLM calls. `/metrics` returned 302 to login without the key and 200 after login. The figures matched raw-row hand counts:

| Figure | Page | Raw SQL |
|---|---|---|
| Per-vote accuracy, all models | 67/182 | 67/182 |
| Per-elimination accuracy | 14/49 | 14/49 |
| Claude Haiku 5.5 win rate, all roles | 14/36 seats | 14/36 |
| Dead seats missing a death | — | 0 |

The seeded rows were deleted afterwards.

What the seeded run showed about reading the page:
- "Votes drawn: innocent" always equals "votes misdirected" at the same tables. Each living non-wolf casts exactly one vote per round, so non-wolf votes = innocent seat-rounds. This follows from the definitions; it is not a bug.
- A model can show more games under win rate than under cost. A seat killed on night 1 never takes a turn.

## Production (Phase 4)

Run by the operator after PR #23 merged; all four checks passed.

- 4.1 CI run 43526163194 on `main` applied migration 0003 and deployed; `/healthz` passed.
- 4.2 Remote D1: no `game_players` row with `survived = 0` lacks `died_day` or `died_by`.
- 4.3 An 8-seat production game played to the end and archived with its deaths recorded. This is also the first production drill of PR #22's 8-seat table and pack kill votes.
- 4.4 `/metrics?seats=8` matched a hand count from `wrangler d1 execute --remote` rows.
