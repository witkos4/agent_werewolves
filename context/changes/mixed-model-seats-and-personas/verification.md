# S-06 verification

Date: 2026-11-08. Status: in progress.

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
