# Game-Room Turn-Loop Spike Implementation Plan

> Revised 2026-10-19 after the independent plan review (`reviews/plan-review.md`, F1–F9).

## Overview

Build a throwaway three-turn "game" inside the long-term `GameRoom` Durable Object. Before any Werewolf logic exists, it must prove four properties. Each turn makes one real LLM call through OpenRouter. Turns chain across evictions, and a redeploy mid-game, even mid-call, resumes from the last saved turn. Each turn is broadcast live to connected viewers. A retried turn never pays for the same LLM call twice. This is roadmap item F-02. It answers the blocking infrastructure question: can a 45-minute game run as saved, retry-safe steps on Workers?

## Current State Analysis

The app is the F-01 skeleton: a React Router v8 SSR Worker with `/healthz` and a placeholder home page, auto-deployed on merge to `main`. There is no Durable Object, no LLM access, and no test runner. CI runs typecheck, build, and `wrangler deploy --dry-run`, then deploys and smoke-tests on `main`. The production secrets `OPENROUTER_API_KEY` and `SPIKE_KEY` are already set (`wrangler secret list`, 2026-10-19), and so is local `.dev.vars`. The OpenRouter key has a $5 limit.

## Desired End State

- `POST /api/spike/start` with a valid `x-spike-key` header creates a `GameRoom` and returns `{ gameId, viewerUrl }`. Without the key it returns 404, and it is always 404 when `SPIKE_KEY` is unset.
- The room plays 3 chained-story turns, one per alarm, each a real OpenRouter call unique to that game. It then broadcasts `finished`, or `aborted` with a reason.
- `/spike/:gameId` shows the turns as they arrive. A viewer that reconnects (including after a deploy) or detects a `seq` gap receives every event after its last `seq`, with no gaps or duplicates.
- Workerd tests prove the alarm chain, journal reuse, the quiet-period re-send, resume after eviction, bounded-failure abort, the end-of-game guard, and WebSocket replay. They make no network calls and run in CI.
- In production, drills have shown eviction survival, resume after a deploy between turns, no double billing after a deploy mid-call, a free cache HIT on a re-sent turn, and viewer reconnect. Results are written to `spike-findings.md`.

### Key Discoveries:

- `workers/app.ts:11-16` is the only Worker entry. The `GameRoom` class must be exported from it, and `/api/spike/*` must be intercepted there before `requestHandler`. The research found that a 101 WebSocket response passing through a React Router loader is not guaranteed.
- `app/cloudflare-context.ts` + `app/routes/healthz.ts` show the v8 env-access pattern (`context.get(cloudflareContext).env`). Reuse it for the viewer route loader.
- Alarms are at-least-once. `alarm(alarmInfo)` exposes `retryCount`/`isRetry`, the platform retries up to 6× with exponential backoff from 2 s, and a handler runs for at most 15 min. A scheduled alarm lives in storage and survives deploys. A deploy restarts every DO, kills storage access mid-handler, and drops all WebSockets.
- Output gates hold outbound `fetch` and `ws.send` until prior storage writes are durable. So "write `pending`, then call" is crash-safe without `allowUnconfirmed`. `setAlarm` issued with no `await` after other writes is committed atomically with them.
- OpenRouter's response cache (beta):
  - It is enabled per request with `X-OpenRouter-Cache: true` and `X-OpenRouter-Cache-TTL`.
  - The key is API key + model + endpoint + streaming + a hash of the body. **A body with no per-game input is shared across games** (review F1), so the `gameId` must be in the body.
  - A HIT is free and is flagged by `X-OpenRouter-Cache-Status: HIT` / `X-OpenRouter-Cache-Source-Id`. Every 200 response carries `usage.cost`.
  - **Identical requests in flight at the same time both MISS and are both billed; there is no request coalescing** (review F2). That is why the quiet period below exists.
