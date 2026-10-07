# CLAUDE.md — Project Operating Instructions

## Project Overview

Gleanary — self-hosted personal reading app. Single-user, Next.js 14+ full-stack TypeScript app with SQLite.

**Read `docs/architecture.md` before any work.** It is the source of truth for all technical decisions.

---

## Workflow Enforcement (MUST READ FIRST)

**BEFORE writing any code, you MUST:**

1. **Identify the session type** — determine which session applies (default: `feature`).
2. **Create a TodoWrite checklist** — read the session's workflow file in `docs/sessions/` and populate the checklist with every numbered step from that session's workflow, in order. Each step becomes a todo item. This is the visible contract for the session.
3. **Execute steps in order** — mark each todo `in_progress` before starting it and `completed` when done. **Never skip ahead.** If a step says "wait for human approval", stop and wait.

**This is not optional.** The TodoWrite checklist is the enforcement mechanism. If the checklist doesn't exist before coding starts, the workflow is already broken.

---

## Mandatory Pre-Commit Steps

**These steps apply to EVERY session that changes code. No exceptions. Do not commit until all are done.**

1. **Run `/simplify`** on all changed files — this catches code reuse, quality, and efficiency issues. Apply the fixes before proceeding.
2. **Run `./node_modules/.bin/prettier --write .`** — auto-fix all formatting before running lint. Prettier errors are the most common CI failure; always fix them before verifying. Use the local binary directly rather than `npx prettier`.
3. **Run verification** — use the `test-runner` agent (full suite): lint, typecheck, unit/integration tests, and E2E must all pass.
4. **Update `CHANGELOG.md`** — one line under "Unreleased" describing the change.
5. **Check documentation freshness** — if the change affects any of the following, update the corresponding doc:
   - **API routes** (added/changed/removed params, status codes, response shape) → update `docs/modules/<module>.md` API contract section
   - **DB schema** (`src/db/schema.ts` changed) → update `docs/architecture.md` §5 and relevant module spec
     > Note: a pre-commit hook enforces this — the commit will fail until `docs/architecture.md` is staged. The hook message "re-run to confirm" is misleading; there is no bypass.
   - **Setup steps** (new env var, new dependency, new build step) → update `README.md` and `.env.example`
   - **Module behavior** (new feature, changed logic) → update `docs/modules/<module>.md`
   - **Module Registry status** → update the status table in this file (`CLAUDE.md`)
   - If none of the above apply, skip this step.

**CRITICAL: Steps 1 and 2 (`/simplify` + Prettier) are not optional.** It must run after building and before committing, in every session: feature, module-build, refactor, bugfix. The only exceptions are sessions that don't change code (docs, e2e-tests with no code fixes).

---

## Session Types

Every interaction with Claude Code follows one of these session types. The human will specify which session to run. **If no session type is specified, use SESSION: feature by default** — this ensures tests and verification always run, even for small changes.

---

### SESSION: scaffold

**Trigger**: explicit scaffold request

Full instructions: [`docs/sessions/scaffold.md`](docs/sessions/scaffold.md)

---

### SESSION: module-build

**Trigger**: "Build Module N" or "Implement `<module>`"

Full build of one module: spec → failing tests → build to green → document → scoped security checks → simplify → verify → code review.

Full instructions: [`docs/sessions/module-build.md`](docs/sessions/module-build.md)

---

### SESSION: refactor

**Trigger**: "Refactor pass" or "Phase N refactoring"

Codebase-wide audit and cleanup: dead code, duplication, dependencies, tech debt.

Full instructions: [`docs/sessions/refactor.md`](docs/sessions/refactor.md)

---

### SESSION: bugfix

**Trigger**: "Fix: `<description>`"

Reproduce with a failing test, apply the smallest fix, verify no regressions.

Full instructions: [`docs/sessions/bugfix.md`](docs/sessions/bugfix.md)

---

### SESSION: feature

**Trigger**: Any feature request that isn't a full module build. **DEFAULT session type** when none is specified.

Plan for approval, then test-first implementation with security, simplify, verify, and review gates. Steps 2 (TEST), 5 (SIMPLIFY), 6 (VERIFY), and 7 (CODE REVIEW) are mandatory — never skip.

