# Mixed-Model Seats and Personalities Implementation Plan

## Overview

Roadmap S-06 (FR-003 manual and pool modes, FR-004). The operator configures each of the five seats with a model and a personality, by hand or drawn at random. Models are drawn from an operator-picked pool and personalities from a preset roster. Different models then play at one table. Each seat's model and personality are stored in the game state, shown to spectators, rendered in the record, and archived per player, so S-08 (metrics) and S-10 (filters) can group by model.

## Current State Analysis

- One model per game: `Game.model` is set from the `MODEL` constant in `createGame` (`workers/game/engine.ts:52`) and used for every request body (`buildRequest`, `engine.ts:96`).
- Request parameters are fixed: `temperature: 0.7`, `response_format: json_object`, `reasoning: { enabled: false }`, and `provider.require_parameters: true` (`engine.ts:103`). With `require_parameters`, OpenRouter refuses to route a request whose parameters no provider of that model supports.
- The 2026-11-08 public catalog shows that `anthropic/claude-haiku-5.5` and `openai/gpt-6-luna` don't list `temperature`. The other four catalog models do. All six list `reasoning`, `response_format`, `structured_outputs` and `max_tokens`.
- Rate ceilings are global constants, `INPUT_RATE_CEILING` $0.50/M and `OUTPUT_RATE_CEILING` $2.00/M (`engine.ts:38`). The per-attempt reservation in `LiveGame.run` (`runtime.ts:213`) and the $0.25 `SAFETY_USD` use them. Every chosen catalog model is priced below both ceilings, so neither changes.
- `pricingAvailable()` (`runtime.ts:20`) checks only `MODEL` against the ceilings before a start.
- The start API accepts exactly `{requestId, discussionPasses}` and rejects any other key (`workers/game/routes.ts:22`). Idempotency compares `id` and `discussionPasses` (`runtime.ts:72`).
- `agentView` already hides other seats' roles. It carries no model or personality data.
- `buildRecord` writes `game.model` into every `RecordPlayer.model` (`workers/game/record.ts:108`). D1 `game_players.model` already exists (migration `0001`), so per-seat models need no schema change. Personality needs a new column.
- Archived and room-held states are all `version: 1`. Production D1 holds at least six such games (S-03 verification). They must keep rendering.
- Test helpers mock the pricing catalog with a single `MODEL` entry (`test/live-helpers.ts:9`).

## Desired End State

- Home shows a setup form. For each of the five seats, pick a catalog model or "Random from pool", and a personality or "Random". The pool is a set of checkboxes over the catalog (all checked by default). The default form starts a game in which every seat draws its model from the full catalog and its personality from the roster.
- The game state records each seat's resolved model and personality, plus the requested setup (seat choices and pool), so an archived game shows exactly how it was set up (PRD "Reproducible setup").
- Each turn is sent with the acting seat's model and that model's catalog parameters. The prompt carries the seat's own personality. An agent never learns another seat's model or personality.
- The live viewer and the record show model and personality under each seat. The record header shows "Mixed models" or the single model's name.
- D1 `game_players` rows carry each seat's real model and personality. `games.model` holds the shared model when every seat matches, and otherwise `mixed`.
- Version-1 games (live rooms and archive) render as before: every seat uses `game.model`, with no personality.

Verify: the automated suite, the dev model smoke run (one real call per catalog model), then the Phase 4 production drill.

### Key Discoveries:

- Retry safety needs the exact stored body, not just the same game state (`runtime.ts:196`). Each turn's body is built once, with its seat's model, and stored before the call, so retries stay byte-identical with no further change.
- Roles are shuffled inside `createGame`. Resolving seat models and personalities by seat index, independently of the role shuffle, keeps "operator picks a model per seat" from becoming "operator picks a model per role". Per-role control would confound S-08's per-role metrics.
- A `Random` personality must not repeat at one table (8 personalities, 5 seats). A `Random` model may repeat: the pool can be smaller than five.
- OpenRouter's `user` field is `game.id` today. Keep it: per-seat users add nothing.