- `google/gemini-2.5-flash-lite` expires on OpenRouter on 2026-10-20 (`expiration_date` in `/api/v1/models`). Use `google/gemini-3.1-flash-lite` (no expiry; $0.25/$1.50 per M tokens).
- `@cloudflare/vitest-plugin@1.4.5` (vitest `^4.1 || ^5`, vite 8 OK) supports overriding `main` (review F6). Its gotchas:
  - `runDurableObjectAlarm` deletes the alarm and calls `alarm()` **without** `alarmInfo`, so it can't observe platform retries.
  - `evictDurableObject(stub, { webSockets: "close" | "hibernate" })` takes a string, not a boolean.
  - Types need `@cloudflare/vitest-plugin/types` in `tsconfig.json`.
  - `--no-isolate` shares storage across test files.
- `secrets.required` in `wrangler.jsonc` is safe for CI and dev (review, verified in a scratch copy). `wrangler deploy --dry-run` and `npm run dev` only warn, and `wrangler types` emits both names. A **real** deploy fails if a required secret is missing. Both already exist in production.
- Legacy `migrations` vs `exports`: wrangler 4.151 blocks `versions upload` only while a legacy migration is *pending*. With `exports` it works as long as a percentage split carries identical `exports` (review F7). Use legacy `migrations` for consistency with `infrastructure.md`. Either choice keeps previews possible.

## What We're NOT Doing

- No Werewolf rules, roles, seats, personalities, or the multi-model table (S-02, S-05, S-06).
- No spend-limit feature or cost estimate (S-07). The OpenRouter key's own $5 limit is the only cap.
- No access-key gate (S-01). `SPIKE_KEY` is a temporary guard on the start and journal-read routes, which S-01 will replace. The viewer page and socket stay unauthenticated: they spend nothing, and game IDs are random UUIDs.
- No Workflows, no Postgres/archive, and no preview environments.
- No structured output or private-rationale split. Each turn is plain text.
- No separate release for the DO migration. The infrastructure risk register advises shipping DO migrations alone, but here the migration *is* the feature, and the pre-F-02 versions have nothing worth rolling back to.
- No guarantee for one undocumented edge: a call that completed upstream after its client disconnected but was **not** cached by OpenRouter. The quiet-period re-send then pays once more, at most one cheap turn. The mid-call drill measures whether this happens.

## Implementation Approach

Build the risky core first, without network or money: the alarm-driven turn loop and its journal, tested in workerd with a stubbed LLM (Phase 1). Then swap in the real OpenRouter client behind secret-gated routes (Phase 2). Then add live delivery (Phase 3). Finally, prove it all against production, where deploys and evictions really happen (Phase 4). The turn and prompt logic lives in a pure module with no Cloudflare imports. Only `GameRoom` touches alarms, SQLite, and sockets, so S-02 can replace the spike logic while keeping the class, journal, loop, and broadcast.

**All four phases ship as one PR** (review F8). Merging an earlier phase alone would deploy the migration without the drills, and later phases depend on the same release boundary.

## Critical Implementation Details

**Turn state machine (alarm handler).** One alarm runs at most one turn attempt. Every step reads persisted state only.

1. **Entry guards.**
   - The game is not `running` → return.
   - `next_turn > total_turns` → finish (repair path; normally unreachable, see step 6).
   - The turn row's `attempts >= MAX_ATTEMPTS` (3) → abort with `attempts_exhausted`.
2. **Quiet period** (review F2). The row is `pending` and `now - last_attempt_at < QUIET_MS` (45 s, greater than the fetch timeout plus margin). An earlier attempt may still be in flight upstream, so `setAlarm(last_attempt_at + QUIET_MS)` and return without fetching. This is what makes a deploy mid-call wait for the first reply to be cached instead of racing it.
3. **First attempt.** No row yet → build the body once (it includes `gameId`) and insert it with `status=pending`.
4. **Attempt.**
   - Write `attempts+1` and `last_attempt_at=now` (the output gate makes this durable before the request leaves).
   - Optionally `await` the spike-only `holdMs` delay (drill hook, 0 by default).
   - `fetch` the stored body string unchanged, with `AbortSignal.timeout(30 s)`.
