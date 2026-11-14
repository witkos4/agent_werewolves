# Spend Limit and Estimate — Verification

Date: 2026-11-14. Status: phases 1–3 verified by the automated suite and a dev render. 3.5 is partly done, and Phase 4 (production) is pending the merge.

## Automated (phases 1–3)

`npm run typecheck`, `npm run build` and `npx vitest run` pass: 19 files, 196 tests. They include:

- The ledger: a $0.05 game with unknown costs aborts with `spend_limit` before the call that could pass the limit, and makes no further calls. A game with known costs finishes under $0.05 while its gross reservations exceed it. A failed attempt keeps its charge, and a free success refunds only its own. The ledger is checked against the limit after every alarm.
- A room from before the change (no ledger columns, no limit in state) upgrades in place, seeds its ledger from `reserved_usd`, and keeps playing at $1.00.
- Idempotency including the limit, and limit validation (0.04, 5.01, "1", 0.055, null → 400).
- The archive round-trips `spend_limit_usd`/`charged_usd`. A finished game's ledger equals its known cost. Pre-limit games read back as null.
- `estimateCost` for fixed, random, no-history and fallback cases, plus the D1 input query on seeded 9-seat games.

## Dev render (3.5, partial)

There was no OpenRouter key in the worktree. Local D1 was seeded with two synthetic finished 8-seat games: one all Gemini (40 moves at $0.0005), one all Haiku (60 moves at $0.001). The dev server ran with a throwaway access key.

| Check | Page | Hand count |
|---|---|---|
| Default form (all random, full pool) | ≈ $0.40, 4 models priced at the upper bound | 50/8 × 8 × (0.0005 + 0.001 + 4 × 0.011536)/6 = $0.3995 |
| All Gemini, limit 0.01 (rejected, re-rendered) | ≈ $0.0250, over-limit warning, 0.01 kept in the field, limit error shown | 6.25 × 8 × 0.0005 = $0.025 |

The seeded rows were deleted afterwards. Not yet checked: the estimate recomputing in a browser as selects change (the client `onChange` path), and a budget abort in dev against a real provider.

## Production (Phase 4)

Pending: CI applying 0004, a $0.05-limit drill game checked against OpenRouter activity, a default-limit game compared with its estimate, and new archives carrying the limit and ledger.
