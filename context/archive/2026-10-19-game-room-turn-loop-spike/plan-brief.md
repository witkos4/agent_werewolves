# Game-Room Turn-Loop Spike — Plan Brief

> Full plan: `context/changes/game-room-turn-loop-spike/plan.md`
> Plan review: `context/changes/game-room-turn-loop-spike/reviews/plan-review.md` (REVISE → findings F1–F9 applied 2026-10-19)

## What & Why

A throwaway three-turn "game" running inside the real `GameRoom` Durable Object proves four things before any Werewolf logic exists:
1. Each turn makes one real LLM call.
2. Turns chain across evictions, and a redeploy mid-game resumes from the last saved turn.
3. Viewers see each turn live.
4. A retried turn never pays twice.

The infrastructure pre-mortem's top failure was a game written as one long loop that dies silently in production. This spike settles the turn-loop shape before S-02 builds on it.

## Starting Point

The F-01 skeleton: a React Router v8 SSR Worker with `/healthz`, auto-deployed on merge. There is no Durable Object, LLM access, secrets, or test runner yet.

## Desired End State

A secret-gated `POST /api/spike/start` creates a room that plays 3 chained-story turns through OpenRouter, one alarm per turn. `/spike/:gameId` shows the turns live and catches up without gaps after any disconnect. Workerd tests prove the loop and its failure modes without spending money. Production drills (eviction, redeploy mid-game, cache-HIT re-send, viewer reconnect) are recorded in `spike-findings.md`.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| LLM access path | One gateway: OpenRouter, plain `fetch` | Broadest catalogue (470 models), exact `usage.cost` per response, free cache hits, and a hard per-key spend limit. |
| Re-bill guarantee | SQLite turn journal + per-game, byte-identical resend served by OpenRouter's cache, with a 45 s quiet period before re-sending an unfinished call | OpenRouter doesn't coalesce concurrent identical calls, so a deploy mid-call must wait for the first reply to be cached. `gameId` in the body stops games sharing cache entries. |
| Step engine | DO alarms, one turn per alarm | State, loop, and broadcast stay in one object, with no 1,024-step Workflow cap for 45-minute games. |
| Trigger | Deployed route guarded by a temporary `SPIKE_KEY` | Only production shows real deploy resets. S-01 replaces the guard. |
| Late or reconnecting viewer | Backlog after `?after=<seq>`, then live | A deploy drops every socket, so replay-from-seq is required anyway for S-02. |
| Viewer | Minimal React Router page with auto-reconnect and seq-gap detection | Exercises the browser path, where spectators will actually break. |
| Turn prompt | Chained story (turn N sees 1..N-1) | A resume that lost state becomes visible. |
| Pacing | `delayMs` per game (default 30 s, 0 in tests) | Long enough to land a deploy mid-game, or to outlast eviction at 150 s. |
| Tests | `@cloudflare/vitest-plugin` in workerd, with a stubbed LLM | Proves retry, eviction, and replay without network, in CI. |
| DO class | Final `GameRoom` (legacy `migrations`, matching infrastructure.md) | A DO migration is one-way and blocks rollback, so ship the long-term class once. |
| Spike model | `google/gemini-3.1-flash-lite` | `gemini-2.5-flash-lite` expires on OpenRouter 2026-10-20. |
| Drill evidence | `SPIKE_KEY`-gated `GET /api/spike/:gameId/turns`, plus construction and attempt log lines with `versionId` | Makes eviction, mid-call deploy, and cache-HIT re-sends verifiable in production. |
| Release | All four phases in one PR | `secrets.required` and the one-way migration make a partial merge risky. |
| LLM failure | Up to 3 attempts with backoff, then `aborted`; 402 aborts at once | "Games always terminate", and S-07 budget aborts can reuse this path. |

## Scope

**In scope:**
- `GameRoom` DO with an SQLite journal and event log
- the alarm loop
- an OpenRouter client
- a secret-gated start route
- a hibernated WebSocket broadcast with seq replay
- a viewer page
- workerd tests and `npm test` in CI
- production drills and `spike-findings.md`

**Out of scope:**
- Werewolf rules, seats, and models per seat
- the spend-limit feature and cost estimate
- the access-key gate
- Workflows
- the archive/Postgres
- preview environments
- structured output

## Architecture / Approach

`workers/app.ts` exports `GameRoom` and routes `/api/spike/*` (start, WebSocket) through `handleSpikeRequest` before React Router.

Each alarm runs one turn:
1. Check the entry guards (game state, turn bound, attempts cap).
2. If an earlier attempt may still be in flight (under 45 s ago), wait for it.
3. Store the exact per-game request body as `pending` and record the attempt (output gates make this durable before the call leaves).
4. Call OpenRouter with caching on.
5. Commit `done`, the event, the next turn, and `finished` on the last turn in one transaction, with the next alarm stored atomically alongside it.
6. Broadcast to all hibernated sockets.

A crash re-runs the alarm, which re-sends the stored bytes after the quiet period, so the cache returns the reply for free. Spike-only prompt logic is a pure module (`workers/spike/story.ts`), so S-02 swaps it out while keeping the class, journal, loop, and broadcast.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. GameRoom + turn journal | DO, schema, guarded alarm loop with quiet period, retry/abort, workerd tests with stubbed LLM | The test entry must avoid React Router's virtual build module; retries are simulated by seeding state |
| 2. OpenRouter + key-gated routes | Real fetch client (cost, HIT, latency, timeout), start + journal-read routes behind `SPIKE_KEY` | The beta cache doesn't behave as documented |
| 3. Live broadcast + viewer | WebSocket hibernation, seq replay, auto-reconnecting page | Backlog/live interleaving; WebSocket tests need single-worker mode |
| 4. Production proof | `npm test` in CI, deploy, five drills (eviction, deploy between turns, deploy mid-call, re-bill, viewer), findings | Whether OpenRouter caches a reply after the client disconnected; Free-plan CPU surprises |

**Prerequisites:** F-01 done (PR #7). Production secrets and `.dev.vars` already set, and the OpenRouter key has a $5 limit (verified 2026-10-19). Human approval of the one-way DO migration at merge.

**Estimated effort:** ~3–4 sessions across 4 phases.

## Open Risks & Assumptions

- OpenRouter's response cache is beta, and entries may be evicted before their TTL. Whether it caches a reply after the client disconnected is undocumented; the mid-call drill measures it. If the re-bill drills fail, the fallback is Cloudflare AI Gateway in front of OpenRouter with a custom `cf-aig-cache-key`.
- What happens to an alarm that is running during a deploy isn't documented. The plan assumes it is killed and retried, and the mid-call drill checks this.
- Whether Free-plan DOs get 30 s of CPU or 10 ms is unverified. LLM waits don't count as CPU, so this is likely fine.
- `google/gemini-3.1-flash-lite` must still be listed with no expiry at implementation time.

## Success Criteria (Summary)

- A production spike game finishes 3 chained turns despite a 150 s eviction gap and a redeploy between turns.
- No turn is billed twice, even with a deploy mid-call: the journal, quiet period, or cache serves every retry, and OpenRouter activity shows one billed call per turn.
- A browser viewer sees every turn exactly once, live within ~2 s, across a deploy-induced disconnect.