5. **Success.** In one `transactionSync`:
   - mark the turn `done` with text, cost, latency, cache-hit, and generation ID
   - append its `turn` event
   - advance `next_turn`
   - **if it was the last turn, also set `status=finished` and append the `finished` event**

   Right after it, with no `await` in between, call `setAlarm(now + delayMs)` unless finished, so the commit and the next alarm are stored atomically. Broadcast the new events to sockets after that.
6. **Failure.**
   - Retryable failures (timeout, 408, 429, 5xx, network) re-arm at `max(now + backoff, last_attempt_at + QUIET_MS)` without throwing.
   - A 402 or another 4xx aborts immediately: one transaction sets `status=aborted` with `abort_reason` and appends an `aborted` event. Broadcast it and don't re-arm.

   Catch every error inside `alarm()`, so platform retries happen only on a real crash or deploy. The persisted `attempts` and `last_attempt_at` make those retries obey the same cap and quiet period.

**The body must be per-game and stable** (review F1). `buildTurnRequest` includes `gameId` in the JSON body (as the top-level `user` field), so identical requests occur only *within* one game's retries. The stored string is re-sent byte-for-byte. Never rebuild it on retry.

**Tests must not load the React Router build.** `workers/app.ts` imports `virtual:react-router/server-build`, which only the React Router Vite plugin resolves. Point the vitest-plugin at a test-only entry (`test/worker.ts`) that re-exports `GameRoom` and routes `/api/spike/*` through the same `handleSpikeRequest` used by `workers/app.ts`. It must use the same `wrangler.jsonc` bindings and migration. Override both secrets in the test config: once `secrets` is declared, wrangler also reads `process.env`. The fetch stub throws on any unstubbed URL, and every test uses a fresh random `gameId`, because `--no-isolate` shares storage.

**Observability for the drills** (review F4).
- **DO construction:** each `GameRoom` construction logs one line (`gameId` if known, `versionId` from `CF_VERSION_METADATA`). A new construction line between turns is the evidence that an eviction or restart happened.
- **Each attempt:** a line with `gameId`, `turn`, `attempt`, `isRetry`, `quietWait`, `cacheHit`, `cost`, `latencyMs`, `bodySha256` (first 12 hex chars), `versionId`, and `outcome`.

**Cache-hit cost.** On a HIT, record `cost = 0`, `cache_hit = 1`, and the source generation ID. Otherwise cost metrics double-count.

**Rollback boundary.** This release adds the first DO migration, so `wrangler rollback` cannot cross back to pre-F-02 versions afterwards. If production breaks, fix forward, and never remove the `GameRoom` export or its migration entry. Say so in the PR and the README.

## Phase 1: GameRoom + Turn Journal (Local, Stubbed LLM)

### Overview

Add the Durable Object, its SQLite schema, the alarm loop with entry guards and the quiet period, the journal, bounded retry and abort, and the workerd test harness. All LLM calls go through an injectable client, stubbed in tests.

### Changes Required:

#### 1. Durable Object binding and migration

**File**: `wrangler.jsonc`

**Intent**: Declare the long-term `GameRoom` class (SQLite-backed) once, plus the runtime secrets and the spike model.

**Contract**:
- `durable_objects.bindings: [{ "name": "GAME_ROOM", "class_name": "GameRoom" }]`.
- `migrations: [{ "tag": "v1", "new_sqlite_classes": ["GameRoom"] }]`.
- `secrets: { "required": ["OPENROUTER_API_KEY", "SPIKE_KEY"] }`.
- `vars.SPIKE_MODEL: "google/gemini-3.1-flash-lite"`. When implementing, confirm in `GET https://openrouter.ai/api/v1/models` that it exists and `expiration_date` is `null`. If not, pick another Google flash-lite model with a null expiry.

