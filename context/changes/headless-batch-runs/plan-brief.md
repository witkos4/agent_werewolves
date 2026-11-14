# Headless Batch Runs — Plan Brief

> Full plan: `context/changes/headless-batch-runs/plan.md`

## What & Why

Roadmap S-09 (US-02, FR-016, FR-003 rotation, FR-014 batch limit). The operator runs 2–20 headless games as one batch under a single spend limit, then reviews results aggregated across the batch. A handful of hand-started games makes per-model metrics noise. Batches with balanced role rotation are what make the comparison mean something.

## Starting Point

Each game is a `GameRoom` Durable Object with an idempotent start, a per-game spend ledger (S-07) and an archive outbox. The metrics (S-08) take a filter. Nothing groups games, nothing can force a model onto a role, and the archive has no batch column.

## Desired End State

`/batches` has a form: repeat a setup, or rotate models over a pool. It also takes the game count, rounds, a batch limit and a per-game limit, and shows a live estimate. Starting opens `/batches/<id>`, which shows progress, spend against the limit, every game slot with links, and the S-08 metric sections over just that batch. The page refreshes itself and has a Cancel button. The same flow works headless through a JSON API with the Bearer key.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Concurrency | Up to 3 games at once | 20 games in about 30 min instead of about 1.5 h, far from provider rate limits. |
| Batch budget | Escrow: each game gets `min(per-game limit, unreserved budget)` at start; unspent escrow returns when it ends | Reuses S-07's proven per-game bound with no per-turn cross-object calls, and the limits handed out can never exceed the batch limit. |
| Settle against | The game's `charged_usd` ledger, not reported cost | It is at least real spend (unknown-cost and lost attempts keep their worst case), so the bound survives under-reported costs. |
| Entry point | Web pages plus a JSON API (Bearer key) | Matches "see the estimate, then start", and headless use needs no extra code. |
| Rotation | Exact role balance per model (±1), seats shuffled | Makes per-model win rates comparable. Forced roles are accepted only on the batch's internal start path. |
| Modes | Repeat a setup template (random seats redrawn per game) or rotate | Covers all three FR-003 options. |
| Cancel | Stop starts and abort running games (`cancelled`) | Spending stops within one turn per game, and every started game is archived. |
| Failures | Retry failed starts 3×, then "failed to start"; keep mid-game aborts, never replace | Results stay honest, and flaky models are not filtered out of the data. |
| Bounds | 2–20 games; batch $0.10–$20 (default $5); per game $0.05–$5 (default $1) | Cheap production drills, and a ceiling of 4× a full batch at today's estimates. |
| Home list | Batch games hidden; "Batches →" link | One batch would otherwise push every single game off the 20-item list. |

## Scope

**In scope:** forced-role seats on the internal path; `batch_id` on games; a `batches` table (migration 0005); the `BatchRoom` DO (one-way DO migration `v2`); pure planning, rotation and escrow functions; the JSON API; `/batches` and `/batches/:id`; batch-filtered metrics; cancel; production drills.

**Out of scope:** a shared per-turn ledger, a CLI script, replacing aborted games, configurable concurrency, persona balancing, S-10's archive filters, a batch filter on `/metrics`, charts, and changes to seats or roles (S-05).

## Architecture / Approach

`BatchRoom`, one DO per batch named `batch:<uuid>`, is an alarm-driven supervisor whose state lives in its own SQLite. It plans N slots up front, each with a game ID and a concrete setup. Every 15 s it does one pass:
1. Read each running game's ledger through a new `GameRoom.getBatchView()`, and settle the games that have ended.
2. Fund and start pending slots through the existing idempotent `startLive`, now given a `batchId`.
3. Apply cancel, budget skip and completion.
4. Copy its summary to D1 through a versioned upsert outbox.

The escrow is written in the same transaction as the slot's move to "starting", before the RPC, so a crash re-sends the identical start rather than starting an unfunded game.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Batch-aware games and the archive | Forced roles (internal), `batchId`, ledger and cancel RPCs, migration 0005, batch-filtered metrics | Breaking single-game idempotency or the role shuffle |
| 2. Batch engine and API | Planning, rotation and escrow functions; `BatchRoom`; `/api/batches/*` | Crash or retry ordering around the start RPC |
| 3. Batch pages | `/batches` form with estimate, `/batches/:id` with progress, slots, metrics and cancel | Extracting shared form and metrics components without regressions |
| 4. Production rollout and drills | Deploy (DO `v2`, one-way), a $0.30 budget drill, a 10-game results drill | One-way DO migration; real spend of about $4–5 |

**Prerequisites:** S-08 done. S-07's per-game ledger should pass its own production drills before Phase 4 here, since the escrow relies on it.
**Estimated effort:** about 3–4 sessions across 4 phases.

## Open Risks & Assumptions

- S-07 Phase 4 is still pending. If its production drill shows the per-game ledger can be exceeded, the batch bound inherits that flaw.
- DO migration `v2` cannot be rolled back. Problems after deploy are fixed forward.
- A tight batch limit leaves budget held by running games unusable by others. Late slots may be skipped even though money is left at the end. This is accepted and shown as "skipped for budget".

## Success Criteria (Summary)

- A batch never settles more than its limit, in tests after every alarm and in the production budget drill against OpenRouter activity.
- A 10-game batch runs unattended, archives every started game under its batch, and its results page matches a hand count.
- Rotation gives every pool model the same number of Werewolf, Seer and Villager seats (±1).
