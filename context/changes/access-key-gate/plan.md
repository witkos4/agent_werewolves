# Access Key Gate Implementation Plan

## Overview

Put the whole hosted app behind one rotatable access key (roadmap **S-01**, PRD **FR-001**). Browsers enter the key once on `/login` and get a 30-day session cookie. Scripts send `Authorization: Bearer <key>`. Rotating the key with `wrangler secret put ACCESS_KEY` kills every existing cookie and bearer credential on the next request. The temporary `SPIKE_KEY` guard from F-02 is retired, so one key unlocks everything. This must land before S-02, because the first real game spends LLM budget from a public URL.

## Current State Analysis

- `workers/app.ts:14-21` is the single entry: it runs `handleSpikeRequest` (spike API and viewer WebSocket), then hands everything else to React Router. Nothing is gated except two spike routes.
- `workers/spike/routes.ts:18-21,37-38` guards `POST /api/spike/start` and `GET /api/spike/:id/turns` with `x-spike-key`, via a constant-time SHA-256 digest compare (`routes.ts:70-80`). It returns 404 when the key is wrong or `SPIKE_KEY` is unset. The viewer socket (`routes.ts:24-32`) and the viewer page `/spike/:gameId` are unauthenticated on purpose.
- `app/routes.ts` has three routes: `/` (placeholder), `/healthz` (status + version metadata), `/spike/:gameId` (viewer).
- `wrangler.jsonc:18-20` lists `OPENROUTER_API_KEY` and `SPIKE_KEY` under `secrets.required`, so a real deploy fails until both exist in production. `vitest.config.ts:13-16` injects test values for both.
- `test/worker.ts` is a slim test entry: the real `workers/app.ts` imports the React Router build, which only the Vite plugin resolves. Tests call handlers directly (`test/routes.test.ts`).
- CI (`.github/workflows/ci.yml:44-56`) smoke-tests `GET /healthz` on production after every deploy, with no credentials.
- F-02 drills (`context/archive/2026-10-19-game-room-turn-loop-spike/spike-findings.md:18-21`) hit a dev/prod `SPIKE_KEY` mismatch and a secret with a pasted trailing newline.

## Desired End State

- Without a valid credential, every request except `/login`, `/healthz` and static assets is refused. Page loads (`GET`/`HEAD` documents) redirect to `/login?next=<path>`. Everything else (`/api/*`, WebSocket upgrades, `*.data`, `/__manifest`, non-GET methods) gets a bare 404.
- `/login` accepts the key, sets the session cookie and redirects to a sanitized `next` (default `/`). A wrong key re-renders the form with an error and status 401.
- `Authorization: Bearer <key>` works on any gated path (curl drills, future batch scripts).
- After `wrangler secret put ACCESS_KEY`, old cookies redirect to `/login`, old bearer keys get 404, and open viewer sockets drop with the deploy and fail the gate on reconnect.
- When `ACCESS_KEY` is unset or shorter than 32 characters after trimming, the app fails closed: everything gated is refused, `/login` says the gate is misconfigured, and a log line names the cause.
- `SPIKE_KEY` is gone from code, config, tests, docs and production secrets.

Verify with `npm test`, `npm run typecheck`, `npm run build`, and the production drills in Phase 3.

### Key Discoveries:

- One choke point covers every surface: `workers/app.ts:14`, before both `handleSpikeRequest` and `requestHandler`. React Router middleware would miss the spike API and the WebSocket upgrade.
- Static assets are served by Workers assets before the Worker runs (Cloudflare Vite plugin default), so the built JS/CSS and favicon stay public without an allowlist entry.
- Browsers send cookies on a same-origin WebSocket handshake, so gating `/api/spike/:id/ws` needs no client change in `app/routes/spike.$gameId.tsx`.
- `wrangler secret put` creates and deploys a new Worker version, and a deploy disconnects Durable Object WebSockets. That is what makes "cut at next reconnect" work for open viewers (Phase 3 drill confirms it).
- Precedent for workers → app imports: `workers/app.ts:3` imports `../app/cloudflare-context`.
- The constant-time compare in `workers/spike/routes.ts:70-80` is the pattern to reuse for the bearer and form key checks.

## What We're NOT Doing

