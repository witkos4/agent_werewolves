# S-02 verification

Date: 2026-10-29. Status: verified locally and on production (drill below). One gap is recorded as not observed: a mid-game room restart in production.

## Local evidence

- `npm test`: the full Workers-runtime suite passes, including the existing spike/access tests and the new live-game engine, runtime and socket tests. Providers and pricing responses are stubbed; the suite never reaches the network.
- `npm run typecheck`: passes, including regenerated Cloudflare and React Router types.
- `npm run build`: client and Worker SSR builds pass.
- `npx wrangler deploy --dry-run`: passes with the existing `GAME_ROOM` binding and `GameRoom` export; no deployment performed.
- `git diff --check`: passes.
- Started the real React Router dev Worker with disposable fake credentials, then stopped it after HTTP checks: authenticated `/` returns 200 with the start form and `Cache-Control: no-store`; invalid `POST /api/games/start` returns 400; `/games/not-a-uuid` returns 404 with the game error boundary. No paid start was made.

The game tests cover both winners; night action order; dead Seer handling; one/two discussion passes; simultaneous votes; persisted random tie resolution; invalid targets/output; role/rationale/investigation isolation; stable request bodies; context bounds; a complete game resumed after eviction; per-attempt reservations; quiet-period retries; unknown usage cost; deadline aborts and late results; stalled models; exhausted attempts; unsafe/unavailable pricing; duplicate starts; authentication; public snapshots; WebSocket cursor replay, heartbeat and socket expiry. A legacy-schema reconstruction test verifies that an old spike room still completes after the new tables are added.

The live socket test uses one local monotonic clock from initiating a stubbed alarm through receiving its public event, requiring less than two seconds. This checks local delivery through the real Workers WebSocket path, not production latency or model speed.

## Pricing evidence

Read the public OpenRouter `/api/v1/models` catalog on 2026-10-29. For `google/gemini-3.1-flash-lite`, prompt price was $0.25/million tokens and completion/internal reasoning $1.50/million tokens. The implementation checks the catalog at each new start and routes with ceilings of $0.50/million input and $2.00/million output, with reasoning disabled and at most 256 output tokens. Input is bounded to 48,000 UTF-8 bytes. Each attempt permanently reserves its byte-based input allowance, a 2,048-token envelope margin and maximum output, before the request is sent. The per-game reservation ceiling is $0.25.

This does not prove gateway cache hits are free in the deployed Durable Object. Unknown costs remain null, retries consume new reservations, and S-07 retains the production retry-cache proof. The safety mechanism also does not cap aggregate spend across separately started games.

## Deployed drill (2026-10-29)

Run from a laptop harness against production with the bearer key: it started each game, followed the viewer WebSocket, dropped and resumed the socket mid-game, and scanned every snapshot and event. All three games used `google/gemini-3.1-flash-lite`.

| Game | Version | Rounds | Events | Duration | Winner | Roles at end |
|---|---|---|---|---|---|---|
| `1edee8de-6719-451c-baa5-32620f73e914` | `95533bd1` | 1 | 13 | 14 s | Werewolves | Dax=Werewolf, Cora=Seer |
| `5f6a585d-dd56-4203-be4b-0dc7f5c1997d` | `95533bd1` | 2 | 16 | 17 s | Werewolves | Dax=Werewolf, Ada=Seer (killed night 1) |
| `67032a0c-b3a8-4aef-9a06-a081151a7094` | `8cfcae8c` | 2 | 17 | 17 s | Werewolves | Bram=Werewolf, Esme=Seer |

1. **Deploy and gate.** `/healthz` reported `c732071f`, the CI deploy of #16; it matched `wrangler deployments list`. Anonymous `GET /api/games/<uuid>`, `POST /api/games/start` and the game socket returned 404; `/games/<uuid>` and `/` redirected to `/login`. Before game 1 the operator rotated `ACCESS_KEY` (version `95533bd1`, same code).
2. **Real games.** Each start returned 200. Re-sending the same request returned 200; changing `discussionPasses` for the same UUID returned 409. The gateway accepted structured output, disabled reasoning and the price ceilings: no attempt failed. Phases ran night investigate, kill, discussion (one or two passes), simultaneous vote reveal, night. Game 2's dead Seer was skipped on night 2. Every game ended at parity (1 wolf v 1 villager) after one missed village vote.
3. **Reload and leaks.** Each game dropped its socket mid-game, took a snapshot, and reconnected with `?after=<last seq>`: no gaps or duplicates, and a fresh `?after=0` replay matched the assembled stream byte for byte. No running snapshot or event carried `role`, `rationale`, `investigations`, `privateMoves`, `queue` or `votes`; roles appeared only in the `finished` event. The Seer's day speech in game 1 used its own investigation, not leaked data. The old spike room (`d6bfee87-…`) still served its journal and replayed its 5 events over its socket.
4. **Redeploy.** Game 2's redeploy (`8cfcae8c`, same commit) went live 0.1 s after the game finished. Game 3 started on `8cfcae8c` while `e6379bea` (same commit) was deploying. `wrangler tail` showed every one of its alarms on `8cfcae8c` until the end, while other requests already ran on `e6379bea`. The busy room never restarted, so it finished without a gap. **Not observed:** a production restart or eviction mid-game followed by a resume of the saved turn. Only the local eviction test covers it.
5. **Live delivery.** Clock offset bounded by the start request (window 469–604 ms) and by non-negative delivery. Upper-bound server-to-viewer delivery: p50 625 / max 648 ms (game 1, n=10) and p50 490 / max 502 ms (game 2, n=13), within the 2 s target. Gaps between server events, which include model latency plus the 250 ms turn delay, were p50 1.0–1.2 s and max 1.5 s. Model latency itself is not exposed publicly.
6. **Controlled failure.** Local dev Worker with disposable credentials and an invalid OpenRouter key, against the real catalog and gateway. The start passed the pricing check. The first call was rejected and the room aborted at once with `provider_error`: no winner, no roles revealed, two events. The code deletes the alarm on abort. A watch past the 45 s quiet period was not completed.

Production now runs `e6379bea`, the same code as `main` at `00bef06`. The per-game safety allowance held: no game approached its ceiling. Actual per-game spend is not exposed by the public API; S-03's record should capture it. External archive persistence, reasoning inspection and archive listings remain later slices.
