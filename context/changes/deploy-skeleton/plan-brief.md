# Deploy Skeleton on Cloudflare Workers — Plan Brief

> Full plan: `context/changes/deploy-skeleton/plan.md`
> Research: `context/foundation/infrastructure.md` (platform decision; serves as this change's research)

## What & Why

This change moves the scaffolded React Router v8 app from the Node template onto Cloudflare Workers, and deploys it automatically on every merge to `main`. It is roadmap foundation F-01: until it lands, every later slice would be written against the wrong runtime. It also gives every slice after it a live URL to verify against.

## Starting Point

The repo is the stock `create-react-router` v8.4 Node template: a Node server, a Dockerfile, and a template welcome page. There is no Cloudflare config, no CI workflow, and no repo secrets. The user has a Cloudflare account, but wrangler isn't installed or logged in on this machine.

## Desired End State

- `npm run dev` runs the app inside the Workers runtime.
- Production lives at `https://agent-werewolves.<subdomain>.workers.dev`, with a placeholder page at `/`, and `/healthz` reports the environment and the live version ID.
- Pull requests are checked; merges to `main` deploy and smoke-test automatically.
- A failed deploy goes red and tells a human how to roll back.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Platform | Cloudflare Workers | Cheapest viable host for long-lived game rooms; scored 10/10 | Research |
| Request context | v8 `RouterContextProvider` + `createContext`, not Cloudflare's v7 template | React Router v8 removed `AppLoadContext` | Research |
| Extra packages | Only `@cloudflare/vite-plugin` + `wrangler`; no `@react-router/cloudflare` | Avoids a `workers-types` v4/v5 peer conflict | Research |
| Deploy pipeline | GitHub Actions; typecheck + build gate before `wrangler deploy` | Matches tech-stack.md; a red check blocks a bad deploy | Plan |
| PR previews | Not in this change | No access-key gate yet, so previews would be public | Plan |
| Deployed content | Placeholder page + `/healthz` returning environment + version ID | Proves SSR, assets, and env access through the v8 context in one curl | Plan |
| Smoke failure | Run fails red and prints rollback steps; no auto-rollback | Production rollback needs a human (infrastructure.md) | Plan |
| Generated types | `wrangler types` runs inside `typecheck`; output gitignored | CI never depends on a stale committed file | Plan |

## Scope

**In scope:**
- Swap the toolchain, add the Vite plugin, `wrangler.jsonc`, the Worker entry, and generated types
- Replace the welcome page with a placeholder, and add `/healthz`
- First manual deploy, plus the CI secrets and variable
- GitHub Actions check/deploy/smoke workflow
- README rewrite and removal of the Docker files

**Out of scope:** access-key gate (S-01), Durable Objects and Workflows (F-02), database, PR previews, custom domain, auto-rollback, test framework.

## Architecture / Approach

The browser calls the Worker's `fetch(request, env, ctx)` (`workers/app.ts`). For each request the Worker builds a new `RouterContextProvider`, sets the typed `cloudflareContext` with `{ env, ctx }`, and hands the request to the React Router handler. Loaders such as `/healthz` read bindings with `context.get(cloudflareContext)`. In CI, `check` runs on every PR and push. On a push to `main`, `deploy` builds, runs `wrangler deploy`, curls `$PROD_URL/healthz`, and on failure prints the rollback commands.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Workers runtime, local | App builds, typechecks, and runs in workerd | v8 vs. Cloudflare-docs drift; virtual module types |
| 2. Placeholder + `/healthz` | Recognisable page; health JSON through the v8 context | Context module import cycle if placed in the Worker entry |
| 3. First deploy + account wiring | Live workers.dev URL; CI secrets/variable set | Dashboard and login steps only the human can do (WSL browser login) |
| 4. CI deploy on merge | Merge-to-main deploy with smoke check; ops README | Missing `CLOUDFLARE_ACCOUNT_ID` or deploying without building first |

**Prerequisites:** Cloudflare account with a workers.dev subdomain; GitHub repo admin access for secrets.
**Estimated effort:** about 1–2 sessions across 4 phases; Phase 3 needs about 10 minutes of the human's time in the dashboard.

## Open Risks & Assumptions

- Assumes `tsc` can resolve `virtual:react-router/server-build`; if not, a small ambient declaration is added.
- The workers.dev URL is public and ungated until S-01. Acceptable because nothing here spends money or exposes data.
- Node 22 in CI matches local v22.22.3; React Router v8 requires ≥ 22.22.0.

## Success Criteria (Summary)

- Merging a PR to `main` deploys automatically, and `gh run watch` shows `check` + `deploy` green.
- `curl $PROD_URL/healthz` returns `status: ok`, `environment: production`, and the newest version ID.
- `wrangler tail` shows live requests, and a human can roll back and forward with two commands.
