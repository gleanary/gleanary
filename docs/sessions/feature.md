# SESSION: feature

**Trigger**: Any feature request that isn't a full module build. **DEFAULT session type** when none is specified.

Plan for approval, then test-first implementation with security, simplify, verify, and review gates.

## Workflow

1. **PLAN** — Propose before implementing:
   - List files to create/modify
   - Describe the approach in 3-5 bullet points
   - Identify any edge cases
   - **Wait for human approval before proceeding**

2. **TEST** — Write failing tests first (red/green approach):
   - Unit tests for any new pure logic
   - Integration tests for new/modified API routes
   - Skip tests only if the change is purely visual with no logic (rare)
   - Run tests to confirm they fail (red): `npm run test -- --reporter=verbose`
   - Review existing tests for the changed modules and remove/update any that test obsolete behavior

3. **BUILD** — Implement the feature (green):
   - Follow all code conventions from `CLAUDE.md`
   - Use existing patterns (look at similar components/routes for reference)
   - After tests pass, verify at least one key assertion by temporarily breaking the implementation to confirm the test fails (mutation check). Revert before proceeding.

4. **SECURE** — If the feature touches external input, HTML rendering, URL fetching, or API routes, run the relevant checks (1–6) of [`security-audit.md`](security-audit.md), scoped to the changed files. Skip only for purely internal UI with no data flow.

5. **SIMPLIFY** — Run `/simplify` on changed files.

6. **VERIFY** — Use the `test-runner` agent with `full` scope. Update `CHANGELOG.md`. Report: tests passing, any issues found.

7. **CODE REVIEW** — Run `/code-review`. Address any findings before committing.

**Pre-commit**: See Mandatory Pre-Commit Steps in `CLAUDE.md`.

**Output**: Summary of what was built, files changed, tests added.

**CRITICAL: Steps 2, 5, 6, and 7 are mandatory. Never skip.**