Full instructions: [`docs/sessions/feature.md`](docs/sessions/feature.md)

---

### SESSION: e2e-tests

**Trigger**: "Write E2E tests" or "Add E2E for `<journey>`"

Playwright tests for the critical user journeys listed in `docs/architecture.md` §11.5.

Full instructions: [`docs/sessions/e2e-tests.md`](docs/sessions/e2e-tests.md)

---

### SESSION: infra

**Trigger**: "Set up infrastructure" or "Update infra: `<change>`"

OpenTofu, Docker, and CI/CD changes — always validated, human-reviewed before apply.

Full instructions: [`docs/sessions/infra.md`](docs/sessions/infra.md)

---

### SESSION: docs

**Trigger**: "Update documentation", "Write ADR for `<decision>`", or "Reconcile docs" — run every 2-3 modules or when docs feel stale.

Reconcile module specs, architecture doc, and registry against the actual code. No code changes in this session.

Full instructions: [`docs/sessions/docs.md`](docs/sessions/docs.md)

---

### SESSION: security-audit

**Trigger**: `"Security audit"` or `"Security review"`

Full codebase security scan (7 checks: XSS, SSRF, input validation, SQL injection, secrets, dependencies, headers). Run at minimum once per phase, or after any module that handles external input. Its checks 1–6 are also the canonical reference for the scoped SECURE steps in module-build and feature sessions.

Full instructions: [`docs/sessions/security-audit.md`](docs/sessions/security-audit.md)

---

## Orchestrated Workflow Routing (`.claude/workflows/`)

Session types define the process; the workflows in `.claude/workflows/` are the cost-optimized execution engine (cheap workers, Fable reserved for plan + final review). After the PLAN is approved, pick the execution path by the **shape of the issue**, not its label:

| Issue shape                                                                                                     | Execution path                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New feature / behavior change                                                                                   | `feature-session` mode `feature` (test-first red→green)                                                                                                                   |
| Product bug                                                                                                     | `feature-session` mode `bugfix` (reproduce-red → smallest fix)                                                                                                            |
| Behavior-preserving refactor of product code                                                                    | `feature-session` mode `refactor` (green-baseline → preserve-contract)                                                                                                    |
| Refactor **existing tests** without weakening them (stub/env hygiene, fake timers, flaky E2E, testid migration) | `feature-session` mode `test-hygiene` (green-baseline → suite-contract gate; E2E fixes get a `--repeat-each` stability proof)                                             |
| Add tests for **existing code** (coverage gaps)                                                                 | `feature-session` mode `test-coverage` (tests pass immediately → mutation check per file; discovered bugs reported, never fixed inline)                                   |
| One mechanical transformation across many test files (~10+)                                                     | `test-sweep` (fan-out per file group → aggregate contract check → single verify)                                                                                          |
| Docs drift (`architecture.md`, module specs)                                                                    | **Inline `SESSION: docs`, never a workflow** — `architecture.md` is human-approval-only and workers are forbidden from editing it                                         |
| CI/CD, infra                                                                                                    | **Inline `SESSION: infra`, never a workflow** — workers are forbidden from `.github/workflows/` and `infra/`; pushes touching `.github/workflows/` need the human's token |

Routing rules:

- **Test-only changes never go through `feature` or `bugfix` modes.** The red-first gate is circular when the deliverable is tests, and there is no product root cause. Use `test-hygiene` (changing existing tests) or `test-coverage` (adding tests).
- **If a `test-coverage` run reports `bugsDiscovered`**, each entry has a skipped test asserting correct behavior. Dispatch one `mode: bugfix` run per bug afterward; the fix un-skips that test as its repro.
- **`test-sweep` vs `test-hygiene`:** sweep is for one well-defined pattern applied repetitively (pass the exact transformation + file list); hygiene is for judgment-heavy test work in one coherent slice. When a hygiene issue is mostly mechanical and spans many files, prefer the sweep.
- **Mixed issues split.** An issue that touches tests _and_ product behavior becomes two runs (e.g. hygiene for the specs + feature/bugfix for the src change). The only sanctioned product-code edit in test modes is additive `data-testid` attributes.

---

## Code Conventions

### Project Structure

