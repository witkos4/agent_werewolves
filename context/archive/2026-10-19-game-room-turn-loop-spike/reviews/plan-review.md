<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Game-Room Turn-Loop Spike Implementation Plan

- **Plan**: context/changes/game-room-turn-loop-spike/plan.md
- **Mode**: Deep
- **Date**: 2026-10-19
- **Verdict**: REVISE
- **Findings**: 2 critical, 4 warnings, 3 observations
- **Reviewer note**: independent reviewer, human unavailable. Open questions are listed at the end instead of being asked. `change.md` was intentionally left untouched (reviewer constraint), so its status still needs to be set to `plan_reviewed`.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | WARNING |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | FAIL |
| Plan Completeness | WARNING |

## Grounding

Paths 8/8 ✓ (workers/app.ts, wrangler.jsonc, package.json, .github/workflows/ci.yml, app/routes.ts, app/cloudflare-context.ts, app/routes/healthz.ts:5-6, app/routes/home.tsx). Symbols 7/8: `virtual:react-router/server-build`, `cloudflareContext`, `secrets.required`, vitest-plugin `main`, `runDurableObjectAlarm`, `evictDurableObject`, and `abortAllDurableObjects` all check out. ✗ `evictDurableObject(stub, { webSockets: true })` (see F6). Brief↔plan ✓, though both repeat the same wrong `exports` rationale (F7). Progress↔Phase ✓ (1.1–1.8, 2.1–2.6, 3.1–3.6, 4.1–4.8; names match; no checkboxes in phase bodies).

Verified empirically in a /tmp copy with GameRoom, migrations, and `secrets.required` added. All three ran without a `.dev.vars` file:
- `react-router build` succeeds, and `secrets`, `migrations`, and `durable_objects` all carry into `build/server/wrangler.json`.
- `wrangler deploy --dry-run` succeeds. Dry-run sets `workerExists: true`, so required secrets only become `inherit` bindings and nothing is checked remotely (wrangler-dist/cli.js:176491, 180745).
- `wrangler types` emits `OPENROUTER_API_KEY: string; SPIKE_KEY: string`. `react-router dev` serves `/healthz` 200 and only warns "Missing required secrets".

## Findings