- No accounts, no multiple keys, no grace period where old and new keys both work (PRD: one key, the old key stops working immediately).
- No in-app key rotation. Rotation is `wrangler secret put ACCESS_KEY` only (infrastructure.md:133).
- No force-closing of open WebSockets at rotation time. A socket opened before rotation lives until the rotation deploy drops it. If a platform change ever stops deploys from dropping sockets, it would live until it closes.
- No login rate limiting. A random key of at least 32 characters makes online guessing hopeless.
- No logout button. Clearing the cookie logs out one browser; rotation logs out all.
- No sliding session renewal; the 30-day expiry is fixed at login.
- No graceful handling of session expiry mid-navigation: an expired session on a client-side `.data` fetch gets a 404 (error boundary). A reload lands on `/login`.
- No changes to the spike viewer's reconnect loop. After rotation it shows "reconnecting" indefinitely. Throwaway code; S-02 owns the real viewer.
- No PR preview environments, and no Cloudflare Access.
- `/healthz` is not gated and keeps exposing status, environment and version id.

## Implementation Approach

A pure access module (`app/access.server.ts`) owns the key compare and session signing using WebCrypto only. A thin worker-level gate (`workers/gate.ts`) classifies the request and either returns `null` (let it through) or the refusal response. Both worker entries call the gate first. The login route reuses the access module to check the key and issue the cookie. The session cookie is a stateless HMAC keyed by `ACCESS_KEY`, so rotation needs no storage and no revocation list: a new key simply fails every old signature.

## Critical Implementation Details

**Timing & lifecycle:** `ACCESS_KEY` joins `secrets.required`, so a deploy of this change fails until the production secret exists. Set it *before* merging. Running `wrangler secret put` on the old code is harmless, because the old code ignores the value. Delete `SPIKE_KEY` only after the new version is live and drilled.

