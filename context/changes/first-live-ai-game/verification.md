# S-02 verification

Date: 2026-10-29. Status: implemented and verified locally; production acceptance pending.

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

## Remaining deployed drill

No runtime secrets are configured in this checkout. No paid model call, production secret update, deploy, push or merge was performed. The following evidence is required before marking S-02 done:

1. Deploy the reviewed change through the normal repository flow with the existing production access key and OpenRouter credential. Check `/healthz` reports the intended version and anonymous real-game endpoints return 404.
2. Sign in, start a one-round game, and record its UUID, deployed version, configured model, public phase progression and final winner/role reveal. Verify the gateway accepts structured output, disabled reasoning and routing price ceilings. Repeat with two discussion rounds if needed to cover the setting against the real model.
3. Disconnect/reload mid-game and reopen the saved URL. Confirm that the transcript has no missing/duplicate entries, hidden roles never enter the running snapshot/socket payloads, and completed roles appear only at the end. Check an old spike viewer still works.
4. Observe a room after eviction or a between-turn redeploy and confirm it resumes its saved turn. Record failures explicitly; do not infer free retries from one-attempt calls.
5. Measure connected-viewer delivery with a harness using one clock at the server commit/broadcast boundary and viewer receipt, or explicitly bounded clock synchronization. Record model latency separately. Do not subtract unsynchronized browser/server timestamps.
6. Verify a controlled provider failure or deadline/budget exhaustion in an isolated test environment produces a terminal abort with no winner or subsequent paid calls. Avoid disrupting existing games or changing the production credential for this drill.
7. Store the observed outcomes here, then mark the roadmap slice done. External archive persistence, reasoning inspection and archive listings remain later slices.