#### 2. GameRoom Durable Object

**File**: `workers/game-room.ts` (new); exported from `workers/app.ts`

**Intent**: Own game state, the turn journal, the event log, and the alarm loop. This class stays when S-02 replaces the spike logic.

**Contract**:
- `class GameRoom extends DurableObject<Env>`. The schema is created in the constructor inside `blockConcurrencyWhile`, versioned with `PRAGMA user_version` so later changes are in-code SQLite migrations, never class changes. The constructor logs the construction line.
- Tables:
  - `game`: single row with `id`, `status` (`running`|`finished`|`aborted`), `total_turns`, `next_turn`, `delay_ms`, `hold_ms`, `model`, `abort_reason`, `created_at`.
  - `turns`: `turn_no` PK, `idempotency_key` (`<gameId>:<turn_no>`), `status` (`pending`|`done`), `request_body` TEXT, `response_text`, `cost`, `latency_ms`, `attempts`, `last_attempt_at`, `cache_hit`, `generation_id`.
  - `events`: `seq` INTEGER PK AUTOINCREMENT, `type` (`started`|`turn`|`finished`|`aborted`), `payload` JSON, `created_at`.
- RPC `start({ gameId, totalTurns = 3, delayMs, holdMs = 0, model }): void`. It is idempotent: a second call for an existing game is a no-op. It writes `game` and a `started` event and sets the first alarm.
- RPC `getJournal(): { game, turns[] }` returns the rows for the drill endpoint.
- `alarm(alarmInfo)` implements the state machine in Critical Implementation Details. `MAX_ATTEMPTS`, `QUIET_MS`, and the backoff are module constants, and tests may override them through the same seam as the LLM client.
- The LLM client is resolved through one seam (a constructor-time factory or module), so tests substitute a stub without network.

#### 3. Spike turn logic (pure)

**File**: `workers/spike/story.ts` (new)

**Intent**: The only spike-specific logic. It builds turn N's chat request from turns 1..N-1's saved replies ("add one sentence to this story").

**Contract**: `buildTurnRequest({ gameId, model, turnNo, previous: string[] }) → string`.
- It returns the exact JSON body string, with a fixed key order and no timestamps or randomness.
- It includes `"user": gameId`, a small `max_tokens` (~120), and a fixed `temperature`.
- There are no Cloudflare imports.

#### 4. Test harness

**File**: `vitest.config.ts`, `test/worker.ts`, `test/game-room.test.ts`, `test/story.test.ts` (new); `package.json`; `tsconfig.json`

**Intent**: Run tests inside workerd against the real DO and SQLite.