**Open redirect:** `next` must be a same-origin path. Accept it only if it starts with `/` and not `//` or `/\`. Otherwise fall back to `/`. Don't redirect back to `/login` itself.

**Key normalization:** trim both the configured `ACCESS_KEY` and the submitted key (form field or bearer token) before comparing and before HMAC keying. This defends against the pasted-newline failure seen in F-02. Apply the 32-character minimum to the trimmed configured key.

## Phase 1: Access Core and Gate

### Overview

Everything except `/login`, `/healthz` and assets is refused unless the request carries a valid session cookie or bearer key. Spike routes no longer check `SPIKE_KEY`. Browsers can't log in yet, because the `/login` route lands in Phase 2. Bearer access works end to end.

### Changes Required:

#### 1. Access module

**File**: `app/access.server.ts` (new)

**Intent**: Single home for the credential rules: the configured-key check, constant-time key compare, and session cookie issue/verify. It is pure WebCrypto, so it can be shared by the worker gate and the login route.

**Contract**:
- `configuredKey(env): string | null`: trimmed `env.ACCESS_KEY`, or `null` if unset or shorter than `MIN_KEY_LENGTH = 32`.
- `keyMatches(given: string, expected: string): Promise<boolean>`: trims `given` and compares fixed-length SHA-256 digests in constant time. Move the logic from `workers/spike/routes.ts:70-80`.
- `issueSession(key, now): Promise<string>`: the cookie value `<expSeconds>.<base64url(HMAC-SHA256(key, "session:v1:" + exp))>`, with `exp = now + 30 days`.
- `verifySession(value, key, now): Promise<boolean>`: parses the value, rejects a malformed value or `exp <= now`, and checks the HMAC with `crypto.subtle.verify` (constant time).
- `sessionCookie(value, { secure }): string` and `readSessionCookie(request): string | null`, with cookie name `aw_session` and attributes `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`, plus `Secure` when `secure`.
- `isAuthenticated(request, env, now): Promise<boolean>`: true if a valid `aw_session` cookie or `Authorization: Bearer <key>` matches. Always false when `configuredKey` is null.

#### 2. Gate

**File**: `workers/gate.ts` (new)

**Intent**: Decide, before any routing, whether a request may proceed, and shape the refusal so pages are friendly and everything else reveals nothing.

**Contract**: `gate(request: Request, env: Env): Promise<Response | null>`. `null` means pass.
- Public: `/login` (any method), `/healthz`.
- Authenticated (`isAuthenticated`): pass.
- Otherwise, a page request (`GET`/`HEAD`, no `Upgrade: websocket`, path not under `/api/`, not ending in `.data`, not `/__manifest`) gets a `302` to `/login?next=<encodeURIComponent(path + search)>`. Anything else gets `404 Not found`, with the same body as the spike's `notFound()`.
- When `configuredKey(env)` is null, log one structured `console.error` line (`{ event: "access_gate_misconfigured", reason: "unset" | "too_short" }`) and refuse as above.

#### 3. Wire the gate into both entries

**File**: `workers/app.ts`, `test/worker.ts`

**Intent**: Run the gate first in production and in the test entry, so tests exercise the real ordering.

**Contract**: `fetch` calls `const refused = await gate(request, env); if (refused) return refused;` before `handleSpikeRequest`. In `test/worker.ts`, paths the gate passes and the spike doesn't handle return `404` as today, and `/login` and `/healthz` just 404 there (React Router isn't in the test entry).

#### 4. Retire SPIKE_KEY from spike routes

**File**: `workers/spike/routes.ts`

**Intent**: The gate now protects every spike route, so drop the per-route key checks and the local `sha256`/`hasSpikeKey` helpers.

**Contract**: The header comment changes to say the access-key gate in `workers/gate.ts` runs before these routes. The viewer-socket comment (`routes.ts:22-23`) changes from "unauthenticated on purpose" to "gated like everything else; cookies ride the handshake". Route behaviour is otherwise unchanged: UUID checks, 404s for unknown games and methods.

#### 5. Config and secrets

**File**: `wrangler.jsonc`, `vitest.config.ts`

**Intent**: Require `ACCESS_KEY` instead of `SPIKE_KEY` and give tests a valid key.

**Contract**: `secrets.required: ["OPENROUTER_API_KEY", "ACCESS_KEY"]`. Miniflare bindings replace `SPIKE_KEY` with a fixed `ACCESS_KEY` of at least 32 characters. Rerun `npm run cf-typegen` so `Env.ACCESS_KEY` exists and `Env.SPIKE_KEY` is gone. The local `.dev.vars` (gitignored) gains `ACCESS_KEY`. The implementer adds it locally and doesn't commit it.

#### 6. Tests

**File**: `test/access.test.ts` (new), `test/gate.test.ts` (new), `test/routes.test.ts`

**Intent**: Prove the credential rules and the gate's refusal shapes. Spike route tests stop testing keys.

**Contract**:
- `access.test.ts`: `keyMatches` true for equal keys and for trailing whitespace/newline, false for a different key or empty input. Session round-trip verifies. A tampered signature, tampered `exp`, malformed value, expired `exp`, and a session signed with a *different* key (rotation) all fail. `configuredKey` returns null for unset, empty, and 31-character keys and returns the trimmed key for a padded 32-character key.
- `gate.test.ts` (via `SELF.fetch` against `test/worker.ts`, or `gate()` directly): with no credential, `GET /` and `GET /spike/<uuid>` give 302 with `Location: /login?next=%2F...` (query preserved). `POST /api/spike/start`, `GET /api/spike/<uuid>/turns`, a WebSocket upgrade to `/api/spike/<uuid>/ws`, `GET /foo.data` and `GET /__manifest` give 404. `/login` and `/healthz` pass. A valid bearer passes on `/api/spike/start`. A valid cookie passes, including on a WebSocket upgrade. A cookie signed with an old key is refused (rotation). With `ACCESS_KEY` unset or 31 characters, even a matching bearer is refused.
- `routes.test.ts`: drop the `x-spike-key` header helper and the three key tests (`returns 404 on start with a %s key`, `returns 404 when SPIKE_KEY is unset`, the unkeyed half of `returns the journal only with the key`). Keep the behaviour tests, calling `handleSpikeRequest` directly.

### Success Criteria:

#### Automated Verification:

- Types regenerate and check: `npm run typecheck`
- All tests pass, including new access and gate tests: `npm test`
- Build succeeds: `npm run build`
- No `SPIKE_KEY` / `x-spike-key` left in code or config: `grep -rn "SPIKE_KEY\|x-spike-key" app workers test wrangler.jsonc vitest.config.ts` returns nothing

#### Manual Verification:

- In `npm run dev` with `ACCESS_KEY` in `.dev.vars`: `curl -i localhost:5173/` gives 302 to `/login?next=%2F`, `curl -i -X POST localhost:5173/api/spike/start` gives 404, and the same with `-H "Authorization: Bearer $ACCESS_KEY"` gives 200
- With `ACCESS_KEY` removed from `.dev.vars`, the bearer request gets 404 and the dev log shows `access_gate_misconfigured`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Login Page

### Overview

A browser can sign in by entering the key on `/login` and lands back where it was headed.

### Changes Required:

#### 1. Login route

**File**: `app/routes/login.tsx` (new), `app/routes.ts`

**Intent**: Collect the key, issue the session, and send the operator on to `next`, matching the look of `app/routes/home.tsx`.

**Contract**:
- Register `route("login", "routes/login.tsx")`.
- `loader`: if the request is already authenticated, redirect to the sanitized `next`. If `configuredKey(env)` is null, return `{ misconfigured: true }`.
- `action`: read the `key` form field. If misconfigured, return 503 with the misconfigured message. If `keyMatches`, `redirect(next, { headers: { "Set-Cookie": sessionCookie(await issueSession(key, Date.now()), { secure: url.protocol === "https:" }) } })`. Otherwise return `data({ error: "Wrong access key." }, { status: 401 })`.
- Component: `<Form method="post" reloadDocument>` (a document POST, so no `/login.data` or `/__manifest` request needs to pass the gate) with a hidden `next`, a password input `key` (`autoComplete="current-password"`, `autoFocus`), a submit button, and the error or misconfigured message. `meta` title "Sign in · Agent Werewolves".
- `sanitizeNext(raw): string` lives in `app/access.server.ts`. It accepts paths starting with `/` but not `//`, `/\` or `/login`, and otherwise returns `/`.

