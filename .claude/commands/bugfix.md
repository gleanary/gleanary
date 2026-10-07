---
description: Run a Gleanary SESSION: bugfix as a cost-optimized orchestration — diagnose + root-cause + plan inline (Fable), then delegate repro-test/smallest-fix/verify/review to cheap subagents via the feature-session workflow in bugfix mode, then review + commit inline.
argument-hint: '[bug description, e.g. "highlights disappear after re-parse"]'
allowed-tools: Agent, Workflow, Bash, Read, Grep, Glob, Edit, Write, AskUserQuestion
---

# /bugfix — orchestrated bugfix session

`$ARGUMENTS` is the bug description. Same orchestration spine as `/feature`, but the workflow
runs in **bugfix mode**: the Implement phase becomes REPRODUCE (a failing test that reproduces
the bug) → the **smallest fix** that addresses the root cause, with a mutation check (revert the
fix → repro test goes red again). Invoking this is an explicit opt-in to the workflow; do not
fix the bug yourself.

Follow this spine. Do not skip the approval gate.

## 1. DIAGNOSE (inline, keep your own context lean)

Dispatch an `Explore` subagent to locate the buggy code path: the exact `file:line` where
behavior diverges from intent, how the bad input/state reaches it, which module(s) own it, and
the existing tests nearest to it (the regression net). Tight `file:line` findings only. Form a
root-cause hypothesis from its report; if the evidence is ambiguous between two causes, verify
inline (a targeted test run or quick script) before planning — never launch the workflow on a
guess.

## 2. PLAN (bugfix.md step 1) — then STOP

Post a plan:

- **Root cause**: `file:line` + why the bug happens (hypothesis + supporting evidence)
- **Repro test**: what the failing test will assert, and where it lives
- **Smallest fix**: what changes, in 1–3 bullets
- **Files** to modify

Then **wait for explicit human approval.** If they adjust, revise and re-post.

## 3. LAUNCH (on approval) — pass `mode: 'bugfix'`

```
Workflow({
  scriptPath: ".claude/workflows/feature-session.js",
  args: {
    mode:      "bugfix",
    goal:      "<one-line: fix <bug>>",
    approach:  "<the confirmed root cause + the approved smallest fix, with concrete instructions>",
    files:     ["<path>", ...],
    edgeCases: ["<repro scenario>", "<nearby input/state that must keep working>", ...]
  }
})
```

The worker confirms the root cause, writes the failing repro test (red), applies the smallest
fix (green), runs the mutation check, and reports any design issue the bug revealed in
`techDebtNote`. Runs in the background; user can watch with `/workflows`.

## 4. REVIEW (inline, when it returns)

- Read the bundle: `status`, `implement` (`rootCause` / `red` / `green` / `mutationCheck`),
  `verify`, `reviewFindings`, `reminders.techDebtNote`.
- **Check `rootCause` matches the approved diagnosis** — if the worker found a different cause,
  re-examine before trusting the fix.
- **Eyeball the real diff** (`git status --short`): a bugfix should be minimal. Split any
  out-of-scope auto-fix into its own commit.
- If `techDebtNote` is not "none", add the entry to `TECH_DEBT.md` yourself (match its format).
- Handle worker-barred files inline; run the CLAUDE.md doc-freshness check if the fix changed
  API behavior (status codes, response shape → module spec).

## 5. COMMIT

Stage only the in-scope files; commit with `fix(module): ...`. Report in the bugfix session's
output contract: **what was broken, what caused it, what was fixed** — plus verify status and
any tech-debt follow-up filed.

## Guardrails

- **Smallest fix only.** No drive-by refactoring; design issues the bug revealed go to
  `TECH_DEBT.md`, not this diff.
- **Never delegate the bookends** (diagnosis + plan + approval, final review + commit).
- **Never let a worker touch** `docs/architecture.md`, `.env`, `infra/`, `.github/workflows/`.
- **Always eyeball the final diff** for scope creep.
- Tune models/effort in the `MODEL` / `EFFORT` / `MAX_FIX_ATTEMPTS` block at the top of
  `.claude/workflows/feature-session.js`.