## What We're NOT Doing

- Systematic model rotation across games (the third FR-003 mode). That belongs to S-09 batches.
- Models above the current rate ceilings, or any change to `SAFETY_USD` or the reservation formula. Pricier models wait for S-07's estimate and budget.
- Operator-editable personalities in the UI. The roster is a code constant.
- Showing other seats' model or personality to agents.
- Table size, role mix or new roles (S-05). Five seats with one Werewolf, one Seer and three Villagers stays fixed.
- Metrics, filters or per-model views (S-08, S-10). The home "recent games" list only shows the summary model label.
- Native model reasoning. It stays disabled for every model; rationale remains self-reported in the shared format.

## Implementation Approach

A new `workers/game/catalog.ts` holds the model catalog (id, short label, lab, request parameters) and the personality roster (id, name, prompt text). It is the single source of truth for the engine, the start validation, the pricing check and the setup form. The engine state moves to version 2, with per-player `model` and `persona` and a `setup` object. A small accessor (`seatModel`, `seatPersona`) gives every reader a version-agnostic view, so record, archive and UI code never branch on the version. `createGame` resolves the setup into concrete seats with the same injectable `pick`, so tests stay deterministic.

## Critical Implementation Details

- **Idempotent start.** A repeated `requestId` must return `ok` only for identical settings. Compare a canonical JSON of the *requested* setup (seat choices and pool, as normalized by validation), not the resolved seats, because random draws differ per resolution. A version-1 room (no `setup`) compares only `discussionPasses`, as today.
- **Pricing check before any spend.** Fetch the public catalog once per start, and require every distinct model the game can use to pass the existing ceiling test: the resolved seat models, which are drawn before the check. If any fails, return 503 with that model's id in the message and persist nothing. This keeps "no spend without verified pricing" per model.
- **Version fallback.** `seatModel(game, player)` returns `player.model ?? game.model`. `seatPersona` returns `player.persona ?? null`. `Game.model` stays on version 2 (shared model or `"mixed"`), so `publicGame`, the archive summary column and `listRecentGames` keep working unchanged.

## Phase 1: Catalog, personalities and engine v2

### Overview

Pure code only: the catalog, the roster, setup validation and resolution, the version-2 state, and per-seat request bodies. Also a dev script that proves each catalog model answers the real request shape.

### Changes Required:

#### 1. Catalog and roster

**File**: `workers/game/catalog.ts` (new)

**Intent**: One list of allowed models with any parameter differences, and one list of personalities. Everything else reads from here.

**Contract**:
- `type CatalogModel = { id: string; label: string; lab: string; temperature: number | null }`. `null` means the request omits `temperature`. `MODELS: readonly CatalogModel[]`, in this order:
  - `google/gemini-3.1-flash-lite` (Gemini 3.1 Flash Lite, Google, 0.7)
  - `anthropic/claude-haiku-5.5` (Claude Haiku 5.5, Anthropic, null)
  - `openai/gpt-6-luna` (GPT-6 Luna, OpenAI, null)
  - `deepseek/deepseek-v4-flash` (DeepSeek V4 Flash, DeepSeek, 0.7)
  - `qwen/qwen3.8-flash` (Qwen 3.8 Flash, Qwen, 0.7)
  - `mistralai/mistral-small-2603` (Mistral Small, Mistral, 0.7)
- `type Persona = { id: string; name: string; prompt: string }`. `PERSONAS: readonly Persona[]`, eight drafts for the operator to edit:
  - `analyst`, The Analyst: "You reason from evidence. You track who said what and point out contradictions calmly."
  - `accuser`, The Accuser: "You are bold and quick to name suspects. You push the table to act rather than wait."
  - `observer`, The Quiet Observer: "You speak briefly and rarely. When you do, it is a pointed question or a short verdict."
  - `diplomat`, The Diplomat: "You build consensus. You restate others' views fairly and look for a vote most people accept."
  - `contrarian`, The Contrarian: "You distrust the majority. You defend whoever is being piled on and test the strongest argument."
  - `storyteller`, The Storyteller: "You speak in vivid, confident narratives about what happened each night."
  - `cautious`, The Cautious One: "You avoid early commitments, hedge your claims, and change your mind only with good reason."
  - `instigator`, The Instigator: "You stir things up with provocative claims to see who reacts, and you watch the reactions closely."