#### 2. Tests

**File**: `test/login.test.ts` (new)

**Intent**: Prove the route's server behaviour without the React Router build, by calling `loader`/`action` directly with a `RouterContextProvider` holding `cloudflareContext`.

**Contract**: The right key gives 302 to `next` with a `Set-Cookie` that `verifySession` accepts, with `Secure` present for an https URL and absent for http. A key with a trailing newline also succeeds. A wrong key gives 401 and no `Set-Cookie`. When misconfigured, the action gives 503. `sanitizeNext` maps `"/spike/x?a=1"` to itself and `"//evil.test"`, `"https://evil.test"`, `"/\\evil"`, `"/login"` and `""` to `/`. The loader with a valid cookie redirects to `next`.

### Success Criteria:

#### Automated Verification:

- Types check (route types regenerate): `npm run typecheck`
- All tests pass, including login tests: `npm test`
- Build succeeds: `npm run build`

#### Manual Verification:

- In `npm run dev`: opening `/spike/<any-uuid>` redirects to `/login`, a wrong key shows the error, and the right key lands on `/spike/<uuid>` with the viewer connecting (badge leaves "connecting")
- DevTools shows `aw_session` as HttpOnly, SameSite=Lax, with ~30-day expiry
- Visiting `/login` while signed in redirects to `/`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 3: Docs and Production Rollout

### Overview

The operator knows how to generate, set and rotate the key. Production runs behind the gate, rotation is proven by drills, and `SPIKE_KEY` is gone from production.

### Changes Required:

#### 1. Docs

**File**: `README.md`, `context/foundation/infrastructure.md`

**Intent**: Replace every `SPIKE_KEY` mention with `ACCESS_KEY` and add a short "Access key" runbook.

**Contract**:
- The README `.dev.vars` table gets `ACCESS_KEY` (≥ 32 chars, e.g. `openssl rand -base64 32`). The "Runtime secrets" bullet names `ACCESS_KEY`.
- New "Access key" section covering: sign in at `/login`; for scripts, `curl -H "Authorization: Bearer $ACCESS_KEY"`; rotate with `openssl rand -base64 32 | tr -d '\n' | npx wrangler secret put ACCESS_KEY` (this deploys a new version, so old cookies, bearer keys and open viewer sockets stop working within seconds, and production rotation needs human approval); the app is fully locked when the key is unset or under 32 chars.
- In `infrastructure.md`, change line 133 to "deploys a new version" instead of "no redeploy", since `secret put` does deploy.

#### 2. Production rollout (human-approved steps)

**File**: none (operations)

**Intent**: Ship without a failed deploy, then prove FR-001 on the real URL.

**Contract**, in order:
1. Set the production `ACCESS_KEY` before merging (piped, no trailing newline), and confirm with `npx wrangler secret list`.
2. Merge the PR. CI deploys and the `/healthz` smoke test passes unauthenticated.
3. Run the drills (below).
4. `npx wrangler secret delete SPIKE_KEY`, then `npx wrangler secret list` shows only `ACCESS_KEY` and `OPENROUTER_API_KEY`.
5. Update local `.dev.vars` to drop `SPIKE_KEY`.

### Success Criteria:

#### Automated Verification:

- CI `main` run passes end to end, including the unauthenticated `/healthz` smoke test: `gh run list --branch main --limit 1`
- Production refuses anonymous spend: `curl -s -o /dev/null -w '%{http_code}' -X POST https://agent-werewolves.witkos4.workers.dev/api/spike/start` prints `404`
- Production redirects anonymous pages: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' https://agent-werewolves.witkos4.workers.dev/` prints `302 …/login?next=%2F`
- Production secrets are exactly the two expected: `npx wrangler secret list`

