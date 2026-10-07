# SESSION: bugfix

**Trigger**: "Fix: `<description>`"

Reproduce with a failing test, apply the smallest fix, verify no regressions.

## Workflow

1. **REPRODUCE** — Understand the bug:
   - Read the bug description
   - Identify which module(s) are affected
   - Write a failing test that reproduces the bug

2. **FIX** — Implement the smallest fix:
   - Fix the bug
   - Run the reproducing test to confirm it passes
   - Run full test suite to confirm no regressions

3. **VERIFY** — Use the `test-runner` agent with `full` scope.

4. **SIMPLIFY** — Run `/simplify` on changed files.

5. **DOCUMENT**: Update `CHANGELOG.md`. If the bug revealed a design issue, note it in `TECH_DEBT.md`.

6. **CODE REVIEW** — Run `/code-review`. Address any findings before committing.

**Pre-commit**: See Mandatory Pre-Commit Steps in `CLAUDE.md`.

**Output**: What was broken, what caused it, what was fixed.
