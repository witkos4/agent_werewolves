---
project: agent-werewolves
researched_at: 2026-10-18
recommended_platform: Cloudflare Workers (Static Assets + Durable Objects + Workflows)
runner_up: Render
context_type: mvp
tech_stack:
  language: TypeScript
  framework: React Router v8.4 (framework mode, SSR, Vite 8)
  runtime: Cloudflare Workers (workerd, nodejs_compat) — migrating from the scaffolded Node 24 template
---

## Recommendation

**Deploy on Cloudflare Workers, with game rooms as Durable Objects and long games driven by Workflows or Durable Object alarms.**

The game workload is the deciding constraint: 45-minute games, live spectator events within 2 s, and headless batches of 10–20 games. Of the six candidates, only Cloudflare provides stateful long-lived compute (Durable Objects plus WebSocket Hibernation), durable multi-step execution (Workflows, GA), and official React Router v8 support, all on a free tier with a $5/month realistic ceiling. It scored 10/10 on the agent-friendly criteria, best fits "minimize cost", and matches the tech-stack hand-off, which already planned game rooms as Durable Objects. Single-region and external-Postgres answers carry no penalty: Supabase connects through Hyperdrive.

**Correction to `tech-stack.md`:** the hint `deployment_target: cloudflare-pages` should read **Cloudflare Workers (Static Assets)**. Cloudflare's Pages docs say "start new projects with Workers", and Durable Objects and Workflows must be exported from a Worker entry anyway.

### Interview constraints

| Question | Answer | Effect |
|---|---|---|
| Persistent connections / workers | Yes | Hard filter: dropped Netlify and Vercel |
| Cost vs DX | Minimize cost | Penalized Fly.io (no free tier) and Render's $7 floor |
| Platform familiarity | None (leans Cloudflare as free; sees hyperscalers as paid) | No tie-break applied |
| Geography | Single region | Edge is a non-factor; no penalty for single-region PaaS |
| Co-located services | External providers fine | Supabase Postgres for the archive; co-location not weighted |

## Platform Comparison

Scoring: Pass = 2, Partial = 1, Fail = 0. Research checked 2026-10-18 against official docs, pricing pages, npm, and GitHub.

| Platform | CLI-first | Managed/Serverless | Agent-readable docs | Stable deploy API | MCP / Integration | Total | Est. MVP cost |
|---|---|---|---|---|---|---|---|
| **Cloudflare Workers** | Pass | Pass | Pass | Pass | Pass | **10** | $0–5/mo |
| **Render** | Partial | Pass | Pass | Pass | Pass | **9** | ~$7/mo |
| **Railway** | Partial | Pass | Pass | Partial | Pass | **8** | ~$5–10/mo |
| Fly.io | Pass | Partial | Pass | Partial | Partial | 7 | ~$3.70–6.70/mo |
| Vercel | — | — | — | — | — | Filtered | $0 / $20 Pro |
| Netlify | — | — | — | — | — | Filtered | $0 (300 credits) |

### Per-platform notes

**Cloudflare Workers.**
- **CLI:** `wrangler deploy`, `wrangler versions upload/deploy` (percentage splits), `wrangler rollback` (last 100 versions), and `wrangler tail`.
- **Docs:** every page is available as markdown via `/index.md`, plus `llms.txt` and `llms-full.txt`.
- **MCP:** the remote server at `mcp.cloudflare.com/mcp` exposes the full API, and `docs.mcp.cloudflare.com` serves the docs. The older bindings, observability, and builds MCP servers are **deprecated**.
- **Durable Objects:** on the Free plan since 2025-04-07 (SQLite-backed, GA). Free covers 13,000 GB-s/day; Paid includes 400k GB-s/month. One 45-min game is about 337 GB-s, so 100 games/month is about 34k GB-s.
- **Workflows:** GA since 2025-04-07. Free allows 3,000 steps/day, 1,024 steps per workflow, and 100 concurrent runs.
- **Bundle limit:** 64 MiB uncompressed. Startup must finish within 1 s.