See `docs/architecture.md §17`. Key directories: `src/app/` (Next.js routes + API), `src/lib/` (shared utilities), `src/db/` (Drizzle schema + migrations), `src/types/`, `__tests__/` (unit/integration/mocks), `e2e/`, `docs/`, `infra/`, `docker/`.

### TypeScript

- **Strict mode**: no `any`, no implicit returns, no unused variables
- **Types go in `src/types/`**: never define types inline in API routes
- **Prefer `interface` for object shapes**, `type` for unions/intersections
- **All exported functions must have JSDoc**: at minimum `@param` and `@returns`
- **Use `const` by default**, `let` only when reassignment is needed

### API Routes

- **Always return typed responses**: use a shared response helper
- **Consistent error handling**:

```typescript
// Pattern for all API routes:
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    // ... validate, process
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    logger.error({ err: error, route: 'POST /api/articles' }, 'Request failed');

    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
```

- **Validation**: use Zod schemas for all request body validation
- **Status codes**: 200 (success), 201 (created), 400 (bad request), 404 (not found), 409 (conflict/duplicate), 422 (validation), 500 (server error), 503 (unavailable)

### Database

- **Schema is in `src/db/schema.ts`**: single file, Drizzle ORM
- **Never raw SQL in API routes**: always use Drizzle query builder
- **Migrations**: `npm run db:generate` after schema changes, commit migration files
- **FTS5**: maintain sync triggers for full-text search tables

### Logging

- **Use `logger` from `src/lib/logger.ts`** (pino), never `console.log`
- **Structured events for key operations**:
  ```typescript
  logger.info({ event: 'article_saved', articleId, url }, 'Article saved');
  logger.error({ err, event: 'feed_poll_failed', feedId }, 'Feed polling failed');
  ```
- **Log levels**: `error` (broken), `warn` (degraded), `info` (key events), `debug` (dev only)

### Styling

- **Tailwind CSS + shadcn/ui**: no custom CSS files unless absolutely necessary
- **Dark mode**: system preference auto-switch via `prefers-color-scheme`. Use Tailwind's `dark:` variant. No manual toggle needed.
- **Responsive**: mobile-first, works on phone screens
- **Reader view**: optimize for reading comfort:
  - Serif font stack: `Georgia, Charter, 'Libre Baskerville', serif`
  - Body text: 18-20px, line-height 1.7
  - Max-width: 680px, centered
  - Light mode: warm off-white `#FAFAF7` background, dark text `#1A1A1A`
  - Dark mode: deep gray `#1A1A1A` background, soft white `#E8E6E3` text
  - No pure white (`#FFF`) or pure black (`#000`) anywhere
  - Sidebar collapses to icon while reading

### Error Handling

- **Custom error classes** in `src/lib/errors.ts`:
  ```typescript
  export class ValidationError extends Error { ... }
  export class NotFoundError extends Error { ... }
  export class DuplicateError extends Error { ... }
  export class ExternalServiceError extends Error { ... }
  ```
- **API routes catch and map** these to appropriate HTTP status codes
- **Never swallow errors silently**: always log, even if recovering

### Git

- **Conventional commits**: `feat(module): description`, `fix(module): description`, `refactor: description`, `docs: description`, `test: description`
- **One module per branch** when feasible: `feat/module-3-rss-engine`
- **Never commit `.env`**: use `.env.example` as template

### Security (Mandatory — see architecture.md §16 and [`docs/sessions/security-audit.md`](docs/sessions/security-audit.md))

Rules are codified in `architecture.md §16.10`. Key invariants: sanitize HTML before render, use Drizzle ORM (no raw SQL), validate URLs via `validateUrl()`, validate all API input with Zod first, never log or hardcode secrets, escape FTS5 queries, no `eval()`.

---

## Testing Conventions

**Global network tripwire (applies to every vitest file, unit and integration):** a shared MSW server runs via vitest `setupFiles` with `onUnhandledRequest: 'error'` — any unmocked HTTP request is rejected instead of silently hitting the real network. Register per-file handlers with `setupHandlers(...)` from `__tests__/mocks/server.ts`; use raw `server.use(...)` only for per-test overrides inside `it` bodies. Never call `setupServer` yourself, and never register handlers in `beforeAll` — the global `afterEach` resets them. For client-side code that fetches relative URLs (which MSW cannot intercept in Node), stub fetch in a `beforeAll` and `vi.unstubAllGlobals()` in `afterAll` (see `__tests__/unit/article-api.test.ts`).

