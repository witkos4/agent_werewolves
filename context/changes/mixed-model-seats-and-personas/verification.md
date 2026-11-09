# S-06 verification

Date: 2026-11-08 to 2026-11-09. Status: verified in production (drill below). Open: operator review of the personality texts (plan step 1.6),.

## Model smoke (Phase 1)

`npm run smoke:models` with a real OpenRouter key, 2026-11-08. Each model got one `discuss` and one `vote` request built by `buildRequest` (all five seats on that model, random personalities). Every reply passed `validateMove`.

| Model | discuss | vote | Cost (both) | Latency (discuss / vote) |
|---|---|---|---|---|
| google/gemini-3.1-flash-lite | ok | ok | $0.00047 | 1990 / 1130 ms |
| anthropic/claude-haiku-5.5 | ok | ok | $0.00024 | 1271 / 894 ms |
| openai/gpt-6-luna | ok | ok | $0.00016 | 1943 / 1429 ms |
| deepseek/deepseek-v4-flash | ok | ok | $0.00013 | 1237 / 810 ms |
| qwen/qwen3.8-flash | ok | ok | $0.00021 | 1641 / 4847 ms |
| mistralai/mistral-small-2603 | ok | ok | $0.00022 | 968 / 648 ms |

Total $0.00143, 0 failures.

## Dev games and the strict-schema fix (Phase 3)

Real dev Worker (`react-router dev`, real OpenRouter key passed through the environment), games started by POSTing the home form with a bearer key.

1. **Default form** (every seat random from all six models, random personalities): `8fdddedd-3b14-4333-b74f-9fbcebe5fb4a` finished (Werewolves win) with four different models at the table: GPT-6 Luna ×2, Qwen 3.8 Flash, Gemini 3.1 Flash Lite, DeepSeek V4 Flash. The snapshot showed each seat's model and personality.
2. **Manual setup** (Claude Haiku 5.5 ×2 as Analyst and Accuser, GPT-6 Luna as Storyteller, DeepSeek V4 Flash as Contrarian, Mistral Small with a random personality, pool = Qwen) aborted with `invalid_model_response` in 3 of 4 runs (`dacd90ef…`, `7cb93a6f…`, `ba1ad5ba…`; one finished). Rejected replies weren't kept, so the room now stores the rejected `response_text` on the pending turn and logs `invalid_model_response {gameId, turn, model, error, text}`. The logs showed Claude Haiku 5.5 on the Seer's night-1 investigation:
   - `SyntaxError: Unterminated string`, reply `{"target":"p2","rationale":"…",\"}`
   - `unexpected_move_field`, reply `{"target":"p3","rationale":"…","ticket":null}`

   The Phase 1 smoke run had only covered discuss and vote, one sample each.
3. **Fix:** `response_format` is now a strict per-phase JSON schema instead of bare `json_object`. The smoke script now covers all four phases, 3 samples each, with distinct turn ids so the cache never answers. Result: **72/72 ok**, $0.00753.
4. **Manual setup rerun ×3 after the fix:** `0183f326-80e6-4ab2-aa3b-25b9a9839fbe` (Village), `99e65873-3eab-412e-9965-2dec2697a40f` (Werewolves), `e653e1db-5a76-41a0-b654-4458ae8a9aa4` (Village). All finished. For `0183f326…`, the record page (Archived) shows "Mixed models", each seat's model and personality, and timeline labels such as "Cora (Seer · GPT-6 Luna)". Local D1 has `games.model = 'mixed'`, and `game_players` lists p1–p5 with the chosen models, the chosen personas and the drawn `cautious` for p5.

## Deploy (2026-11-08)

The merge of #20 (`3111431`, CI run 42530775547) passed on the first try. **Apply D1 migrations** applied `0002_player_persona.sql` (✅). The deploy step published `c7cf8676-f0aa-4f29-845c-eb0845a42b09`, and `/healthz` returned ok.

The operator then rotated `ACCESS_KEY` three times (`c0ff47ee` on 2026-11-08, and `5344908c` and `930d79b6` on 2026-11-09). Each rotation is a secret-only version on the same code. The Cloudflare API reports `last_deployed_from: dash` for `agent-werewolves` (modified 2026-11-09T20:55:20Z), so the next CI deploy will hit the "Unable to fetch bindings, routes, or services metadata" failure from S-03 unless one same-commit laptop `npm run deploy` runs first (README → CI secrets and variables). At 21:16 UTC a laptop deploy of the same code (docs-only diff from `3111431`) published `04d277dd-8f75-43ea-a7ea-351a9c426405`. The flag then read `wrangler`, `/healthz` returned ok, and the current key passed the gate (200). The operator also rotated the GitHub `CLOUDFLARE_API_TOKEN`; the next merge's CI run is its first real use.

Rollback note (from the plan): pre-S-06 code would run a v2 room's seats with `game.model = "mixed"`, which OpenRouter rejects. Such a game aborts with `provider_error` and still archives.

## Production drill (2026-11-09)

Both games were started over the bearer API with two discussion passes, at 20:59 UTC on `930d79b6` (code `c7cf8676`). Rows were read with `npx wrangler d1 execute agent-werewolves-archive --remote`.

| Game | Setup | Status | Turns | `game_moves` | Cost | Archived (UTC) | `games.model` |
|---|---|---|---|---|---|---|---|
| `b0422f78-400a-4306-bfd7-5e2064a8022f` | default (all random, full pool) | finished, Village | 14 | 14 | $0.00179 | 20:59:52 (at end) | `mixed` |
| `a1761c7d-a42b-469c-8ee1-7f94536f0e73` | manual, five models, four chosen personalities + one random, pool = Mistral (unused) | finished, Werewolves | 15 | 15 | $0.00277 | 20:59:56 (at end) | `mixed` |

`game_players` (seat, role, model, persona, survived):

| Game | p1 | p2 | p3 | p4 | p5 |
|---|---|---|---|---|---|
| `b0422f78…` | Werewolf, gpt-6-luna, observer, ✗ | Villager, qwen3.8-flash, analyst, ✓ | Seer, gpt-6-luna, accuser, ✗ | Villager, qwen3.8-flash, diplomat, ✓ | Villager, gpt-6-luna, instigator, ✓ |
| `a1761c7d…` | Villager, gemini-3.1-flash-lite, analyst, ✗ | Seer, claude-haiku-5.5, accuser, ✗ | Villager, gpt-6-luna, diplomat, ✓ | Villager, deepseek-v4-flash, contrarian, ✗ | Werewolf, qwen3.8-flash, storyteller (drawn), ✓ |

1. **Default game.** The draws came out as two models (GPT-6 Luna ×3, Qwen 3.8 Flash ×2) and five distinct random personalities. 0 unknown-cost turns.
2. **Manual game.** Every seat matches the request: four chosen personalities, and `storyteller` drawn for p5 from the personalities not chosen. All five labs played at one table, and Claude Haiku 5.5 completed its Seer moves under the strict schema.
3. **Records.** Both `/games/<id>` pages (HTTP 200) show **Archived**, "Mixed models", each seat's model label and personality name, and timeline labels such as "Bram (Seer · Claude Haiku 5.5)". These were checked in the server-rendered HTML.
4. **Version 1.** S-03's `a1e74713-9829-4f58-8779-467f88c3f6a5` (`engine_version` 1) still opens as an **Archived** record. It shows "Gemini 3.1 Flash Lite" per seat and in the timeline labels, and no personality.

Not exercised in production: the 503 for an overpriced seated model (covered by the stubbed-catalog tests), and starting from the home form in a browser (the form was exercised in dev, Phase 3).