#### Manual Verification:

- Sign in on production in a browser; `/` and a spike viewer load
- Rotation drill: start a spike game with the bearer key and keep its viewer open, then rotate `ACCESS_KEY`. Within seconds the viewer drops to "reconnecting" and stays there. Reloading any page redirects to `/login`. The old bearer key gets 404. The new key signs in and works as bearer
- Misconfiguration is visible: `wrangler tail` shows no `access_gate_misconfigured` lines in normal operation

**Implementation Note**: Production secret changes and the merge need human approval (infrastructure.md "Approval"). Pause before each.

---

## Testing Strategy

### Unit Tests:

- Session sign/verify: round-trip, tampering, expiry boundary (`exp == now` is expired), wrong-key (rotation)
- Key compare: equal, whitespace-padded, different, empty
- Configured key: unset, empty, 31 chars, padded 32 chars
- `sanitizeNext`: same-origin paths kept, protocol-relative, absolute, backslash and `/login` rejected

### Integration Tests:

- Gate refusal shapes for each surface: document, API, WebSocket upgrade, `.data`, `/__manifest`
- Gate pass-through for `/login`, `/healthz`, valid cookie, valid bearer, including on a WebSocket upgrade
- Fail-closed when misconfigured, even with a matching bearer
- Spike routes behave as before once past the gate

### Manual Testing Steps:

1. Dev: anonymous `/` → `/login`; wrong key → error; right key → back to `next`
2. Dev: bearer curl starts a spike game; no-credential curl gets 404
3. Prod: rotation drill with an open viewer (Phase 3)

## Performance Considerations

Each gated request costs at most one HMAC verify or two SHA-256 digests. That's negligible next to SSR, and well within the Free plan's 10 ms CPU budget.

## Migration Notes

There's no data migration, and no Durable Object migration, so `wrangler rollback` stays available. Rolling back to the pre-gate version re-requires `SPIKE_KEY`, so delete it only after the drills pass. If a rollback is needed after deletion, re-set `SPIKE_KEY` first.

## References

- Roadmap item: `context/foundation/roadmap.md` (S-01)
- PRD: `context/foundation/prd.md:103` (FR-001)
- Secrets and approval rules: `context/foundation/infrastructure.md:130-133`
- Constant-time compare to reuse: `workers/spike/routes.ts:70-80`
- F-02 secret pitfalls: `context/archive/2026-10-19-game-room-turn-loop-spike/spike-findings.md:18-21`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Access Core and Gate

#### Automated

- [x] 1.1 Types regenerate and check: `npm run typecheck` — 241e777
- [x] 1.2 All tests pass, including new access and gate tests: `npm test` — 241e777
- [x] 1.3 Build succeeds: `npm run build` — 241e777
- [x] 1.4 No `SPIKE_KEY` / `x-spike-key` left in code or config — 241e777

#### Manual

- [x] 1.5 Dev curls: anonymous page 302, anonymous API 404, bearer API 200 — 241e777
- [x] 1.6 Dev fail-closed with `ACCESS_KEY` removed, log line visible — 241e777

### Phase 2: Login Page

#### Automated

- [x] 2.1 Types check (route types regenerate): `npm run typecheck` — 35b18ac
- [x] 2.2 All tests pass, including login tests: `npm test` — 35b18ac
- [x] 2.3 Build succeeds: `npm run build` — 35b18ac

#### Manual

- [x] 2.4 Dev sign-in flow: redirect, wrong-key error, right key lands on `next` with viewer connecting — 35b18ac
- [x] 2.5 `aw_session` cookie attributes correct in DevTools — 35b18ac
- [x] 2.6 `/login` while signed in redirects to `/` — 35b18ac

### Phase 3: Docs and Production Rollout

#### Automated

- [x] 3.1 CI `main` run passes end to end, including unauthenticated `/healthz` smoke test
- [x] 3.2 Production refuses anonymous spend (404)
- [x] 3.3 Production redirects anonymous pages (302 to `/login`)
- [x] 3.4 Production secrets are exactly `ACCESS_KEY` and `OPENROUTER_API_KEY`

#### Manual

- [x] 3.5 Browser sign-in on production
- [ ] 3.6 Rotation drill: open viewer drops, pages redirect, old bearer 404, new key works
- [x] 3.7 No `access_gate_misconfigured` lines in normal operation