### Unit Tests

- **File naming**: `__tests__/unit/<module-name>.test.ts` (`.test.tsx` for component tests)
- **No DB, no network, no file system**: pure logic by default; DOM via jsdom is allowed for component tests
- **Component tests**: use `@testing-library/react` with a `/** @vitest-environment jsdom */` docblock (global env stays `node`); render the real component through its real provider — never assert on a re-implemented copy of component logic (see `reading-progress-bar.test.tsx`)
- **Arrange-Act-Assert pattern**
- **Descriptive test names**: `it('doubles interval on successful review')`

### Integration Tests

- **File naming**: `__tests__/integration/<module-name>.test.ts`
- **Use `createTestDb()` from `__tests__/integration/setup.ts`** for fresh in-memory DB per test
- **Test the API route handler directly**: import the route handler, don't spin up a server
- **MSW for external calls**: mock every external HTTP request via the global tripwire's `setupHandlers(...)` (see above)

### E2E Tests

- **File naming**: `e2e/<journey-name>.spec.ts`
- **Only critical user journeys** (see architecture.md Section 11.5)
- **Use `data-testid` attributes** for selectors, never CSS classes
- **Each test is independent**: no shared state between tests

### Running Tests

```bash
npm run test              # All unit + integration (vitest)
npm run test -- --watch   # Watch mode
npm run test -- <path>    # Specific file
npx playwright test       # All E2E
npx playwright test <file> # Specific E2E
```

---

## Session Efficiency

1. **One module per session**: don't try to build two modules in one session
2. **Read everything upfront**: read all relevant files at the start, not incrementally
3. **Use `/compact` proactively**: when context feels large, compact before continuing
4. **If you hit context limits**: commit current work, start a new session with `"Continue Module N: <name>"`
5. **Use parallel subagents for repetitive cross-file changes** (e.g. error handling standardization, logging migration): fan out one Agent per file group. Don't parallelize interdependent changes.

---

## Module Registry

| #   | Module                                   | Spec                                               | Status      |
| --- | ---------------------------------------- | -------------------------------------------------- | ----------- |
| —   | Project Scaffold                         | `docs/sessions/scaffold.md`                        | Done        |
| 0   | Infrastructure (OpenTofu, Docker, CI/CD) | `docs/architecture.md` §8-9                        | Partial     |
| 1   | Data Layer + API                         | `docs/modules/data-layer.md`                       | Done        |
| 2   | Article Parser                           | `docs/modules/article-parser.md`                   | Done        |
| 3   | RSS Feed Engine                          | `docs/modules/rss-engine.md`                       | Done        |
| 4   | Reader View                              | `docs/modules/reader-view.md`                      | Done        |
| 5   | Highlight Library                        | `docs/modules/highlight-library.md`                | Done        |
| 6   | Daily Review                             | `docs/modules/daily-review.md`                     | Done        |
| 7   | AI Features                              | `docs/modules/ai-features.md`                      | Done        |
| 8   | Browser Extension                        | `docs/modules/browser-extension.md`                | Done        |
| 9   | reMarkable Integration                   | — (spec not yet written)                           | Not started |
| 10  | Mobile Save                              | `docs/modules/mobile-save.md`                      | Done        |
| 11  | Newsletter Email Ingestion               | `docs/modules/newsletter-ingestion.md`             | Done        |
| 12  | Text-to-Speech Immersion Reading         | `docs/modules/text-to-speech-immersion-reading.md` | Done        |
| 13  | Thesis Tracker                           | `docs/modules/thesis-tracker.md`                   | Done        |
| 14  | Knowledge Chat                           | `docs/modules/knowledge-chat.md`                   | Done        |
| 15  | Voice Profile                            | `docs/modules/voice-profile.md`                    | Done        |
| 16  | Content Templates                        | `docs/modules/content-templates.md`                | Done        |
| 17  | AI Usage Tracking                        | `docs/modules/ai-usage.md`                         | Done        |
| 18  | PDF Import                               | `docs/modules/pdf-import.md`                       | Done        |
| 19  | Global Search                            | `docs/modules/global-search.md`                    | Done        |
| 20  | Robust Highlight Anchoring               | `docs/modules/highlight-anchoring.md`              | Done        |
| 21  | Authentication                           | `docs/modules/auth.md`                             | Done        |
| —   | Content Pipeline (cross-cutting)         | `docs/modules/content-pipeline.md`                 | Done        |

