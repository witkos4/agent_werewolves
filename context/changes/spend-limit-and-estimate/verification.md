# Spend Limit and Estimate — Verification

Date: 2026-11-24 (updated from 2026-11-14 for issue #32).
Status: **phases 1–3 locally verified** (automated suite, local D1 migrations, live browser estimate recomputation on synthetic D1, and static/test review of spend accounting and allowance bounds). **S-07 is not complete**: the manual dev budget-abort drill (`3.5`, runnable locally with a stub or real key per `plan.md`) and all Phase 4 production billing/deployment checks (`4.1`–`4.4`, which require separate authorization for paid provider calls and production deployment) remain pending.

No paid provider calls, production deployments, real secrets, or real customer data were used in this verification.

## Automated checks

Commands run in the fresh worktree (local Workers runtime; `test/setup.ts` fails loudly on any unstubbed `fetch`):

| Command | Result |
|---|---|
| `npm ci --no-audit --no-fund` | Pass (246 packages installed) |
| `npm run db:migrate:local` | Pass (5 migrations applied to local D1 `ARCHIVE`: `0001`–`0005`, including `0004_spend_limit.sql`) |
| `npm run typecheck` | Pass (`wrangler types && react-router typegen && tsc`) |
| `npm test` | Pass — 24 files, 274 tests (4 new spend-accounting tests added in `test/live-game.test.ts` plus expanded `safePrices` and `callOpenRouter` checks) |
| `npm run build` | Pass (client + SSR production build) |

Key spend-ledger and estimate coverage in the passing suite:

- **Ledger and retries (`test/live-game.test.ts`, `test/openrouter.test.ts`)**:
  - Unknown-cost (`cost: null`) game at `$0.05` aborts mid-game with `spend_limit` before the call that would exceed the limit, leaves the pending turn at `attempts = 0`, and makes no further calls on subsequent alarms; `charged_usd <= limit` holds after every alarm.
  - Known-cost game finishes under `$0.05` while gross `reserved_usd` exceeds `$0.05`, settling `charged_usd` to the sum of known costs.
  - Timed-out attempt + unknown-cost retry reserves and charges both attempts (`charged_usd = 2 * allowance`).
  - Retryable HTTP 503 + free (`cost: 0`) cache-hit retry keeps attempt 1's full allowance charged and refunds only attempt 2 (`charged_usd = allowance`).
  - Retryable HTTP 503 + paid (`cost: 0.0003`, cache-miss) retry keeps attempt 1's full allowance charged and settles only attempt 2 (`charged_usd = allowance + 0.0003`).
  - Retry blocked by `spend_limit`: when attempt 1 times out and attempt 2's allowance would push `charged_usd + allowance > limit`, the room aborts with `spend_limit` before making a second provider call (`calls = 1`).
  - Invalid model response (`validateMove` failure) and an in-flight `cancelLive()` both skip settlement and keep the full `allowance` charged.
  - Pre-S-07 room upgrade adds `charged_usd` (seeded from `reserved_usd`) and `allowance_usd` in place, plays under the `$1.00` default limit, and does not corrupt `charged_usd` if `allowance_usd` is `NULL` at settlement (`COALESCE(..., 0)`).
  - `callOpenRouter` maps missing, negative, and non-numeric `usage.cost` to `null` (unknown) rather than `0`, and maps `X-OpenRouter-Cache-Status: HIT` to `cost: 0`.
  - `unsafePricing()` / `safePrices()` fails closed on catalog outage (503), excessive `prompt`/`completion` rates, non-zero `request` fees, excessive `internal_reasoning` rates, and negative/dynamic `internal_reasoning` (`"-1"`).
  - Limit validation (`0.04`, `5.01`, `"1"`, `0.055`, `null` → `400`) and start idempotency with omitted/explicit limits (`409` on mismatch).
- **Archive, record and routes (`test/archive.test.ts`, `test/record.test.ts`, `test/record-routes.test.ts`)**:
  - Budget-aborted and finished games round-trip `spend_limit_usd` and `charged_usd` through D1; pre-S-07 games read back as `null`.
  - Home loader supplies limit bounds (`default: 1, min: 0.05, max: 5`) and `estimateInputs`, forwards/echoes `spendLimitUsd`, and degrades cleanly when D1 is unavailable.
- **Estimate (`test/estimate.test.ts`, `test/batch-plan.test.ts`, `test/batch-room.test.ts`)**:
  - Fixed seats, random seats over a pool, no-history upper-bound pricing (`UPPER_BOUND_TURN_USD`) with `missing` model names, same-size shape fallback, zero-history `no_shape`, D1 `readEstimateInputs` aggregation, and batch escrow integration.

## Browser estimate verification (3.5, local synthetic D1)

Dev server: `npm run dev -- --port 5178 --strictPort` with a temporary local `.dev.vars` containing only a throwaway `ACCESS_KEY` and an empty `OPENROUTER_API_KEY`. Driven in a live browser tab via the T3 preview browser after signing in at `/login`.

Local D1 (`ARCHIVE --local`) was seeded with three synthetic finished 8-seat games:

- `00000000-0000-4000-8000-000000000001`: 1 discussion pass, 40 moves, all `google/gemini-3.1-flash-lite` at `$0.0005`/turn.
- `00000000-0000-4000-8000-000000000002`: 1 discussion pass, 60 moves, all `anthropic/claude-haiku-5.5` at `$0.0010`/turn.
  - 8-seat 1-pass shape: 2 finished games, mean 50 turns (6.25 turns/seat).
- `00000000-0000-4000-8000-000000000003`: 2 discussion passes, 80 moves, all `deepseek/deepseek-v4-flash` at `$0.0020`/turn.
  - 8-seat 2-pass shape: 1 finished game, mean 80 turns (10 turns/seat).
- Remaining three catalog models (`openai/gpt-6-luna`, `qwen/qwen3.8-flash`, `mistralai/mistral-small-2603`) left with no history (`UPPER_BOUND_TURN_USD = $0.011536`).

All client-side transitions below happened live via `<Form onChange>` without page reload (except the final row, which reloaded after deleting the 2-pass synthetic game):

| Browser action | Observed `[data-testid="estimate"]` & `[role="alert"]` | Hand calculation |
|---|---|---|
| Initial load (8 Random, 6-model pool, 1 round, limit `1.00`) | `Estimated cost ≈ $0.32 · from 2 finished games · upper bound for GPT-6 Luna, Qwen 3.8 Flash, Mistral Small (no cost history)` · alert: none | `50 × (0.0005 + 0.0010 + 0.0020 + 3 × 0.011536) / 6 = $0.3176` |
| Uncheck `GPT-6 Luna` in Model pool | `Estimated cost ≈ $0.27 · from 2 finished games · upper bound for Qwen 3.8 Flash, Mistral Small (no cost history)` · alert: none | `50 × (0.0035 + 2 × 0.011536) / 5 = $0.2657` |
| Uncheck `Qwen 3.8 Flash` & `Mistral Small` (3 history-backed models) | `Estimated cost ≈ $0.0583 · from 2 finished games` · alert: none | `50 × 0.0035 / 3 = $0.05833` |
| Seat 1 model → `GPT-6 Luna` | `Estimated cost ≈ $0.12 · from 2 finished games · upper bound for GPT-6 Luna (no cost history)` · alert: none | `6.25 × 0.011536 + 43.75 × 0.0035 / 3 = $0.1231` |
| Discussion rounds → `2 rounds` | `Estimated cost ≈ $0.20 · from 1 finished game · upper bound for GPT-6 Luna (no cost history)` · alert: none | `10 × 0.011536 + 70 × 0.0035 / 3 = $0.1970` |
| Seat 1 model → `Gemini 3.1 Flash Lite` | `Estimated cost ≈ $0.0867 · from 1 finished game` · alert: none | `10 × 0.0005 + 70 × 0.0035 / 3 = $0.08667` |
| Spend limit `1.00` → `0.05` | `Estimated cost ≈ $0.0867 · from 1 finished game` · alert: `The estimate is above your spend limit, so the game will likely stop before a team wins.` | `0.0867 > 0.05` |
| Spend limit `0.05` → `0.10` + Seat 1 personality → `The Analyst` | `Estimated cost ≈ $0.0867 · from 1 finished game` · alert: none | `0.0867 <= 0.10`; personality does not affect estimate |
| Delete 2-pass synthetic game, reload `/`, switch `1 round` → `2 rounds` | `Estimated cost ≈ $0.40 · from 2 finished games with the other discussion setting · upper bound for GPT-6 Luna, DeepSeek V4 Flash, Qwen 3.8 Flash, Mistral Small (no cost history)` · alert: none | `50 × (0.0015 + 4 × 0.011536) / 6 = $0.3970` |
| Clear Spend limit input to `""` (after fix in `app/routes/home.tsx`) | `Estimated cost ≈ $0.40 · ...` · alert: none; typing `0.25` immediately shows the over-limit alert | Blank resolves to `$1.00` default (`0.40 <= 1.00`); `0.40 > 0.25` |

All synthetic D1 rows and `.dev.vars` were deleted after the browser check.

## Spend-accounting and allowance-bound review

### Verified invariants (from code inspection + mocked Workers tests)

- **Per-attempt reservation before every call (`workers/game/runtime.ts:267-276`)**: `LiveGame.run()` computes `allowance = attemptAllowance(turn.body)` and aborts with `spend_limit` if `charged_usd + allowance > effectiveLimit(game)` before reserving or calling `callLlm`. Reservation (`reserved_usd += allowance`, `charged_usd += allowance`, `attempts += 1`, `allowance_usd = allowance`) commits inside `transactionSync` before `setAlarm(quietMs)` and before outbound `fetch` (Durable Object output gates flush writes before network I/O).
- **Conservative retry and failure accounting (`workers/game/runtime.ts:259-312`, `workers/llm/openrouter.ts:32-72`)**:
  - Timeouts, network errors, retryable HTTP statuses (`408`, `429`, `5xx`), malformed JSON bodies, empty replies, non-retryable errors, `validateMove` failures, `cancel()` mid-flight, `time_limit` mid-flight, and mid-call DO evictions/crashes all skip settlement and leave the full `allowance` charged in `charged_usd`.
  - Each retry checks `charged_usd + allowance <= effectiveLimit(game)` and reserves a new `allowance`. When a later attempt succeeds, settlement adjusts `charged_usd` by `result.cost - allowance_usd` for **only the succeeding attempt** (`live_turns.allowance_usd`). Earlier failed/timed-out attempts remain charged at full `allowance`.
  - Therefore, whether a retry hits OpenRouter's response cache (`cost: 0`, refunding only the retry's own allowance) or misses and is billed again (`cost: c2`, settling only the retry), `real_spend <= charged_usd <= spendLimitUsd` holds **only if all three provider-contract conditions hold**:
    1. For every **unsettled** attempt, `attemptAllowance(body)` (`workers/game/engine.ts:73-75`) bounds the provider's actual final bill.
    2. For every **settled** attempt (`workers/game/runtime.ts:303-307`, `workers/llm/openrouter.ts:61-67`), the settled amount recorded (`usage.cost` on a MISS, or `$0` when `X-OpenRouter-Cache-Status: HIT`) covers the provider's final bill — including `$0` actual billing on a cache HIT and no unbilled/delayed surcharges missing from `usage.cost` (per [OpenRouter usage accounting](https://github.com/OpenRouterTeam/docs/blob/main/cookbook/administration/usage-accounting.mdx) and [OpenRouter response caching](https://openrouter.ai/blog/announcements/response-caching/)).
    3. For every **settled** attempt, `result.cost <= allowance_usd` (so settlement never increases `charged_usd` above the pre-call checked `charged + allowance <= spendLimitUsd`).
    None of these three provider-side conditions is proven by local mocks; end-to-end reconciliation against OpenRouter's activity log remains open in Phase 4.
