# SESSION: scaffold

**Trigger**: `"Scaffold the project"` or `"Set up project from scratch"`

This session creates the entire project skeleton. Run once at the start of Phase 1.

## Workflow

1. **CREATE NEXT.JS APP**:

   ```bash
   npx create-next-app@latest gleanary --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"
   ```

2. **INSTALL DEPENDENCIES**:

   ```bash
   # Core
   npm install drizzle-orm better-sqlite3 zod pino
   npm install -D drizzle-kit @types/better-sqlite3 pino-pretty

   # Article parsing
   npm install @mozilla/readability linkedom isomorphic-dompurify
   npm install -D @types/dompurify

   # RSS
   npm install rss-parser

   # AI
   npm install @anthropic-ai/sdk

   # Scheduling
   npm install node-cron
   npm install -D @types/node-cron

   # Testing
   npm install -D vitest @vitejs/plugin-react msw @testing-library/react
   npm install -D playwright @playwright/test

   # Observability
   npx @sentry/wizard@latest -i nextjs
   npm install pino @logtail/pino

   # UI
   npx shadcn@latest init
   ```

3. **CONFIGURE TOOLING**:
   - `tsconfig.json`: strict mode, no `any`
   - `vitest.config.ts`: setup files, path aliases, coverage
   - `playwright.config.ts`: chromium only, base URL
   - `.eslintrc.json`: extend next/core-web-vitals + strict TS rules
   - `.prettierrc`: consistent formatting
   - `drizzle.config.ts`: SQLite driver, migrations folder

4. **CREATE DIRECTORY STRUCTURE**: as defined in the Code Conventions section of `CLAUDE.md`

5. **CREATE BOILERPLATE FILES**:
   - `src/db/schema.ts` — full Drizzle schema from architecture.md §5
   - `src/db/index.ts` — DB connection singleton
   - `src/lib/logger.ts` — pino logger with Better Stack transport
   - `src/lib/errors.ts` — custom error classes
   - `src/lib/sanitize.ts` — DOMPurify sanitization
   - `src/lib/url-validator.ts` — SSRF prevention
   - `src/lib/search.ts` — FTS5 query escaping
   - `src/app/api/health/route.ts` — health check endpoint
   - `src/app/layout.tsx` — root layout with dark mode support (`prefers-color-scheme`)
   - `__tests__/integration/setup.ts` — test DB factory
   - `__tests__/mocks/server.ts` — shared MSW server + `setupHandlers()` (no default handlers)
   - `__tests__/mocks/msw-setup.ts` — global MSW lifecycle (vitest `setupFiles`, `onUnhandledRequest: 'error'`)
   - `.env.example` — all environment variables with descriptions
   - `.gitignore` — include `.env`, `terraform.tfvars`, `*.db`, `.next`
   - `CHANGELOG.md` — initialized with "Unreleased" section
   - `TECH_DEBT.md` — initialized empty
   - `README.md` — project overview + dev setup + deploy steps

6. **GENERATE INITIAL MIGRATION**: `npm run db:generate`

7. **VERIFY**:
   - `npm run lint` passes
   - `npm run typecheck` passes
   - `npm run build` succeeds
   - `npm run test` runs (no tests yet, but framework works)
   - Health endpoint returns 200 in dev mode
   - Dark/light mode toggles via system preference

8. **COMMIT**: `feat: initial project scaffold`