Claude Code updates the status column as modules are completed.

---

## Files Claude Code Must Never Modify Without Explicit Request

- `docs/architecture.md` — source of truth, only updated with human approval
- `.env` / `terraform.tfvars` — contain secrets
- `infra/` — infrastructure changes require human review before apply
- `.github/workflows/` — CI/CD changes require human review

---

## Quick Reference: Common Commands

```bash
# Development
npm run dev                    # Start dev server
npm run build                  # Production build
npm run lint                   # ESLint + Prettier check
npm run typecheck              # TypeScript strict check
npm run test                   # Unit + integration tests
npx playwright test            # E2E tests (required pre-commit)

# Database
npm run db:generate            # Generate migrations after schema change
npm run db:migrate             # Apply migrations
npm run db:studio              # Visual DB browser

# Infrastructure
cd infra && tofu plan          # Preview infra changes
cd infra && tofu apply         # Apply infra changes

# Docker
docker build -f docker/Dockerfile -t gleanary .
docker compose -f docker/compose.yml up -d
```

### Styling & Design System

**Stack:** Tailwind v4 + shadcn/ui (new-york, neutral base), `lucide-react` icons. Tokens live in `src/app/globals.css` as CSS variables, exposed to Tailwind via `@theme inline`. **This is the single source of truth — never hardcode colors.**

#### Token-first rule

- **Always use the semantic utility, never a raw value.** `bg-card`, `text-muted-foreground`, `border-border` — never `bg-[oklch(...)]`, `text-[#aaa]`, or a Tailwind palette color for chrome (`bg-neutral-900`, `text-gray-400`).
- Raw Tailwind palette colors (`blue-*`, `amber-*`, etc.) are **not** allowed for app chrome or status. Status badges/roles map onto the `tint-*` token ramp (see below); the only fixed raw accents are the `yellow-400` highlight, the TTS/reading-progress `blue-400/500`, and the favorite-heart active state `red-500` (`fill-red-500 text-red-500`).
- New surface/text needs almost never require a new token. Compose from the existing set first.

| Role                   | Utility                                                   | Notes                                                                       |
| ---------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| App canvas             | `bg-background` `text-foreground`                         | cool-tinted dark, warm off-white light                                      |
| Sidebar                | `bg-sidebar` `text-sidebar-foreground`                    | darker than canvas in dark mode                                             |
| Card / panel / popover | `bg-card` / `bg-popover`                                  | always `border border-border rounded-lg`                                    |
| Raised / hover fill    | `bg-secondary` / `bg-muted` / `bg-accent`                 | the three are the same value                                                |
| Secondary text         | `text-muted-foreground`                                   | meta, labels, captions                                                      |
| Primary action         | `bg-primary text-primary-foreground`                      | light pill in dark, dark pill in light                                      |
| Secondary action       | `bg-secondary text-secondary-foreground`                  |                                                                             |
| Destructive            | `bg-destructive text-white`                               |                                                                             |
| Semantic accents       | `bg-success` / `bg-warning` / `bg-info` (+ `-foreground`) | solid status fills; e.g. over-budget meter uses `text-warning`/`bg-warning` |
| Status/role tints      | `bg-tint-<hue> text-tint-<hue>-fg`                        | soft badge family; 7 hues: slate, amber, blue, purple, green, red, orange   |
| Borders                | `border-border` (10% white) · inputs `border-input` (15%) |                                                                             |
| Focus ring             | `ring-ring`                                               | shadcn handles via `focus-visible`                                          |
| Sidebar active accent  | `bg-sidebar-accent`                                       | indigo `sidebar-primary` is reserved, used sparingly                        |

#### Theme (light / dark)

