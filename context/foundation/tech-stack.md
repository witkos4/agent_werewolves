---
starter_id: react-router
package_manager: npm
project_name: agent-werewolves
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-workers
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
---

## Why this stack

A solo after-hours builder with an 8-week MVP needs a mainstream, typed, convention-based full-stack React framework that can also host long-running, stateful game sessions on free tiers. The deciding factor was the game engine: games run up to 45 minutes, drive multi-model LLM turns, push live events to spectators within 2 seconds, and batches run headless. That rules out stacks whose default hosting only offers short-lived request functions (Next.js and T3 on Vercel Hobby) and makes the content-first 10x Astro starter awkward. React Router v7 deploys Cloudflare-first, so game rooms can live as Durable Objects in the same app with live connections, staying within the user's strong preference for free tiers (Cloudflare plus a hosted Postgres such as Supabase for the archive). Auth is a single rotatable access key, not accounts, so no auth library is assumed. It passes all four agent-friendly gates, bootstrapper confidence is verified, and the self-check came back clean. CI runs on GitHub Actions with auto-deploy on merge.