- `modelById(id)` and `personaById(id)` return the entry or `undefined`.
- `MODEL` (in `engine.ts`) stays as the version-1 default and remains `MODELS[0].id`.

#### 2. Setup type, validation and resolution

**File**: `workers/game/setup.ts` (new)

**Intent**: Turn untrusted start input into a normalized setup, then into concrete seats.

**Contract**:
- `type SeatChoice = { model: string /* catalog id | "random" */; persona: string /* persona id | "random" */ }`.
- `type GameSetup = { seats: SeatChoice[] /* exactly 5 */; pool: string[] /* catalog ids, catalog order, deduplicated */ }`.
- `DEFAULT_SETUP`: five `{ model: "random", persona: "random" }` seats and every catalog id in the pool.
- `parseSetup(value: unknown): GameSetup | { error: string }`. `undefined` gives `DEFAULT_SETUP`. It rejects: a seat count other than 5, unknown ids, extra keys, an empty pool when any seat is `random`, a manually chosen persona used twice, and more `random` personality seats than unchosen personas left. A pool that no seat uses is kept but normalized.
- `resolveSeats(setup, pick): { model: string; persona: string }[]`. Seats are resolved in index order. A `random` model is `pool[pick(pool.length)]`. `random` personalities are drawn without replacement from personas no seat chose manually.

#### 3. Engine state v2 and per-seat requests

**File**: `workers/game/engine.ts`

**Intent**: Store seats and setup in state, and build each request for the acting seat.

**Contract**:
- `Player` gains optional `model?: string` and `persona?: string | null`. `Game.version` becomes `1 | 2`. `Game` gains optional `setup?: GameSetup`.
- `createGame(id, discussionPasses, now, setup = DEFAULT_SETUP, pick = randomIndex)` writes `version: 2`. It resolves seats first, then shuffles roles with the same `pick`. It sets per-player `model` and `persona`, `setup`, and `model` = the shared model id if all seats match, otherwise `"mixed"`.
- `seatModel(game, player)` and `seatPersona(game, player)` are exported accessors with the version-1 fallback.
- `PublicGame.players[]` gains `model: string` and `persona: string | null` (persona *name*, from the roster; `null` for v1, or for an id since removed from the roster).
- The actor's persona goes only into the system prompt (below); `agentView` is unchanged and carries nothing about any seat's model or persona.
- `buildRequest`: `model` = `seatModel(actor)`. `temperature` comes from the catalog entry and is omitted when `null` (an unknown model, such as a v1 game whose model was dropped from the catalog, keeps `0.7`). When the actor has a persona, the system prompt appends: "Your personality: {name}. {prompt} Let it shape how you speak and decide, but always play to win for your team." `response_format` becomes a strict per-phase JSON schema (`{text, rationale}` or `{target ∈ allowedTargets, rationale}`, no extra keys) instead of bare `json_object`. This was added during Phase 3: in dev, Claude Haiku 5.5 broke bare JSON mode on 2 of 3 first-night investigations. All six models list `structured_outputs`. `validateMove` still enforces the length limits. All other body fields are unchanged.

#### 4. Model smoke script

**File**: `scripts/model-smoke.ts` (new), `package.json`

**Intent**: Before any paid game, prove each catalog model accepts the exact request shape (JSON object, reasoning disabled, its parameters, the price-capped provider routing) and returns a move that `validateMove` accepts, within 256 output tokens.