- An inline script in `layout.tsx` runs **before first paint** to prevent FOUC: it reads `localStorage.appearance_mode` (`light` | `dark` | `automatic`) and toggles `.dark` on `<html>`. `automatic` falls back to `prefers-color-scheme`.
- Build every view with the `dark:` variant against the tokens. Because tokens flip under `.dark`, semantic utilities (`bg-card`, etc.) are already theme-correct — you only need explicit `dark:` for the rare hardcoded accent.
- Never assume a fixed mode. Both must look right.

#### Type

- **UI:** `font-sans` = system-ui stack (no web font is loaded — do not add one).
- **Reader body:** `Georgia, Charter, 'Libre Baskerville', serif`, 18px, line-height 1.7, `.article-content` color `#616c77` (light) / `#c1c7ce` (dark). Reader **headings** switch to `system-ui` sans, bold.
- Weights: titles/headings `font-medium` (500) or `font-semibold` (600); body `font-normal`. Avoid `font-bold` outside the reader.
- Sizes: `text-sm` (14) body/controls, `text-xs` (12) meta, `text-base`/`text-lg` for titles. Section labels: `text-xs font-semibold uppercase tracking-wider text-muted-foreground`.

#### Spacing & radius

- 4px Tailwind scale; default gaps `gap-2`/`gap-3`, card padding `p-4`, section spacing `gap-4`–`gap-6`.
- `--radius` = `0.625rem` (10px). Cards `rounded-lg`, buttons/inputs `rounded-md`, badges/pills/progress `rounded-full`.

#### Components

- **Buttons:** use `@/components/ui/button` variants — `default` (primary), `secondary`, `outline`, `ghost`, `destructive`, `link`. Sizes `default` (h-9), `sm`, `xs`, `icon`. Never style a raw `<button>`.
- **Badges:** use `@/components/ui/badge` (`default` / `secondary` / `outline` / `destructive`). Pills are `rounded-full px-2 py-0.5 text-xs font-medium`.
- **Status badges** (thesis / article / evidence role) map onto the soft `tint-*` ramp — `bg-tint-<hue> text-tint-<hue>-fg`. The tokens flip light/dark on their own, so no `dark:` variant is needed. Reuse these maps verbatim, don't reinvent:
  ```
  thesis    nascent → tint-slate · developing → tint-blue · researched → tint-purple · ready → tint-green · used → tint-amber
  article   inbox → tint-blue · reading → tint-amber · archived → tint-slate · pending_review → tint-orange
  role      supporting → tint-green · opposing → tint-red · context → tint-blue
  ```
  Solid dots (e.g. health-panel) use the saturated `-fg` member: `bg-tint-blue-fg`, `bg-tint-amber-fg`, etc.
- **Cards:** `bg-card border border-border rounded-lg p-4`, hover `hover:bg-accent/50` (clickable) or `hover:border-primary/30` (navigable).
- **Highlights:** left accent `border-l-4 border-l-yellow-400`; highlight marks `bg-[rgba(253,224,71,0.4)] dark:bg-[rgba(253,224,71,0.25)]`. This yellow is a fixed brand accent.
- **Favorite (heart) active state:** `fill-red-500 text-red-500` — a sanctioned fixed raw accent (the inactive state inherits `currentColor`). The only place red is allowed outside the `destructive` token.
- **Inputs:** use `@/components/ui/input`; helper text `text-xs text-muted-foreground`.
- **Icons:** `lucide-react` only. Inline UI ~`size={16}`–`18`; in meta rows `size={12}`–`14`. Inherit `currentColor`.

#### Reader view (reading comfort)

- Max-width ~680px, centered. Body 18–20px / line-height 1.7. Sidebar collapses to icons while reading.
- No pure white (`#fff`) or pure black (`#000`) for surfaces or body text — use tokens / the reader colors above.

#### Don't

- Don't add custom CSS files or `style={}` color literals — extend `globals.css` tokens if something is genuinely missing (rare, needs a reason).
- Don't introduce a second font, a new radius, or off-scale spacing.
- Don't use raw palette colors for app chrome or status; status maps onto `tint-*`. The only fixed raw accents are the highlight `yellow-400`, the TTS/reading-progress `blue-400/500`, and the favorite-heart active `red-500`.