**Contract**:
- Add dev deps `@cloudflare/vitest-plugin` (^1.4) and `vitest` (a version in the plugin's peer range).
- Add script `"test": "vitest run"`, with `--max-workers=1 --no-isolate` set in the config.
- Configure `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })` with `main` overridden to `test/worker.ts` and both secrets overridden.
- Add `@cloudflare/vitest-plugin/types` to `tsconfig.json` `types`.
- Retries are simulated by seeding state with `runInDurableObject`, for example a `pending` row with `attempts`/`last_attempt_at`, and then running `runDurableObjectAlarm`. Don't depend on `alarmInfo` or on aborting while a call is in flight.

### Success Criteria:

#### Automated Verification:

- Typecheck passes: `npm run typecheck`
- Build and dry-run deploy succeed: `npm run build && npx wrangler deploy --dry-run`
- Body determinism test: the same inputs give identical strings, different `gameId`s give different strings, and turn N includes turns 1..N-1: `npm test`
- Chain test: a 3-turn game with `delayMs: 0`, driven by `runDurableObjectAlarm`, ends `finished` with 3 `done` turns, 3 stub calls, events `started, turn×3, finished` in `seq` order, and no alarm left: `npm test`
- Journal test: with a seeded `pending` turn whose `last_attempt_at` is older than `QUIET_MS`, the alarm re-sends the byte-identical stored body, and a turn already `done` is never sent again: `npm test`
- Quiet-period test: with a seeded `pending` turn whose `last_attempt_at` is recent, the alarm makes no stub call and leaves an alarm at `last_attempt_at + QUIET_MS`: `npm test`
- Eviction test: `evictDurableObject` between turns, and the next alarm resumes at the correct `next_turn` with turn-1 text in its prompt: `npm test`
- Failure test: 3 consecutive 5xx (or one 402) end the game `aborted` with a reason event and no further alarm. A seeded row already at `MAX_ATTEMPTS` aborts on entry without a call: `npm test`
- End guard test: a seeded `running` game with `next_turn > total_turns` finishes without a call: `npm test`
- Idempotent start test: calling `start` twice creates one game and one `started` event: `npm test`

#### Manual Verification:

- Review `workers/game-room.ts`: `next_turn` and `finished` change only in the same transaction as the turn's `done` + event, `setAlarm` follows with no `await` in between, and no game state lives only in memory

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: OpenRouter Client + Secret-Gated Routes

### Overview

Replace the stub with a real fetch-based OpenRouter client, and expose the guarded start and journal-read endpoints. Real calls run in `npm run dev`.

### Changes Required:

#### 1. OpenRouter client

**File**: `workers/llm/openrouter.ts` (new)

**Intent**: One fetch call per attempt, returning everything the journal and metrics need.

**Contract**:
- `callOpenRouter({ apiKey, body: string, signal }) → { ok: true, text, cost, cacheHit, generationId, latencyMs } | { ok: false, retryable: boolean, status, reason }`.
- `POST https://openrouter.ai/api/v1/chat/completions` with the body string sent unchanged.
- Headers: `Authorization: Bearer`, `Content-Type: application/json`, `X-OpenRouter-Cache: true`, `X-OpenRouter-Cache-TTL: 86400`, and `X-Title: Agent Werewolves`.
- On a HIT (`X-OpenRouter-Cache-Status`), set cost 0 and take the generation ID from `X-OpenRouter-Cache-Source-Id`.
- Classification: 408/429/5xx/network/timeout are retryable. 402 and other 4xx are not.
- Latency is `Date.now()` before and after.

#### 2. Spike request routing

**File**: `workers/spike/routes.ts` (new); `workers/app.ts`

**Intent**: Handle `/api/spike/*` before React Router. The WebSocket path is added in Phase 3.

**Contract**:
- `handleSpikeRequest(request, env): Promise<Response | null>`. It returns `null` for paths it doesn't own, and `workers/app.ts` falls through to `requestHandler` on `null`.
- Key guard for all key-gated routes: 404 if `!env.SPIKE_KEY` (in dev it may be `undefined`) or the `x-spike-key` header doesn't match (constant-time compare).
- `POST /api/spike/start` (key-gated):
  - optional JSON `{ delayMs?, holdMs? }`, with `delayMs` clamped to 0–300000 (default 30000) and `holdMs` clamped to 0–60000 (default 0)
  - generates `gameId = crypto.randomUUID()` and calls `GAME_ROOM.get(idFromName(gameId)).start(...)` with `env.SPIKE_MODEL`
  - returns `{ gameId, viewerUrl: "/spike/<gameId>" }`
- `GET /api/spike/:gameId/turns` (key-gated): returns `getJournal()` as JSON, including each turn's `request_body`.
- Any `:gameId` that isn't a UUID → 404. This avoids creating a stored DO for arbitrary names.

#### 3. Local secrets

**File**: `.dev.vars` (gitignored; already populated); `README.md`

**Intent**: Document the local secret names (not values) in the README's Develop section.

### Success Criteria:

#### Automated Verification:

- Typecheck passes: `npm run typecheck`
- Client tests with stubbed fetch: a 200 response maps cost and text, a HIT header gives cost 0 and `cacheHit`, a 5xx is retryable, and a 402 is not: `npm test`
- Route tests: a missing or wrong key gives 404, an unset `SPIKE_KEY` gives 404, a non-UUID `gameId` gives 404, a valid start gives 200 with a UUID `gameId`, `/turns` with the key returns the journal, and non-spike paths return `null`: `npm test`
- Phase 1 tests still pass: `npm test`

#### Manual Verification:

- With real keys in `.dev.vars`, `curl -X POST -H "x-spike-key: …" localhost:5173/api/spike/start -d '{"delayMs":5000}'` runs 3 real turns. The dev server log shows 3 attempts with non-zero cost, and turn 3's sentence continues turns 1–2. A second game also shows non-zero cost (no cross-game cache hits)
- Sending turn 1's `request_body` from `/turns` again by hand to OpenRouter (same key) returns `X-OpenRouter-Cache-Status: HIT` with `usage.cost` 0

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Live Broadcast + Viewer

### Overview

Push each event to connected viewers over hibernated WebSockets, with a backlog-then-live replay keyed by `seq`, plus a minimal viewer page that reconnects on its own.

### Changes Required:

#### 1. WebSocket endpoint

**File**: `workers/spike/routes.ts`; `workers/game-room.ts`

**Intent**: Viewers connect per game. A late or reconnecting viewer gets everything after its last seen `seq`, then live events.

**Contract**:
- `GET /api/spike/:gameId/ws?after=<seq>` with `Upgrade: websocket` is forwarded via `stub.fetch(request)`. Anything else on that path returns 426.
- The DO uses `ctx.acceptWebSocket(server)`. In the same synchronous turn it sends every `events` row with `seq > after` in order, so no event can interleave.
- After each committed event, the DO sends it to `ctx.getWebSockets()`.
- Message shape: `{ seq, type, payload, createdAt }`, where a `turn` payload is `{ turnNo, text, cost, cacheHit, latencyMs }`.
- `setWebSocketAutoResponse` answers ping/pong without waking the DO.
- No in-memory socket bookkeeping.

#### 2. Viewer page

**File**: `app/routes/spike.$gameId.tsx` (new); `app/routes.ts`

**Intent**: The smallest page that proves the browser path end to end.

**Contract**:
- Route `spike/:gameId`.
- On the client it opens `wss://<host>/api/spike/<gameId>/ws?after=<lastSeq>` and renders turns and the final status.
- It ignores `seq <= lastSeq`. On `seq > lastSeq + 1` (a gap) it closes and reconnects with `after=lastSeq`.
- On close it reconnects with backoff (1 s → 10 s cap) and shows a connection-state indicator.
- Each turn shows its receive delay (`Date.now() - createdAt`), so the ~2 s criterion can be read off the page.
- Styled with existing Tailwind conventions from `home.tsx`.

### Success Criteria:

#### Automated Verification:

- Typecheck and build pass: `npm run typecheck && npm run build`
- Replay test: a socket connecting with `after=1` after turn 2 receives events with seq > 1 in order, then live turn 3 and `finished`, with no duplicates: `npm test`
- Reconnect test: after `evictDurableObject(stub, { webSockets: "close" })`, a new socket with the last seen `seq` receives only later events: `npm test`
- A non-upgrade GET to the WebSocket path returns 426: `npm test`

#### Manual Verification:

- In `npm run dev`, opening `/spike/<gameId>` mid-game shows earlier turns at once and later turns with a receive delay under ~2 s
- Restarting the dev server mid-game, the page reconnects on its own and shows the remaining turns with no gap or duplicate

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 4: Production Proof

### Overview

Run tests in CI, merge the single PR (which deploys the migration), and prove the properties where deploys and evictions really happen. Record the findings.

### Changes Required:

#### 1. CI runs tests

**File**: `.github/workflows/ci.yml`

**Intent**: Gate every PR and `main` deploy on the workerd tests.

**Contract**: The `check` job runs `npm test` after `npm run typecheck`, before `npm run build`. Nothing else changes.

#### 2. Production secrets (done)

**Intent**: Both required secrets must exist before the merge deploy, or `wrangler deploy` fails on `secrets.required`.

**Contract**: Re-confirm with `npx wrangler secret list` right before merging. Both `OPENROUTER_API_KEY` and `SPIKE_KEY` were already present on 2026-10-19.

#### 3. Findings and docs

**File**: `context/changes/game-room-turn-loop-spike/spike-findings.md` (new); `README.md`

**Intent**: The spike's deliverable is an answer. Record what each drill showed, including surprises such as:
- whether OpenRouter cached a reply whose client disconnected
- what close code viewers saw on deploy
- Free-plan CPU behaviour

Note the knock-on for S-02 and S-07.

**Contract**:
- `spike-findings.md`: one section per drill, giving the evidence (game IDs, construction and attempt log lines, version IDs, `/turns` output, OpenRouter activity) and pass/fail, plus "Implications for S-02".
- README:
  - a short Spike section (start a game, view it, read the journal)
  - runtime secret names added to the secrets table
  - the fix-forward note: rollback cannot cross the first DO migration

### Success Criteria:

#### Automated Verification:

- The PR run shows `check` (now including `npm test`) passing and `deploy` skipped: `gh pr checks`
- After merge, the `main` run succeeds end to end: `gh run list --workflow ci.yml --branch main --limit 1 --json conclusion -q '.[0].conclusion'` returns `success`
- Production guard holds: `POST $PROD_URL/api/spike/start` and `GET $PROD_URL/api/spike/<uuid>/turns` without the key return 404

#### Manual Verification:

- Eviction drill: a game with `delayMs: 150000` finishes all 3 turns, and `wrangler tail` shows a new `GameRoom` construction line before turns 2 and 3
- Redeploy-between-turns drill: start a game with `delayMs: 60000` and run `npm run deploy` between turns 1 and 2. The game finishes, turns 2–3 build on turn 1, and the attempt lines show the new `versionId`
- Redeploy-mid-call drill: start a game with `holdMs: 20000` and run `npm run deploy` during turn 2's hold. `wrangler tail` shows a quiet-period wait and then one re-send. `/turns` shows turn 2 `done`, and OpenRouter activity shows exactly one billed call for turn 2. If two are billed, record it as the accepted edge case in findings
- Re-bill drill: re-sending a finished turn's `request_body` from `/turns` to OpenRouter returns a cache HIT with cost 0. Across all drill games, OpenRouter activity shows one billed call per turn
- Viewer drill: a browser on `/spike/<gameId>` across a redeploy reconnects on its own and ends showing all 3 turns once each, with receive delays under ~2 s
- `spike-findings.md` and the README reviewed for accuracy

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:

- `buildTurnRequest` is deterministic within a game and distinct across games, and turn N includes turns 1..N-1.
- OpenRouter response mapping: cost, HIT detection, and error classification.
- Route guards: missing, wrong, or unset key, non-UUID IDs, and a valid key.

### Integration Tests:

- Workerd tests against the real `GameRoom` and SQLite cover the alarm chain, journal re-send, quiet-period wait, eviction resume, bounded-failure abort, the end guard, idempotent start, and WebSocket replay and reconnect. Retries are simulated by seeding state, not by timing aborts.
- Production drills (Phase 4) are the runtime integration tests that workerd can't simulate: real deploy resets, real eviction, and real cache and billing behaviour.

### Manual Testing Steps:

1. Local real-LLM run plus a second game (Phase 2), then a by-hand cache-HIT check.
2. Local viewer across a dev-server restart (Phase 3).
3. Production eviction, redeploy-between-turns, redeploy-mid-call, re-bill, and viewer drills (Phase 4).

## Performance Considerations

Each alarm is its own invocation with its own 50-subrequest budget, so one LLM call per alarm is far below every limit. A waiting DO bills for its duration while a fetch or `holdMs` timer is pending. That is negligible for 3 turns, but it is recorded in the findings for S-02/S-09 sizing. The quiet period delays a turn by up to 45 s only after a crash or deploy mid-call.

## Migration Notes

This change adds the first DO migration (`v1`, `new_sqlite_classes: ["GameRoom"]`). It is one-way, and rollback to earlier versions is blocked afterwards. Later schema changes go through `PRAGMA user_version` migrations inside `GameRoom`, never class renames or removals.

## References

- Plan review: `context/changes/game-room-turn-loop-spike/reviews/plan-review.md`
- Roadmap item: `context/foundation/roadmap.md` (F-02)
- Platform decision, risk register, Getting Started step 5: `context/foundation/infrastructure.md`
- Previous change: `context/archive/2026-10-18-deploy-skeleton/plan.md`
- Env-access pattern: `app/cloudflare-context.ts`, `app/routes/healthz.ts:5-6`
- Cloudflare docs: DO alarms, lifecycle, SQLite storage API, WebSocket hibernation, vitest-plugin test APIs (developers.cloudflare.com)
- OpenRouter docs: response caching, usage accounting, limits (openrouter.ai/docs)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: GameRoom + Turn Journal (Local, Stubbed LLM)

#### Automated

- [x] 1.1 Typecheck passes — 0bcd3dc
- [x] 1.2 Build and dry-run deploy succeed — 0bcd3dc
- [x] 1.3 Body determinism test passes — 0bcd3dc
- [x] 1.4 Chain test passes — 0bcd3dc
- [x] 1.5 Journal test passes — 0bcd3dc
- [x] 1.6 Quiet-period test passes — 0bcd3dc
- [x] 1.7 Eviction test passes — 0bcd3dc
- [x] 1.8 Failure test passes — 0bcd3dc
- [x] 1.9 End guard test passes — 0bcd3dc
- [x] 1.10 Idempotent start test passes — 0bcd3dc

#### Manual

- [x] 1.11 GameRoom transaction boundaries reviewed — 0bcd3dc

### Phase 2: OpenRouter Client + Secret-Gated Routes

#### Automated

- [x] 2.1 Typecheck passes — bc582c2
- [x] 2.2 Client tests pass — bc582c2
- [x] 2.3 Route tests pass — bc582c2
- [x] 2.4 Phase 1 tests still pass — bc582c2

#### Manual

- [x] 2.5 Local real-LLM games complete 3 chained turns with no cross-game cache hits — bc582c2
- [x] 2.6 Re-sent request returns a free cache HIT — bc582c2

### Phase 3: Live Broadcast + Viewer

#### Automated

- [x] 3.1 Typecheck and build pass — 05434a8
- [x] 3.2 Replay test passes — 05434a8
- [x] 3.3 Reconnect test passes — 05434a8
- [x] 3.4 Non-upgrade request returns 426 — 05434a8

#### Manual

- [x] 3.5 Late viewer sees backlog then live turns — 05434a8
- [x] 3.6 Viewer reconnects across dev-server restart — 05434a8

### Phase 4: Production Proof

#### Automated

- [ ] 4.1 PR run passes check and skips deploy
- [ ] 4.2 Main run succeeds end to end
- [ ] 4.3 Production guards return 404 without key

#### Manual

- [ ] 4.4 Eviction drill passes
- [ ] 4.5 Redeploy-between-turns drill passes
- [ ] 4.6 Redeploy-mid-call drill passes
- [ ] 4.7 Re-bill drill passes
- [ ] 4.8 Viewer drill passes
- [ ] 4.9 Findings and README reviewed