**Contract**: `npm run smoke:models` runs `node --env-file=.dev.vars scripts/model-smoke.ts`. For each catalog model, it builds a version-2 game with every seat set to that model, then sends one `discuss` and one `vote` request through `callOpenRouter`. It prints `model, phase, ok|reason, cost, latencyMs` per call and exits non-zero on any failure. It never runs in `npm test`. Expected spend: under $0.01 in total.

### Success Criteria:

#### Automated Verification:

- Setup tests pass: default setup, manual seats, pool draws with repeats, no repeated random personas, every rejection case in `parseSetup`, and deterministic resolution with an injected `pick`: `npm test -- setup`
- Engine tests pass: v2 `createGame` stores seats, setup and the summary `model`; roles are shuffled independently of seat resolution; `buildRequest` uses the actor's model, omits `temperature` for null-temperature models, and appends only the actor's persona; `agentView` and the request body contain no other seat's model or persona; a v1 state still builds a v1-identical body: `npm test -- live-engine`
- Existing suite stays green: `npm test`
- Typecheck passes: `npm run typecheck`

#### Manual Verification:

- `npm run smoke:models` succeeds for all six models with a real key in `.dev.vars`. A model that fails gets a parameter fix, or is dropped from the catalog with the operator's agreement.
- The operator reviews and edits the eight personality texts.

**Implementation Note**: Pause after this phase for the two manual checks. The catalog may change as a result.

---

## Phase 2: Start API, pricing and archive

### Overview

Accept the setup over the start API, verify pricing per model, and carry seats into the record and the D1 archive.

### Changes Required:

#### 1. Start API

**File**: `workers/game/routes.ts`, `workers/game-room.ts`, `workers/game/runtime.ts`

**Intent**: The start endpoint takes an optional setup, and the room stores it, idempotently.

**Contract**:
- The request body allows `{ requestId, discussionPasses, setup? }`. `setup` goes through `parseSetup`, which returns 400 with its error message. The body size limit rises from 2048 to 4096 bytes.
- `GameRoom.startLive(gameId, discussionPasses, setup: GameSetup)` and `LiveGame.start(id, discussionPasses, setup)`.
- Idempotency: an existing game returns `ok` only when `id` and `discussionPasses` match, and `canonical(existing.setup ?? null)` equals `canonical(setup)` (for a v1 room, only when the request omitted `setup`). Otherwise 409, as today.

#### 2. Per-model pricing check

**File**: `workers/game/runtime.ts`

**Intent**: Each distinct seated model must pass the existing ceiling test before the game is written.

**Contract**: `pricingAvailable(models: string[]): Promise<{ ok: true } | { ok: false; model: string }>` runs one catalog fetch with the same rules per model. `start` resolves the game first (in memory), checks `distinct(players.model)`, and on failure returns `503 "Cannot verify safe pricing for <model>. Try again later."` with nothing persisted.

#### 3. Record and archive

**File**: `workers/game/record.ts`, `workers/game/archive.ts`, `migrations/0002_player_persona.sql` (new)

**Intent**: The record shows each seat's model and personality, and the archive stores them.

**Contract**:
- `RecordPlayer` gains `persona: string | null` (the persona id). Its `model` comes from `seatModel`. `GameRecord` gains `setup: GameSetup | null` (null for v1).
- Migration `0002`: `ALTER TABLE game_players ADD COLUMN persona TEXT;`. Additive, nullable. Version-1 rows stay `NULL`.
- `writeArchive` inserts `persona`. `games.model` keeps receiving `record.model` (the shared id, or `mixed`). `readArchivedRecord` is unchanged: it rebuilds from `state_json`.

#### 4. Test helpers

**File**: `test/live-helpers.ts`

**Intent**: The pricing stub covers the whole catalog, and helpers can start a game with a given setup.

**Contract**: `catalog()` lists every `MODELS` id at in-ceiling prices. `catalog({ overpriced: id })` prices one model above the ceiling. `startLiveGame(setup?)` passes the setup through.

### Success Criteria:

#### Automated Verification:

- Start API tests pass: omitted setup gives the default; a manual mixed setup is stored exactly; an invalid setup gets 400 with a message; a repeated request with the same setup is `ok`; a different setup gets 409; a v1 room still accepts a setup-less repeat; an overpriced seated model gets 503 naming it, persists nothing and sets no alarm; an overpriced model that is in the pool but drawn by no seat doesn't block: `npm test -- live-game`
- Runtime tests pass: a mixed game sends each turn with its actor's model (assert on the stub's received bodies); a retried turn reuses the byte-identical stored body: `npm test -- game-room`
- Archive tests pass: a mixed game archives per-seat `model` and `persona` with `games.model = 'mixed'`; a single-model setup archives that model; a v1 state archives with `persona` NULL and `game.model` per seat: `npm test -- archive`
- Record tests pass for v1 and v2 states: `npm test -- record`
- Local migration applies: `npm run db:migrate:local`
- Typecheck passes: `npm run typecheck`

---

## Phase 3: Setup form and seat labels

### Overview

The operator configures seats on the home page and sees them while watching and in the record.

### Changes Required:

#### 1. Home setup form

**File**: `app/routes/home.tsx`

**Intent**: A plain form (no client JS required) for per-seat models and personalities and the model pool, replacing "All seats use {model}".

**Contract**:
- The loader adds `models: MODELS` (id and label) and `personas: PERSONAS` (id and name).
- The form has five seat rows ("Seat 1"…"Seat 5"), each with a model `<select name="seatModel">` ("Random from pool", then catalog labels) and a personality `<select name="seatPersona">` ("Random", then roster names). Below them, a "Model pool" fieldset of checkboxes `name="pool"`, all checked by default.
- The action builds `setup` from `getAll()` in form order and passes it in the start body. A validation error renders as today's alert. Field choices survive the error re-render.
- Intro copy changes from "Five agents. One hidden wolf." and the single-model sentence to say seats can mix models and personalities. Roles are still shuffled for each game.
- The recent-games list shows "Mixed models" for `mixed` and the catalog label (or the raw id) otherwise.

#### 2. Live viewer seat labels

**File**: `app/routes/games.$gameId.tsx`

**Intent**: Each seat card shows its model label and personality name. The header shows "Mixed models" or the model label.

**Contract**: The player card adds a line with `labelFor(player.model)` and, when present, `player.persona`. A long model id truncates with its full value in a `title`. Roles are still hidden while running.

#### 3. Record seat labels

**File**: `app/routes/games.$gameId.tsx`

**Intent**: Same labels on record player cards. Timeline actor labels become "Cora (Seer · Claude Haiku 5.5)", so you can read who reasoned how.

**Contract**: The record view resolves the persona name from the id through `personaById` (falling back to the id). A v1 record shows the model and no personality.

### Success Criteria:

#### Automated Verification:

- Route tests pass: the home loader exposes catalog and roster; the action forwards a manual setup and re-renders an invalid one with an error; the live snapshot and record page render model and personality per seat; a v1 record renders unchanged apart from the model line: `npm test -- routes record-routes`
- Live privacy regression stays green: no running snapshot or socket event contains roles, rationale or the persona *prompt* text: `npm test`
- Typecheck and build pass: `npm run typecheck && npm run build`

#### Manual Verification:

- In dev, a default-form game seats mixed models, and the viewer shows the labels
- In dev, a manual setup (two seats on one model, three on others, chosen personalities) plays to the end, and the record matches the choices

---

## Phase 4: Production rollout and drill

### Overview

Ship through CI and prove mixed tables in production.

### Changes Required:

#### 1. Verification record

**File**: `context/changes/mixed-model-seats-and-personas/verification.md`

**Intent**: Record the deploy, the migration, the smoke run, and the production games. Same format as the S-03 verification.

**Contract**: Evidence sections for local checks, the model smoke table (model, discuss/vote result, cost, latency), the deploy (version id, migration `0002` output) and the drill table (game id, setup summary, status, turns, per-seat models in `game_players`).

### Success Criteria:

#### Automated Verification:

- CI applies migration `0002` remotely and deploys; `/healthz` passes
- `npx wrangler d1 execute agent-werewolves-archive --remote --command "SELECT game_id, seat, model, persona FROM game_players WHERE game_id = '<drill id>'"` shows five rows matching the drill setup

#### Manual Verification:

- The operator starts one default (all-random) game and one manual game with five different models, and both play to the end
- Each record shows the right model and personality per seat, and `games.model = 'mixed'`
- An S-03 game (version 1) still opens as a record with its model and no personality

---

## Testing Strategy

### Unit Tests:

- `parseSetup` and `resolveSeats`: every validation rule, pool repeats, persona uniqueness, determinism with an injected `pick`.
- Engine: per-seat bodies, `temperature` omission, persona isolation, v1 body unchanged.
- Record projection for v1 and v2 states.

### Integration Tests:

- Start API: default, manual, invalid, idempotent repeat, conflicting repeat, per-model pricing failure.
- Room: per-turn model routing with the stubbed LLM, retry body identity, archive rows per seat.
- Routes: setup form round trip, seat labels in live and record views.

### Manual Testing Steps:

1. `npm run smoke:models` with a real key.
2. In dev: one default game and one manual game, watched to the end.
3. In production: the Phase 4 drill.

## Performance Considerations

Request bodies grow by one persona sentence (about 200 bytes), well inside `MAX_INPUT_BYTES`. The start makes one catalog fetch, as today. No new per-turn work.

## Migration Notes

- D1 `0002` is additive (one nullable column). Rolling the Worker back leaves the column unused and harmless.
- Engine state v2 is read by code that also reads v1. Rolling back to pre-S-06 code would misread v2 rooms only in that they'd run every seat with `game.model` = `"mixed"`, which OpenRouter rejects. Such games would abort with `provider_error` and still archive. Acceptable for a rollback, and noted in the verification record.
- `GameRoom` class and DO migrations are unchanged.

## References

- Roadmap: `context/foundation/roadmap.md` (S-06)
- PRD: FR-003, FR-004, Reproducible setup (`context/foundation/prd.md`)
- Prior slice: `context/archive/2026-11-02-game-record-with-reasoning/`
- OpenRouter public model catalog, read 2026-11-08 (supported parameters and prices for the six catalog models)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Catalog, personalities and engine v2

#### Automated

- [x] 1.1 Setup tests pass — 3c99789
- [x] 1.2 Engine tests pass — 3c99789
- [x] 1.3 Existing suite stays green — 3c99789
- [x] 1.4 Typecheck passes — 3c99789

#### Manual

- [x] 1.5 Model smoke succeeds for every catalog model — 3c99789
- [ ] 1.6 Operator reviewed the personality texts

### Phase 2: Start API, pricing and archive

#### Automated

- [x] 2.1 Start API tests pass — f0bf034
- [x] 2.2 Runtime tests pass — f0bf034
- [x] 2.3 Archive tests pass — f0bf034
- [x] 2.4 Record tests pass — f0bf034
- [x] 2.5 Local migration applies — f0bf034
- [x] 2.6 Typecheck passes — f0bf034

### Phase 3: Setup form and seat labels

#### Automated

- [x] 3.1 Route tests pass — 2b217ce
- [x] 3.2 Live privacy regression stays green — 2b217ce
- [x] 3.3 Typecheck and build pass — 2b217ce

#### Manual

- [x] 3.4 Default-form dev game seats mixed models — 2b217ce
- [x] 3.5 Manual-setup dev game matches its record — 2b217ce

### Phase 4: Production rollout and drill

#### Automated

- [ ] 4.1 CI applies migration 0002 and deploys; healthz passes
- [ ] 4.2 Remote D1 shows per-seat models for the drill game

#### Manual

- [ ] 4.3 Default and manual production games play to the end
- [ ] 4.4 Records show the right seat labels and mixed summary
- [ ] 4.5 An S-03 game still opens as a record
