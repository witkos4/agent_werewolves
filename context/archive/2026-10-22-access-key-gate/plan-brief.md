# Access Key Gate — Plan Brief

> Full plan: `context/changes/access-key-gate/plan.md`

## What & Why

Put the whole hosted app behind one access key that the operator can rotate, so the old key stops working right away (FR-001, roadmap S-01). It has to land before S-02, because the first real game spends LLM budget from a public URL. It also retires the temporary `SPIKE_KEY` guard, so one key unlocks everything.

## Starting Point

Only two spike routes are guarded, by `x-spike-key`. The home page, the spike viewer page and the viewer WebSocket are open to anyone. `workers/app.ts` is the single entry: it runs spike routing first, then React Router.

## Desired End State

Anonymous visitors only reach `/login`, `/healthz` and static assets. Pages redirect to `/login`, and everything else gets a bare 404. The operator signs in once per 30 days, and scripts use `Authorization: Bearer <key>`. Running `wrangler secret put ACCESS_KEY` kills all old cookies, bearer keys and open viewer sockets within seconds. A missing or short key locks the app instead of opening it.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) |
| --- | --- | --- |
| Gate location | Worker-level `gate()` before spike routing and React Router | It's the only choke point that covers SSR, `.data`, the spike API and WebSocket upgrades |
| Browser credential | Stateless cookie `<exp>.<HMAC(ACCESS_KEY, exp)>`, 30 days, HttpOnly, SameSite=Lax | Rotation invalidates it with no storage or revocation list |
| Script credential | `Authorization: Bearer <key>` alongside the cookie | Keeps the F-02 curl and agent workflow on one key |
| Open sockets at rotation | Cut at next reconnect | `secret put` deploys a new version, which drops DO sockets, and the reconnect fails the gate |
| Spike routes | Keep them, re-gated; drop `SPIKE_KEY` everywhere | One key and one guard, and S-02 keeps a working harness |
| Locked-out response | Pages get a 302 to `/login?next=`, everything else a bare 404 | Friendly for the operator, uninformative for scanners |
| Public paths | `/login`, `/healthz`, static assets | CI smoke test keeps working with no new GitHub secret |
| Hardening | Fail closed on an unset or <32-char key; trim keys; no rate limit | A long random key makes guessing hopeless, and misconfig can't open the app |
| Login form | Document POST (`reloadDocument`) with a sanitized same-origin `next` | No `.data` or manifest holes in the gate, and no open redirect |

## Scope

**In scope:**
- `app/access.server.ts` (key compare, session sign/verify, `sanitizeNext`) and `workers/gate.ts`
- Gate wired into `workers/app.ts` and `test/worker.ts`; `SPIKE_KEY` removed from spike routes, config and tests
- `/login` route with loader and action
- README runbook for generating and rotating the key; production rollout and rotation drill

**Out of scope:**
- In-app rotation, multiple keys, grace periods, accounts
- Force-closing sockets on rotation, login rate limiting, logout button, sliding sessions
- Fixing the spike viewer's endless "reconnecting" after rotation (S-02 owns the real viewer)
- PR previews, Cloudflare Access, gating `/healthz`

## Architecture / Approach

Each request first goes to `gate(request, env)`. Public paths pass. Next it checks for a valid `aw_session` cookie (HMAC verify) or a bearer key (constant-time digest compare); either one passes. Otherwise the gate answers 302 for pages or 404 for everything else. Requests that pass continue to spike routing or React Router as today. The `/login` action checks the key, signs a session with `ACCESS_KEY` as the HMAC key, and redirects. Rotating the key changes the HMAC key, so every earlier session fails verification.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Access core and gate | Everything gated; bearer works; `SPIKE_KEY` retired in code | Request classification misses a surface (e.g. `.data`, WS) |
| 2. Login page | Browser sign-in with a 30-day cookie and a safe `next` redirect | Open redirect or cookie attributes wrong in dev vs prod |
| 3. Docs and production rollout | Runbook; prod behind the gate; rotation drilled; `SPIKE_KEY` deleted | Merging before the prod `ACCESS_KEY` exists fails the deploy |

**Prerequisites:** F-01 done. Human approval for the production `ACCESS_KEY` secret, the merge, and deleting `SPIKE_KEY`.
**Estimated effort:** ~1–2 sessions across 3 phases.

## Open Risks & Assumptions

- Assumes deploys keep dropping Durable Object WebSockets, which is what makes "cut at next reconnect" hold. The Phase 3 rotation drill verifies it.
- Assumes static assets are served before the Worker runs (Cloudflare Vite plugin default). If they aren't, the gate would redirect asset requests, and the login page would render unstyled in dev.
- An expired session during client-side navigation shows a 404 error boundary until reload. This is accepted.

## Success Criteria (Summary)

- An anonymous visitor to the production URL can't start a game, read a journal, open a viewer socket or see any page except `/login`.
- The operator signs in once and works normally. Scripts work with the bearer key.
- After a rotation, the old key, the old cookies and open viewers stop working within seconds, and the new key works.