**Render.**
- **Fit:** runs the existing Dockerfile or native Node 24 unchanged, with unlimited-length WebSockets.
- **Free web services:** spin down after 15 min without *inbound* traffic, so a headless batch dies. The realistic floor is Starter at $7/mo, and there is no free background worker.
- **CLI:** has no `rollback` command; rollback goes through the API or dashboard.
- **Other:** MCP server at `mcp.render.com/mcp` (no beta label). `llms.txt` exists, and every docs page has a `.md` version. Workflows (24 h tasks) are **public beta since 2026-04-07**.

**Railway.**
- **Fit:** runs the root Dockerfile as-is. WebSockets have no time limit; SSE is capped at 15 min.
- **Cost:** Hobby is $5/mo and includes $5 of usage, so about $5–10/mo all-in. The Free plan's $1/mo credit cannot keep a 512 MB service always on.
- **Rollback:** dashboard-only; there is no CLI command.
- **Config migration:** `railway.json`/`.toml` are **deprecated and stop being read on 2026-12-01** (replaced by `.railway/railway.ts`).
- **MCP:** remote server at `mcp.railway.com`. The npm `@railway/mcp-server` is **deprecated** (archived 2026-05-23).
- **Trial risk:** an unverified trial account restricts outbound network access, which could block LLM calls.

**Fly.io.**
- **Pricing:** no free tier for new orgs (free plans ended October 2024; the trial is 2 machine-hours or 7 days). An always-on shared-cpu-1x costs $3.69/mo at 512 MB.
- **Auto-stop:** stops a machine with no inbound connections, which would kill a headless batch, so it must be turned off.
- **Rollback:** redeploy an old image; there is no rollback command.
- **MCP:** every `fly mcp` subcommand is **experimental**.
- **React Router:** `fly launch` does not detect React Router and treats the app as plain Node.

**Vercel (filtered).**
- **React Router v8:** the `@vercel/react-router` preset 1.3.7 peers on v7 only; issue vercel#16730, "Support React Router v8", is open.
- **Function duration:** max 300 s on Hobby; 1800 s on Pro is **beta**.
- **Partial options:** WebSockets are **public beta** and capped by function duration. Daemons are **public beta** (since 2026-10-15). Workflows could step-chain a game, but Hobby's 50k events/month covers about 80 games.

**Netlify (filtered).**
- **Duration limits:** functions stop at 60 s and background functions at 15 min, and neither limit can be changed.
- **No WebSockets.** Server-sent events would have to reconnect every 60 s.
- **Credits:** the free 300 credits/month are a hard cap; one 45-min game costs about 7.5 credits and each production deploy costs 15.

### Shortlisted Platforms

#### 1. Cloudflare Workers (Recommended)

It is the only candidate with stateful compute built for game rooms. Each game becomes a Durable Object that owns its SQLite state and spectator WebSockets. A Workflow or alarm chain drives night and day turns, with no wall-clock limit on the total game. It also has the cheapest viable path ($0 to start, $5/mo Paid for headroom) and passes all five agent criteria, including a full-API MCP server. The cost is architectural: the Node scaffold must be migrated, and the game engine must be written as checkpointed, idempotent steps.

#### 2. Render

It is the best container option: zero migration, the Dockerfile works today, WebSockets are unlimited, and the MCP server can read logs and run read-only SQL. It loses because the free tier can't run unattended batches (spin-down on no inbound traffic), so the floor is $7/mo. Every deploy also kills in-flight games after a 30–300 s grace period, which means it needs the same checkpoint-and-resume design anyway.

#### 3. Railway

