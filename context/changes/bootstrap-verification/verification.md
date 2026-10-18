---
bootstrapped_at: 2026-10-18T12:05:22Z
starter_id: react-router
starter_name: "React Router (formerly Remix)"
project_name: agent-werewolves
language_family: js
package_manager: npm
cwd_strategy: subdir-then-move
bootstrapper_confidence: verified
phase_3_status: ok
audit_command: "npm audit --json"
---

## Hand-off

```yaml
starter_id: react-router
package_manager: npm
project_name: agent-werewolves
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: verified
  path_taken: custom
  quality_override: false
  self_check_answers:
    typed: true
    from_official_starter: true
    conventions: true
    docs_current: true
    can_judge_agent: true
  has_auth: true
  has_payments: false
  has_realtime: true
  has_ai: true
  has_background_jobs: true
```

**Why this stack** (verbatim from hand-off):

A solo after-hours builder with an 8-week MVP needs a mainstream, typed, convention-based full-stack React framework that can also host long-running, stateful game sessions on free tiers. The deciding factor was the game engine: games run up to 45 minutes, drive multi-model LLM turns, push live events to spectators within 2 seconds, and batches run headless. That rules out stacks whose default hosting only offers short-lived request functions (Next.js and T3 on Vercel Hobby) and makes the content-first 10x Astro starter awkward. React Router v7 deploys Cloudflare-first, so game rooms can live as Durable Objects in the same app with live connections, staying within the user's strong preference for free tiers (Cloudflare plus a hosted Postgres such as Supabase for the archive). Auth is a single rotatable access key, not accounts, so no auth library is assumed. It passes all four agent-friendly gates, bootstrapper confidence is verified, and the self-check came back clean. CI runs on GitHub Actions with auto-deploy on merge.

## Pre-scaffold verification

| Signal      | Value                                                  | Severity | Notes                                                                 |
| ----------- | ------------------------------------------------------ | -------- | --------------------------------------------------------------------- |
| npm package | create-react-router v8.4.0 published 2026-10-14        | fresh    | resolved from cmd_template                                            |
| GitHub repo | remix-run/react-router last pushed 2026-10-16          | fresh    | card docs_url is reactrouter.com (not GitHub); canonical repo checked |

## Scaffold log

**Resolved invocation**: `npx create-react-router@latest .bootstrap-scaffold --yes --package-manager npm`
**Strategy**: subdir-then-move
**Exit code**: 1 (overridden by user — see note)
**Files moved**: 22 files + `node_modules/` (whole tree)
**Conflicts (.scaffold siblings)**: none
**.gitignore handling**: moved silently (absent in cwd)
**.bootstrap-scaffold cleanup**: deleted

**Exit-code override**: the CLI copied the template, included its React Router agent skill, and installed dependencies successfully, then failed at its final step (`Oh no! Failed to initialize git.` — `git init` ran inside `.bootstrap-scaffold/` but the initial commit did not). Since bootstrapper discards any CLI-created git history anyway, the user chose to delete `.bootstrap-scaffold/.git/` and continue instead of hard-stopping. Future runs can avoid this with `--no-git-init`.

**Post-move fix**: the package name came out as `bootstrap-scaffold` (from the temp directory name); renamed to `agent-werewolves` in `package.json` and `package-lock.json`.

Moved files:
- `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `react-router.config.ts`
- `.gitignore`, `.dockerignore`, `Dockerfile`, `README.md`
- `app/root.tsx`, `app/routes.ts`, `app/routes/home.tsx`, `app/app.css`, `app/welcome/welcome.tsx`, `app/welcome/logo-light.svg`, `app/welcome/logo-dark.svg`
- `public/favicon.ico`
- `.agents/skills/react-router/SKILL.md` and `references/{framework-mode,data-mode,declarative-mode,rsc}.md`
- `node_modules/`

## Post-scaffold audit

**Tool**: npm audit --json
**Summary**: 0 CRITICAL, 0 HIGH, 0 MODERATE, 0 LOW
**Direct vs transitive**: 0/0/0/0 direct of total 0/0/0/0 (224 packages: 94 prod, 131 dev, 50 optional)

#### CRITICAL findings

None.

#### HIGH findings

None.

#### MODERATE findings

None.

#### LOW / INFO findings

None.

## Hints recorded but not acted on

| Hint                    | Value                     |
| ----------------------- | ------------------------- |
| bootstrapper_confidence | verified                  |
| quality_override        | false                     |
| path_taken              | custom                    |
| self_check_answers      | all five true             |
| team_size               | solo                      |
| deployment_target       | cloudflare-pages          |
| ci_provider             | github-actions            |
| ci_default_flow         | auto-deploy-on-merge      |
| has_auth                | true                      |
| has_payments            | false                     |
| has_realtime            | true                      |
| has_ai                  | true                      |
| has_background_jobs     | true                      |

Note: the default template targets Node (`@react-router/node`, `react-router-serve`, `Dockerfile`), not Cloudflare. Switching to the Cloudflare runtime (the official `cloudflare` template in remix-run/react-router-templates) is not done in v1.

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:
- `git init` (if you have not already) to start your own repo history.
- Review any `.scaffold` siblings the conflict policy created and decide which version of each file to keep.
- Address audit findings per your project's risk tolerance — the full breakdown is in this log.
