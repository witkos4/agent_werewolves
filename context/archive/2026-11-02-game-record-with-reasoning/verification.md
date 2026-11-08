# S-03 verification

Date: 2026-11-03. Status: verified locally and in production (drill below). Every plan success criterion is met. The CI rollout needed three Cloudflare fixes first, recorded under Deploy.

## Local evidence

- `npm test`, `npm run typecheck`, `npm run build` and `npx wrangler deploy --dry-run` pass. They ran at each phase commit (b892623, 1543d34, cf1d22a) and in CI on #18. The suite stubs every provider and D1 failure and never reaches the network.
- `npm run db:migrate:local` applies `0001_archive.sql` to a fresh dev database (6 commands).
- Real dev Worker (`npm run dev`, real OpenRouter key), driven over the bearer API:
  - `47eef0df-2009-4be8-9f88-c340b91b00c3`: finished (Village win) in about 20 s with two discussion passes. 14 turns, 14 `game_moves` rows, 5 `game_players` rows, $0.0039. `/games/<id>` served the record with roles, rationale beside every speech and each individual vote, both night actions marked *Private* with the Seer's result, and the **Archived** badge. Home listed it first.
  - `c875ae21-225a-44fb-8a29-0dab3f606ea1`: a stale OpenRouter key aborted the game with `provider_error` before any move. It still archived: status `aborted`, 0 moves, 5 players, "Game stopped" with the provider message and every role.
- Plan steps 3.3 and 3.4 were checked by reading server-rendered HTML, not in a browser: headless Chrome on this machine can't make any network request. The operator checked the in-place live-to-record switch in a real browser in production (drill step 4).

## Deploy (2026-11-03)

The merge of #18 (`5c1d293`) went red at **Apply D1 migrations** with `code: 7403`, before any code deployed. Production stayed on the S-02 code throughout. Three problems, fixed in order:

1. **CI token without D1.** The existing token, and then a per-Worker "API token for external CI/CD" from the Worker's settings page, both reached Workers but returned `Authentication error` on every D1 call. The operator created an Account API token with the *Edit Cloudflare Workers* template plus **Account · D1 · Edit**. With it, CI applied `0001_archive.sql` remotely (✅).
2. **Dashboard-deployed Worker.** `wrangler deploy` then failed: "Unable to fetch bindings, routes, or services metadata from the dashboard". An `ACCESS_KEY` edit in the dashboard (08:37, version `92b56688`) had set the Worker's `last_deployed_from` to `dash`. For such Workers, wrangler first downloads the dashboard config, and the token can't read the routes and custom-domain endpoints (this account has no zones). One laptop `npm run deploy` of the same commit (`943a10a0`) reset the flag to `wrangler`. The CI rerun then passed: "No migrations to apply", deploy `1437871b-654c-42b1-ae9b-c9c5736909c2`, `/healthz` ok.
3. **Gate locked.** The 08:37 dashboard key had 16 characters, so the gate failed closed ("ACCESS_KEY is unset or too short"). A 44-character key was set with `wrangler secret put ACCESS_KEY`, and the gate answered 200 with the key and 302 without.

At 09:46 the operator rotated `ACCESS_KEY` in the dashboard again (`bd23e871`), which set `dash` again. A same-commit laptop deploy (`b88b7076-bb32-4ffe-911b-edd775da9f53`) reset it, so the next merge deploys normally. README → CI secrets and variables now documents the token recipe and the dashboard pitfall.

## Production drill (2026-11-03)

All games used `google/gemini-3.1-flash-lite`. Rows were read with `npx wrangler d1 execute agent-werewolves-archive --remote`.

| Game | Source | Status | Turns | `game_moves` | `game_players` | Cost | Archived (UTC) |
|---|---|---|---|---|---|---|---|
| `8fd10f38-ed8e-44ef-8a6b-93d10e9a5636` | new, bearer API | finished, Werewolves | 15 | 15 | 5 | $0.00466 | 09:17:33 (at end) |
| `a1e74713-9829-4f58-8779-467f88c3f6a5` | new, operator in browser | finished, Village | 14 | 14 | 5 | $0.00407 | 09:47:46 (at end) |
| `1edee8de-6719-451c-baa5-32620f73e914` | S-02 drill (legacy) | finished, Werewolves | 12 | 12 | 5 | $0.00278 | 09:17:42 (on open) |
| `5f6a585d-dd56-4203-be4b-0dc7f5c1997d` | S-02 drill (legacy) | finished, Werewolves | 15 | 15 | 5 | $0.00425 | 09:17:43 (on open) |
| `67032a0c-b3a8-4aef-9a06-a081151a7094` | S-02 drill (legacy) | finished, Werewolves | 16 | 16 | 5 | $0.00482 | 09:17:44 (on open) |
| `13d20393-4e29-42b4-9d44-c6313f8ac962` | pre-S-03 game from 2026-11-02 (legacy) | finished, Village | 14 | 14 | 5 | $0.00386 | 09:46:55 (on open) |

1. **New game.** Started over the API with two discussion passes. It finished in about 22 s, and the archive row landed in the same second the game ended. `/games/<id>` served the record with **Archived**.
2. **Legacy rooms.** On first open, each S-02 drill URL returned 200 with **Archiving…**. All three were **Archived** within about 3 s (the read enqueues the room and its alarm writes D1). Every known cost was recovered from the rooms' `live_turns` (0 unknown-cost turns), so S-02's per-game spend is now known: $0.0028–$0.0048.
3. **Home list.** `/` linked all archived games, newest first.
4. **Live to record.** The operator started `a1e74713…` from the home page in a browser and watched it. When it ended, the page switched to the record on its own, with roles, rationale and the **Archived** badge.
5. **Fidelity.** For `8fd10f38…`, all 15 `Private rationale:` texts on the page equal the 15 `game_moves.rationale` values (same multiset; none missing). The phases in turn order: investigate, kill, 8 × discuss, 4 × vote, kill. On every game, `game_moves` count = `turns`.

Not exercised in production: a D1 outage during archiving (covered by the stubbed-`batch` retry tests) and an aborted production game.