It is the smoothest PaaS DX at a similar price (~$5–10/mo), with an MCP server and markdown docs. It ranks third because rollback has no CLI path (an agent can't revert unattended), the config format is mid-deprecation, and deploys also kill in-flight games.

## Anti-Bias Cross-Check: Cloudflare Workers

### Devil's Advocate — Weaknesses

1. **The scaffold doesn't run on Workers as-is.** It uses `@react-router/node` + `react-router-serve` + a Dockerfile. The migration needs `@cloudflare/vite-plugin`, a `workers/app.ts` entry, `wrangler.jsonc`, and a new way to read env. Cloudflare's own starter template still pins React Router 7.9.6 and Vite 7, so the v8.4 + Vite 8 combination is less well-trodden.
2. **A game cannot be one long `async` loop.** An idle Durable Object is evicted after 70–140 s, and alarm handlers get at most 15 min and are retried at-least-once. The engine must be step-chained, and every turn must be idempotent. Otherwise a retry pays for the same LLM call twice and breaks the "spend never overshoots by more than one turn" guardrail.
3. **"Free" is narrower than it looks.** The Free plan allows 10 ms of CPU per request (heavy SSR can exceed it) and 50 outbound calls per invocation. Whether the CPU cap applies to Durable Objects on Free is unverified. $5/mo Workers Paid is the realistic budget.
4. **Lock-in.** Durable Objects, alarms, and Workflows are Cloudflare-proprietary. Moving the engine to a Node host later means rewriting orchestration, not just redeploying.
5. **Postgres goes through Hyperdrive.** That means about 20 pooled connections, a 60 s query limit, and TCP drivers (`pg` / `postgres.js`) running under `nodejs_compat`, plus Supabase's own pooler: two pooling layers to debug.

### Pre-Mortem — How This Could Fail

The team migrated the scaffold to Workers and wrote the engine as one `async` loop inside a Durable Object, because it worked in local dev. In production, games silently stopped mid-night: the object was evicted between LLM calls, and nothing scheduled the next step. They moved to alarms, but alarms retry, and the turn handler wasn't idempotent. Some agents spoke twice, a few games double-billed, and the spend cap tripped early on batches. Every deploy restarted the live Durable Objects, which dropped spectator WebSockets and wiped in-memory state, so games running during a deploy were corrupted. A rollback attempt failed because the release had added a Durable Object migration. The Supabase free project had paused after a quiet week, so the first batch after a break couldn't archive anything, breaking "games are never lost". Meanwhile, the Free plan's CPU limit threw sporadic errors on the heavier SSR pages. None of these were platform failures. Each was a Cloudflare execution-model assumption the team never wrote down.

### Unknown Unknowns

- **React Router v8 broke the context pattern Cloudflare documents.** Cloudflare's guide and starter template augment `AppLoadContext` and read `context.cloudflare.env`. In v8, middleware is always on, `context` is always a `RouterContextProvider`, and `AppLoadContext` was removed (v8.0.0 / v8.0.1 changelog). The v8 way is a typed `createContext()` set in `workers/app.ts`, or `import { env } from "cloudflare:workers"`. Also, v8 removed the old `@react-router/dev/vite/cloudflare` dev proxy; use `@cloudflare/vite-plugin` only.
- **`@react-router/cloudflare` 8.4.0 is unnecessary and conflicts.** It peers on `@cloudflare/workers-types@^4`, while `wrangler@4.151` peers on `^5`. Skip it: `createRequestHandler` comes from `react-router`, and `wrangler types` generates `Env`.
- **A deploy resets running Durable Objects.** In-memory state and WebSockets are dropped, so all game state must live in the object's SQLite storage, and spectator clients must reconnect automatically.
- **`wrangler rollback` is blocked across Durable Object migrations.** Adding, renaming, or deleting a Durable Object class is effectively one-way.
- **Billing runs while waiting.** A Durable Object is billed for its full duration while waiting on an outbound LLM fetch (hibernation doesn't happen with pending fetches or timers). It's cheap at this scale, but a parallel batch of 20 games means 20 live objects.
- **SPA mode and prerendering aren't supported** with `@cloudflare/vite-plugin`. Some LLM SDKs assume Node `http` agents; prefer SDKs that use plain `fetch`.

## Operational Story

- **Preview deploys**:
  - `wrangler versions upload` creates a non-production version with its own preview URL (`<version>-<worker>.<subdomain>.workers.dev`). GitHub Actions runs it on every PR and comments the URL.
  - Previews share production Durable Object namespaces unless a separate `env.preview` is defined in `wrangler.jsonc`. Use a separate preview environment with its own Durable Objects and a dev Supabase project.
  - The app's access-key gate protects previews; add Cloudflare Access if a preview ever holds real data.
  - Fork PRs get no preview (no secrets).
- **Secrets**:
  - Runtime secrets live in Workers Secrets, set with `wrangler secret put ACCESS_KEY`, `OPENROUTER_API_KEY` / per-provider LLM keys, and `DATABASE_URL` (or a Hyperdrive binding).
  - `CLOUDFLARE_API_TOKEN` (scoped to Workers edit for this account) and `CLOUDFLARE_ACCOUNT_ID` live in GitHub Actions secrets.
  - Local dev uses `.dev.vars`, which is gitignored.
  - Rotating the access key (FR-001) means `wrangler secret put ACCESS_KEY`. It takes effect on the next request with no redeploy, so the old key dies immediately.
- **Rollback**:
  - `wrangler deployments list`, then `wrangler rollback <version-id>`. It is instant (seconds) and needs no rebuild.
  - Caveats: rollback is blocked if the release added a Durable Object migration. Supabase schema migrations don't roll back. Running games restart from their last SQLite checkpoint.
- **Approval**:
  - **An agent may do unattended:** `wrangler versions upload` (previews), `wrangler tail`, `wrangler deployments list`, read-only Supabase queries, and deploys to a preview environment.
  - **A human approves:** production deploys (merge to `main` triggers auto-deploy per `ci_default_flow`), `wrangler rollback` in production, any Durable Object migration, `wrangler secret put` on production, Supabase schema migrations, deleting archived games, and switching the Workers plan.
- **Logs**:
  - `wrangler tail agent-werewolves --format json --status error` for a live tail.
  - Workers Logs (`observability.enabled: true`) for history in the dashboard and through the Cloudflare MCP server (`mcp.cloudflare.com/mcp`).
  - `gh run view --log` for CI.
  - Game-level events (turns, spend, aborts) are also written to the archive, so an agent can query them via SQL.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Game loop evicted mid-game (written as one `async` loop) | Devil's advocate | H | H | Design the engine as one step per turn from day one: a Workflow step or DO alarm per turn, with game state in DO SQLite. Add an integration test that simulates eviction between turns. |
| Alarm/Workflow retry double-calls an LLM and overspends | Pre-mortem | M | H | Give each turn an idempotency key (`gameId:round:phase:seat`). Persist "LLM call started/finished" plus cost in DO storage before acting. Check the spend limit before every call. |
| Deploy resets live DOs, dropping WebSockets and in-memory state | Unknown unknowns | H | M | Keep no game state only in memory. Spectator client auto-reconnects and replays from the last event seq. Deploy between batches when possible. |
| `wrangler rollback` blocked by a DO migration | Unknown unknowns | M | M | Keep DO classes stable: one `GameRoom` class, with schema changes inside its SQLite (versioned migrations in code), not class renames. Ship DO migrations in their own release. |
| React Router v8 context mismatch with Cloudflare docs/template (v7 `AppLoadContext`) | Unknown unknowns / Research finding | H | L | Use the v8 `RouterContextProvider` + `createContext()` pattern (see Getting Started). Don't copy `workers/app.ts` from the Cloudflare starter verbatim. |
| Free plan's 10 ms CPU limit / 50 subrequests trip on SSR or long turns | Devil's advocate | M | M | Start on Free for wiring. Move to Workers Paid ($5/mo) before the first real batch. Watch `exceededCpu` in `wrangler tail`. |
| Supabase free project pauses after inactivity, so archive writes fail | Pre-mortem | M | H | Verify current Supabase free-tier pause rules. Buffer finished games in DO SQLite until archived (outbox pattern) so "games are never lost" holds even if Postgres is down. Add a weekly cron Worker ping, or use D1 as a fallback. |
| Hyperdrive + Supabase pooler connection issues | Devil's advocate | M | M | Connect Hyperdrive to Supabase's direct/session connection string, not the transaction pooler. Use `postgres.js` with `prepare: false` if pooled. Keep archive writes batched per game. |
| Cloudflare lock-in (DO/Workflows) makes a later move expensive | Devil's advocate | L | M | Keep game rules and agent prompting in a pure TS `engine/` module with no Cloudflare imports. Only a thin `workers/` adapter touches DOs, alarms, and Workflows. |
| LLM SDK depends on Node APIs unsupported by workerd | Unknown unknowns | M | L | Prefer fetch-based clients (OpenRouter / provider REST, Vercel AI SDK core). Smoke-test each provider call in `npm run dev` (runs in workerd). |
| Workflows Free limits (3,000 steps/day, 1,024 steps per workflow) cap batch size | Research finding | M | M | One step per turn (not per LLM call) keeps a 9-player game well under 1,024 steps. Batches of 20 may exceed 3,000 steps/day on Free, which is another reason for Paid before batches. |
| Cloudflare MCP servers (bindings/observability/builds) deprecated | Research finding | L | L | Use only `mcp.cloudflare.com/mcp` and `docs.mcp.cloudflare.com/mcp`. |

## Getting Started

Checked against the pinned versions on 2026-10-18: `react-router@8.4.0`, `@react-router/dev@8.4.0`, `vite@^8.0.3`, `@cloudflare/vite-plugin@1.64.0` (peers `vite ^6||^7||^8`, `wrangler ^4.151.0`), and `wrangler@4.151.1`. The React Router dev server already runs in workerd through the Cloudflare Vite plugin, so keep `npm run dev`; a separate `wrangler dev` is unnecessary.

1. **Swap the Node runtime for the Workers toolchain.**
   ```bash
   npm uninstall @react-router/node @react-router/serve
   npm i -D @cloudflare/vite-plugin wrangler
   npx wrangler login
   ```
   Do **not** install `@react-router/cloudflare`; its peer on `@cloudflare/workers-types@^4` conflicts with wrangler 4.151. Delete `Dockerfile` and `.dockerignore` (no longer used).

2. **Wire Vite and the Worker entry (v8 pattern, not the v7 template).**
   - **`vite.config.ts`:** add `cloudflare({ viteEnvironment: { name: "ssr" } })` as the first plugin, before `tailwindcss()` and `reactRouter()`. Leave `react-router.config.ts` as `ssr: true`; no `future` flags are needed in v8.
   - **`wrangler.jsonc`:**
     ```jsonc
     {
       "name": "agent-werewolves",
       "main": "./workers/app.ts",
       "compatibility_date": "2026-10-18",
       "compatibility_flags": ["nodejs_compat"],
       "observability": { "enabled": true }
     }
     ```
   - **`workers/app.ts`:**
     ```ts
     import { createContext, createRequestHandler, RouterContextProvider } from "react-router";

     export const cloudflareContext = createContext<{ env: Env; ctx: ExecutionContext }>();

     const handler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);

     export default {
       fetch(request, env, ctx) {
         const context = new RouterContextProvider();
         context.set(cloudflareContext, { env, ctx });
         return handler(request, context);
       },
     } satisfies ExportedHandler<Env>;
     ```
     Loaders then read `context.get(cloudflareContext).env`.

3. **Generate types and update scripts.** Add `"cf-typegen": "wrangler types && react-router typegen"`, `"deploy": "react-router build && wrangler deploy"`, and `"preview": "react-router build && vite preview"`. Remove `"start"`. Run `npm run cf-typegen` so `Env` exists, then `npm run typecheck`.

4. **Deploy the skeleton and set the first secret.**
   ```bash
   npm run deploy
   npx wrangler secret put ACCESS_KEY
   npx wrangler tail agent-werewolves
   ```
   Confirm the `*.workers.dev` URL serves the welcome page.

5. **Add the game-room primitives before writing game logic.**
   - Export a `GameRoom` Durable Object (SQLite-backed) from `workers/app.ts`, with a `durable_objects.bindings` entry and a `migrations: [{ tag: "v1", new_sqlite_classes: ["GameRoom"] }]` block in `wrangler.jsonc`.
   - Prove three things with a dummy 3-turn "game" in which each turn makes one LLM call: alarm-chained turns, WebSocket Hibernation broadcast, and resume-after-deploy.
   - Only then build the real engine.

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration
- CI/CD pipeline setup (the GitHub Actions auto-deploy-on-merge workflow is a separate change)
- Production-scale architecture (multi-region, HA, DR)
- Choice of LLM gateway/provider and Supabase plan specifics
