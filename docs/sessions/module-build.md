# SESSION: module-build

**Trigger**: "Build Module N" or "Implement `<module>`"

Full build of one module: spec → failing tests → implementation → docs → security → review.

## Workflow

1. **READ** — Read these files before writing any code:
   - `docs/architecture.md` (sections relevant to this module)
   - `docs/modules/<module-name>.md` (detailed spec — if it doesn't exist, create it first)
   - `src/db/schema.ts` (current data model)
   - Any existing modules this one depends on

2. **SPEC** — If `docs/modules/<module-name>.md` doesn't exist or is incomplete:
   - Create/update it with: purpose, API contract (inputs/outputs/types), dependencies, edge cases
   - Wait for human approval before proceeding

3. **TEST** — Write failing tests first (red/green approach):
   - Unit tests in `__tests__/unit/<module>.test.ts` for pure logic
   - Integration tests in `__tests__/integration/<module>.test.ts` for API routes
   - Use fixtures in `__tests__/mocks/fixtures/` for external data
   - Run tests to confirm they fail (red): `npm run test -- --reporter=verbose`
   - Review existing tests for the changed modules and remove/update any that test obsolete behavior

4. **BUILD** — Implement until all tests pass (green):
   - Follow the code conventions in `CLAUDE.md`
   - Run `npm run test` after each significant change
   - Run `npm run lint && npm run typecheck` before considering done
   - After tests pass, verify at least one key assertion by temporarily breaking the implementation to confirm the test fails (mutation check). Revert before proceeding.

5. **DOCUMENT** — Update project documentation:
   - Add JSDoc to all exported functions and types
   - Update `CHANGELOG.md` with what was built (under "Unreleased")
   - Create an ADR in `docs/adrs/` if any non-obvious decision was made
   - Update `README.md` if setup steps changed

6. **SECURE** — Run checks 1–6 of [`security-audit.md`](security-audit.md), scoped to the files changed in this session:
   - **Output**: List each check as PASS/FAIL. If any FAIL, fix before proceeding.

7. **SIMPLIFY** — Run `/simplify` on changed files. Resolve TODO/FIXME or move to `TECH_DEBT.md`. For security-sensitive modules (article parser, reader view, search), also run `/simplify focus on security patterns`.

8. **VERIFY** — Use the `test-runner` agent with `full` scope. Report: tests passing, coverage summary, any known issues.

9. **CODE REVIEW** — Run `/code-review` on the changes. Address any findings before committing.

**Pre-commit**: See Mandatory Pre-Commit Steps in `CLAUDE.md`.

**Output**: Commit message summary of what was built, ready for human to review and push.