- **Unknown-cost handling (`workers/llm/openrouter.ts:66`, `workers/game/runtime.ts:305-307`)**: missing, `NaN`, non-finite, non-numeric, or negative `usage.cost` yields `cost: null`, which skips settlement and leaves the full `allowance` charged.

### Defects found and fixed during this review

1. **Negative `internal_reasoning` pricing accepted by `safePrices()` (`workers/game/runtime.ts:37-45`)**: previously checked `!prices.internal_reasoning || Number(prices.internal_reasoning) <= OUTPUT_RATE_CEILING`, which accepted negative values such as OpenRouter's `"-1"` dynamic-pricing sentinel. Fixed to require `Number.isFinite(reasoning) && reasoning >= 0 && reasoning <= OUTPUT_RATE_CEILING`, with regression coverage in `test/live-game.test.ts`.
2. **Blank spend-limit input showed false over-limit warning (`app/routes/home.tsx:106-110`)**: `StartForm.onChange` parsed blank `""` with `Number("") === 0`, triggering the over-limit warning even though `action()` treats blank as `undefined` (the `$1.00` default limit). Fixed to fall back to `loaderData.spendLimit.default` when blank, and re-verified live in the browser.

### Unresolved gaps and assumptions not verifiable with mocks

These assumptions cannot be proven locally without real OpenRouter calls or production reconciliation and remain open until authorized Phase 4 verification:

1. **Provider enforcement of `max_price`, `max_tokens`, and `reasoning: { enabled: false }` (`workers/game/engine.ts:58-75,183-190`)**: `attemptAllowance(body)` assumes `(utf8Bytes(body) + 2048) * $0.50/1M + 256 * $2.00/1M` bounds every call. Mocks cannot prove that OpenRouter and every upstream provider for the six catalog models strictly enforce `provider.max_price` (`prompt: 0.5`, `completion: 2.0`), honor `max_tokens: 256` and `reasoning: { enabled: false }`, or keep total billed input tokens (including chat template and strict `json_schema` grammar/prompt overhead) within `utf8Bytes(body) + 2048`.
2. **Unchecked OpenRouter pricing components (`workers/game/runtime.ts:37-45`, `workers/game/engine.ts:190`)**: `safePrices()` checks `prompt`, `completion`, `internal_reasoning`, and `request === 0`, and `provider.max_price` constrains only `prompt` and `completion`. Other OpenRouter pricing fields or surcharges (e.g., `input_cache_write` prompt-cache write premiums, routing/platform markups, or minimum per-call fees) are neither checked at start nor capped by `max_price`.
3. **Start-time-only catalog check (`workers/game/runtime.ts:115`)**: `unsafePricing()` runs once at game start. If a model's `request` fee or `internal_reasoning` rate changes during a 45-minute game, subsequent turns rely solely on `provider.max_price` (`prompt`/`completion`).
4. **Overshoot propagation if a call ever bills `> allowance` (`workers/game/runtime.ts:305-307`, `workers/batch-room.ts:197-199`)**: if a real provider ever reports `usage.cost > allowance`, settlement adds `result.cost - allowance > 0`, which records the higher reported cost and can push `charged_usd` (and a batch's `settledUsd`) past `spendLimitUsd`. That blocks the next attempt only if the updated `charged_usd + nextAllowance > effectiveLimit(game)`; if headroom still remains under the limit, later turns continue until that pre-call check fails.
5. **Cache-HIT and `$0`-MISS billing semantics (`workers/llm/openrouter.ts:61-67`)**:
   - `cacheHit ? 0 : ...` assumes `X-OpenRouter-Cache-Status: HIT` is always unbilled in production (verified on laptop curl in F-02 4.7, not yet proven inside a Cloudflare Durable Object).
   - On a cache MISS, `usage.cost === 0` is accepted as known `$0` and refunds the full allowance even though `safePrices()` requires `prompt > 0 && completion > 0` for all seated models; if OpenRouter ever returns `0` for delayed or unmetered billing on a MISS, the ledger would under-charge that turn.
6. **Estimate model caveats (`workers/game/estimate.ts`, `app/routes/home.tsx`)**:
   - `UPPER_BOUND_TURN_USD` (`$0.011536`) is computed at fixed `UPPER_BOUND_BODY_BYTES = 20_000` (a mid-game prompt), not `MAX_INPUT_BYTES = 48_000` (`$0.025536`/turn) and not a D1-derived `medianBodyBytes` (request sizes are not stored in D1 `game_moves`).
   - Historical per-turn cost averages committed `game_moves` across both finished and aborted games and excludes failed/retried attempts; early-aborted games have shorter transcripts, which can bias per-turn cost slightly downward.
   - `estimateCost` returns `minModelTurns`, which `app/routes/home.tsx` does not currently render, and unchecking every Model pool checkbox while seats are `random` uses `UPPER_BOUND_TURN_USD` without naming missing models (start is still rejected by `parseSetup`).

## Remaining blockers (manual 3.5 drill and Phase 4)

Still pending before S-07 can be marked complete:

- **3.5 (remaining part — local stub option available)**: manual dev budget-abort drill starting a `$0.05`-limit game from the dev form and observing the spend-limit abort message in the viewer (`plan.md:176` allows either a local stubbed provider or a real key; the stubbed budget-abort and record-page behavior are already covered by `test/live-game.test.ts` and `test/record-routes.test.ts`).

The following real-billing and production verification steps require separate owner authorization for paid provider calls and production deployment:

- **4.1**: CI applying migration `0004_spend_limit.sql`, deploying to production, and `/healthz` passing.
- **4.2**: an 8-seat production game at `$0.05` aborting with `spend_limit`, with OpenRouter Activity log total `<= archived charged_usd <= 0.05`.
- **4.3**: an 8-seat production game at the `$1.00` default limit finishing, comparing `total_cost_usd` against `charged_usd` and the pre-run estimate.
- **4.4**: confirming post-deploy archived games record non-null `spend_limit_usd` and `charged_usd`.
