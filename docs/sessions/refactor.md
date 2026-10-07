# SESSION: refactor

**Trigger**: "Refactor pass" or "Phase N refactoring"

Codebase-wide audit and cleanup: dead code, duplication, dependencies, tech debt.

## Workflow

1. **AUDIT** — Scan the entire codebase:
   - `npx depcheck` — find unused dependencies
   - `npm audit` — check for vulnerabilities
   - Search for `TODO`, `FIXME`, `HACK` comments
   - Review `TECH_DEBT.md` for items tagged for this phase
   - Check for duplicated code patterns across modules

2. **FIX** — Address issues found:
   - For isolated, repetitive changes across many files, fan out parallel subagents (Agent tool), one per file group, e.g.:
     - add Zod validation to all API routes missing it
     - convert all console.log calls to structured logger calls
     - standardize error handling in all API routes to use shared error classes
   - For interconnected refactoring (shared types, utility extraction), do it manually:
     - Extract shared utilities into `src/lib/`
     - Consolidate types — no inline type definitions in API routes, all types in `src/types/`
     - Ensure consistent error handling patterns (see conventions in `CLAUDE.md`)
   - Remove unused imports, dead code, unused dependencies
   - Update vulnerable dependencies

3. **SIMPLIFY** — Run `/simplify` on all changes from this pass.

4. **VERIFY** — Use the `test-runner` agent with `full` scope. Also verify: `npm run build`.

5. **DOCUMENT**: Update `TECH_DEBT.md` (mark resolved, add new). Update `CHANGELOG.md`. Verify `.env.example` is complete.

6. **CODE REVIEW** — Run `/code-review`. Address any findings before committing.

**Pre-commit**: See Mandatory Pre-Commit Steps in `CLAUDE.md`.

**Output**: Summary of what was refactored, what debt remains.
