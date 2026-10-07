# Development Guide

## Prerequisites

- Node.js 22+ (matches the Docker image and CI)
- npm

## Setup

```bash
npm install
cp .env.example .env   # then fill in the required values (see README)
npm run db:migrate
npm run dev
```

## Commands

```bash
npm run dev          # Start dev server
npm run build        # Production build
npm run lint         # ESLint + Prettier check
npm run typecheck    # TypeScript strict check
npm run test         # Unit + integration tests (Vitest)
npx playwright test  # E2E tests

npm run db:generate  # Generate migrations after schema changes
npm run db:migrate   # Apply migrations
npm run db:studio    # Visual DB browser
```

## E2E tests and authentication

The Playwright suite spawns the dev server with `AUTH_DISABLED=true` by
default. Set `E2E_AUTH_PASSWORD` to run against real auth — the config derives
a matching `SETTINGS_AUTH_HASH` for the spawned server and the login journey
spec (`e2e/auth.spec.ts`) un-skips. Auth mode is intended for CI: on a machine
whose `.env` defines `SETTINGS_AUTH_HASH`, Next.js `$`-expands (and destroys)
the injected bcrypt hash.

## AI-Assisted Development

This project is built with two complementary Claude workflows.

### Claude AI project (planning)

A Claude AI project at claude.ai synced to this repo via GitHub integration.
Used for:

- Product thinking and feature design
- Drafting and refining module specs (`docs/modules/*.md`)
- Architecture discussions and trade-off analysis
- Reviewing and updating documentation

The project has custom instructions that establish a ground truth hierarchy:
`src/db/schema.ts` → `CHANGELOG.md` → module specs → `docs/architecture.md`.
This prevents Claude from treating stale specs as facts.

Files synced: `docs/architecture.md`, `docs/modules/*.md`, `CHANGELOG.md`,
`CLAUDE.md`, `src/db/schema.ts`, `src/types/`, `package.json`.

### Claude Code CLI (implementation)

All implementation is done via the Claude Code CLI (`claude` command),
following the session workflow defined in `CLAUDE.md`. Each session type
(feature, module-build, bugfix, refactor, docs) has a mandatory checklist
enforced before any code is committed.

The `feature` and scoped-`refactor` sessions can also run as a **cost-optimized
multi-agent orchestration** via the `/feature <brief>` and `/refactor <brief>`
slash commands: cheap subagents do the build/verify/review work while the
orchestrator model only plans and reviews, cutting orchestrator token spend for
the same rigor. See the README's
[Orchestrated Feature Workflow](../README.md#orchestrated-feature-workflow)
section and [`.claude/workflows/feature-session.js`](../.claude/workflows/feature-session.js).

The pre-commit hook in `scripts/pre-commit` blocks schema changes that aren't
reflected in `docs/architecture.md`. Install it after cloning:

```bash
cp scripts/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

### Keeping docs in sync

Module specs (`docs/modules/*.md`) each have a status block at the top showing
last verified date and schema tables used. Run `SESSION: docs` in Claude Code
every few modules to reconcile specs against the actual schema and changelog.