### F1 — Every game after the first is served from the OpenRouter cache

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW
- **Dimension**: Blind Spots
- **Location**: Phase 1 §3 `buildTurnRequest({ model, turnNo, previous })`; Phase 2 §1 headers
- **Detail**: The cache key is API key + model + endpoint + streaming + SHA-256 of the body (https://openrouter.ai/docs/guides/features/response-caching.md, "Cache key details"). The body is deterministic and has no per-game input, with a fixed temperature and a 24 h TTL. So game 2's turn 1 is byte-identical to game 1's turn 1 and comes back as a HIT. Its reply is the same, so turn 2 hits too, and so on. Every drill game after the first replays a cached story at cost 0. Concretely:
  - Manual check 2.5 ("3 attempts with non-zero cost") fails on the second local run.
  - Drills 4.4 and 4.5 measure the cache, not resume-from-journal.
  - "One billed call per turn" can't be read off the Activity page.
  - S-02 inherits the hazard: identical prompts across games would return identical "independent" agent replies.
- **Fix**: Add `gameId` to `buildTurnRequest` and put it in the body, e.g. a `user: gameId` field or a system line such as `Story <gameId>`. The body stays byte-stable per game/turn but unique across games. Add a unit test: same game gives identical strings, different games give different strings.
- **Decision**: PENDING

### F2 — A platform retry overlaps the still-in-flight upstream call, so a deploy mid-call bills twice

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM
- **Dimension**: Blind Spots
- **Location**: Critical Implementation Details (state machine, "Own the retries"); What We're NOT Doing (last bullet)
- **Detail**: When a deploy or crash kills the handler mid-fetch, OpenRouter keeps generating upstream. Platform alarm retries start at 2 s (https://developers.cloudflare.com/durable-objects/api/alarms/index.md). The retry re-sends the stored bytes before the original finishes, and OpenRouter states "If two identical requests arrive simultaneously before the first response is written to cache, both result in a cache MISS and are billed independently. There is no request coalescing." The plan's accepted risk ("completed upstream but neither the journal nor the cache kept it") is a different, rarer window. This one happens deterministically on every kill during a call, which is exactly the redeploy scenario the spike exists to prove. Whether OpenRouter even caches a response whose client disconnected is undocumented (see open questions).
- **Fix A ⭐ Recommended**: Add a quiet period before any resend.
  - Persist `last_attempt_at` together with the `attempts` increment, before the fetch.
  - On entry, if the row is `pending`, the last attempt has no recorded outcome, and `now - last_attempt_at < QUIET_MS`, re-arm for `last_attempt_at + QUIET_MS` and return without fetching. Use `QUIET_MS` = fetch timeout + margin, e.g. 45 s.
  - Define the re-arm backoff explicitly as ≥ `QUIET_MS`.
  - Strength: the original call finishes and lands in the cache before the resend, which turns the common case into a HIT. It is one column and one branch.
  - Tradeoff: crash recovery takes about 45 s longer.
  - Confidence: MED. It relies on OpenRouter caching a response after the client disconnected, which is unverified.
  - Blind spot: the cache behaviour after a disconnect. Add it to the drills (F5).
- **Fix B**: Restate the guarantee instead. Move "deploy mid-call may bill one extra turn" into What We're NOT Doing and the success criteria.
  - Strength: no code.
  - Tradeoff: weakens the headline property and the S-07 "never overshoots by more than one turn" budget math.
  - Confidence: HIGH.
  - Blind spot: none significant.
- **Decision**: PENDING

### F3 — The finish path isn't atomic, and nothing guards `next_turn > total_turns`

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW
- **Dimension**: Blind Spots
- **Location**: Critical Implementation Details, steps 1–5
- **Detail**: Step 5 commits `done` + event + `next_turn+1`, then separately broadcasts and then calls `setAlarm` "or finish". Suppose a crash lands after turn 3's commit but before finish. The retry finds the game still `running`, `next_turn=4`, and no row, so step 3 builds and pays for a 4th turn. Step 2 ("row is done → skip to scheduling") is unreachable, because `done` and `next_turn+1` commit atomically. The 3-attempt cap is also only described as checked after a failure; a retry that arrives with `attempts=3` and no outcome would fetch a 4th time.
- **Fix**: Three edits to the state machine:
  - Step 1: return or finish if `next_turn > total_turns`, and abort without fetching if `attempts >= 3` on entry.
  - Write `finished` status + the `finished` event inside the same `transactionSync` as the last turn.
  - Call `setAlarm` right after the commit with no intervening `await`. Writes with no intervening await are submitted atomically, per https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/index.md.
  - Drop step 2 and add a "crash between commit and finish" test.
- **Decision**: PENDING

### F4 — The production drills don't exercise the claims they certify

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM
- **Dimension**: End-State Alignment
- **Location**: Phase 4 Manual Verification (4.4–4.6); Phase 2 2.6; brief Open Risks
- **Detail**: Four gaps:
  - **Redeploy drill**: it deploys *between* turns, when the DO is asleep on a 60 s alarm. That only proves the alarm survives a deploy. The brief says the redeploy drill checks what happens to a *running* alarm during a deploy, and it doesn't.
  - **Re-bill drill**: it re-sends a *finished* body, a trivial HIT that says nothing about the crash path.
  - **Eviction drill**: "finishes all 3 turns" has no evidence that an eviction actually happened.
  - **Stored bodies**: there is no way to read a production `request_body`. No endpoint exposes the `turns` rows, and logs don't carry the body. 4.6 can't be performed as written, and 2.6 needs manual SQLite spelunking in `.wrangler/state`.
- **Fix**:
  - Constructor: log `gameroom_constructed` once per instance.
  - Per-attempt log line: add `versionId` (from `CF_VERSION_METADATA`) and the body's SHA-256.
  - Add a `SPIKE_KEY`-gated `GET /api/spike/:gameId/turns` that returns the journal rows.
  - Add a mid-call drill: a spike-only `holdMs` (wall-clock wait after the `pending` write, before fetch) or a slow, large `max_tokens` request. Deploy during the hold, then check the OpenRouter Activity page for the number of billed calls on that turn. This also tests F2.
  - Eviction pass criterion: a `gameroom_constructed` line appears between turns.
- **Decision**: PENDING

### F5 — Spike model `google/gemini-2.5-flash-lite` expires tomorrow

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1 `vars.SPIKE_MODEL`; brief Open Risks
- **Detail**: `GET https://openrouter.ai/api/v1/models` (fetched 2026-10-19) lists `google/gemini-2.5-flash-lite` with `expiration_date: "2026-10-20"`; `google/gemini-2.5-flash` expires the same day. The fallback "cheapest available text model" would pick oddities such as `scaledown/summarize`.
- **Fix**: Set `SPIKE_MODEL` to a non-expiring cheap mainstream model, e.g. `google/gemini-3.5-flash-lite` or `google/gemini-3.1-flash-lite` (both `expiration_date: null`). Make the implementation-time check "the ID exists and `expiration_date` is null".
- **Decision**: PENDING

### F6 — Test-harness contract errors against @cloudflare/vitest-plugin 1.4.5

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §4 and the Journal test; Phase 3 Reconnect test
- **Detail**: Checked against the package (npm `@cloudflare/vitest-plugin@1.4.5`, peer `vitest ^4.1.0 || ^5.0.0`; vitest 5.0.5 peers `vite ^8`, so it is compatible). The `main` override is supported (`options.main ??= main`). Problems:
  - (a) `runDurableObjectAlarm` runs `deleteAlarm()` and then `instance.alarm()` with **no `alarmInfo`** (dist/worker/lib/cloudflare/test-internal.mjs:121-130). `alarm()` must tolerate an undefined `alarmInfo`. After an abort no alarm remains, so there is no platform retry to observe and the test must re-arm or re-invoke itself.
  - (b) Calling `abortAllDurableObjects` while the stubbed fetch is pending inside the DO is a fragile cross-request-context dance.
  - (c) `evictDurableObject(stub, { webSockets: true })` doesn't type-check; the option is `"close" | "hibernate"`.
  - (d) `tsconfig.json` includes `**/*` but has no `@cloudflare/vitest-plugin/types` entry, so `cloudflare:test` imports break `npm run typecheck` (1.1).
  - (e) `--no-isolate` shares storage across all test files (https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/index.md), so every test needs a unique game id.
  - (f) The plugin pins its own `wrangler 4.151.2` and `miniflare 5.20261019.0-beta`.
- **Fix**:
  - Journal test: seed a `pending` row via `runInDurableObject` (simulating "crashed after pending write"), run the alarm, then assert the stub received the byte-identical body and `attempts` incremented. Separately, assert that a stub throwing mid-call leaves `pending` + `attempts=1`.
  - Change the reconnect test to `{ webSockets: "close" }`.
  - Add `"@cloudflare/vitest-plugin/types"` to tsconfig `types`, or use a `test/tsconfig.json`.
  - Use `crypto.randomUUID()` game ids in tests.
- **Decision**: PENDING

### F7 — The `exports` rationale is factually inverted

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1; brief Key Decisions "DO class"
- **Detail**: In wrangler 4.151.1, `versions upload` throws only when a **legacy migration is pending**: "This Worker has a pending Durable Object migration, which cannot be applied by `wrangler versions upload`" (wrangler-dist/cli.js, around line 181599). With `exports`, the upload payload carries `exports` and no migration (`resolveDoLifecyclePayload`, line 169994). The only constraint is identical `exports` across a percentage split (line 182061). The choice of legacy `migrations` is still right, because it matches infrastructure.md Getting Started step 5 and the risk register; only the stated reason is wrong. A future agent may "fix" it on the wrong premise. Separately, the infrastructure.md risk register says "Ship DO migrations in their own release", and this plan bundles the migration with the feature. That is acceptable here, since the only pre-F-02 version is the skeleton, but it should be stated.
- **Fix**: Reword the rationale to "matches infrastructure.md; first deploy must be `wrangler deploy` (not `versions upload`) because a pending legacy migration blocks uploads". Add one line acknowledging the bundled-migration deviation.
- **Decision**: PENDING

### F8 — `secrets.required` is safe for CI and dev; only merge ordering can break the deploy

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1; Phase 4 §2
- **Detail**: Verified that dry-run, build, types, and dev all work without secrets (see Grounding). A real `wrangler deploy` to the existing Worker sends `inherit` bindings, and the API rejects them with "The following required secrets have not been set" (cli.js:176491-176530). So if Phase 1 merges to `main` on its own before Phase 4's `secret put`, the main deploy job fails. The plan implies a single PR but never says so. Also, with `secrets` defined, wrangler always reads `process.env` ("Using secrets defined in process.env"), so a shell-exported `OPENROUTER_API_KEY` leaks into dev and tests. In dev an unset secret is `undefined`, not `""`.
- **Fix**:
  - State "Phases 1–4 ship as one PR; secrets are set before it merges".
  - Have the guard test falsy (`!env.SPIKE_KEY`).
  - Have the test config override both secrets with dummy values, and have the fetch stub throw on any unstubbed URL.
- **Decision**: PENDING

### F9 — Viewer: no seq-gap detection, and the unauthenticated socket path creates DOs for any name

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Blind Spots
- **Location**: Phase 3 §1–2
- **Detail**: The backlog-then-live race is sound. The accept and backlog send happen synchronously, commit+broadcast happens synchronously, and output gates hold `ws.send` until the commit is durable. A crash after commit but before send also drops the sockets, so the reconnect with `after=lastSeq` recovers. Two gaps remain:
  - The client only drops `seq <= lastSeq` and never detects `seq > lastSeq+1`. That is a cheap safety net, since AUTOINCREMENT seqs are contiguous here.
  - `/api/spike/:gameId/ws` does `idFromName(anything)`, and the constructor writes the schema, so drive-by requests create persistent DOs.
  - The 2 s latency criterion has no measurement method.
- **Fix**:
  - On a gap, the client closes and reconnects with `after=lastSeq`.
  - The route rejects non-UUID ids with 404, and the DO closes the socket (code 4404) when no `game` row exists.
  - The page shows `Date.now() - createdAt` per turn as evidence for the ~2 s criterion.
- **Decision**: PENDING

## Open questions for the human

1. Does OpenRouter cache (and still bill) a non-streaming response whose client disconnected mid-generation? F2 Fix A depends on this. Ask OpenRouter or test it in the F4 mid-call drill.
2. F2: do you want the quiet-period fix (Fix A), or should the guarantee be restated to allow one extra billed turn on a deploy mid-call (Fix B)?
3. Do Phases 1–4 land as a single PR? This affects F8 and when the production `wrangler secret put` must happen.
4. Model choice to replace the expiring `google/gemini-2.5-flash-lite` (F5).
5. Is a key-gated `GET /api/spike/:gameId/turns` debug endpoint acceptable for the spike (F4)? It exposes prompts and replies to anyone holding `SPIKE_KEY`.
