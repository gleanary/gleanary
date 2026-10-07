---
description: Run a scoped, behavior-preserving refactor as a cost-optimized orchestration — scout + plan inline (Fable), then delegate to cheap subagents via the feature-session workflow in refactor mode (green-baseline → preserve-contract), then review + commit inline.
argument-hint: '[brief describing the scoped refactor]'
allowed-tools: Agent, Workflow, Bash, Read, Grep, Glob, Edit, Write, AskUserQuestion
---

# /refactor — orchestrated scoped refactor

`$ARGUMENTS` is the refactor brief. This is the same orchestration spine as `/feature` but runs
the workflow in **refactor mode**: behavior-preserving work has no natural failing test, so the
Implement phase swaps test-first red/green for a **green-baseline → preserve-contract** gate.
Invoking this is an explicit opt-in to the workflow; do not do the refactor yourself.

Use this for a **scoped** refactor (dedup, extract-to-lib, move constants, tighten a boundary).
For a codebase-wide audit-and-cleanup sweep, that is a different shape — say so and stop.

Follow this spine. Do not skip the approval gate.

## 1. SCOUT (inline, keep your own context lean)

Dispatch an `Explore` subagent to pin down the exact duplication/structure to change: every
site (`file:line`), whether copies are byte-identical or divergent, the existing tests that form
the regression net, and any coverage gaps worth a characterization test. Tight findings only.

## 2. PLAN (feature.md step 1, refactor-flavored) — then STOP

Post a plan with:

- **Files** to create/modify
- **Approach** in 3–5 bullets
- **Contract-preservation gate**: exactly what must stay identical (public exports, API response
  shapes + status codes, exported types, wire output) and the **regression net** (which existing
  tests guard it) — plus any thin-coverage spot that needs a new characterization test.

Then **wait for explicit human approval.**

## 3. LAUNCH (on approval) — pass `mode: 'refactor'`

```
Workflow({
  scriptPath: ".claude/workflows/feature-session.js",
  args: {
    mode:      "refactor",
    goal:      "<one-line goal — note 'behavior-preserving'>",
    approach:  "<the approved approach, with concrete instructions and the byte/shape checks>",
    files:     ["<path>", ...],
    edgeCases: ["<contract-preservation point / characterization target>", ...]
  }
})
```

The worker will confirm a green baseline first, refactor, then report `contractPreserved`. Runs
in the background; user can watch with `/workflows`.

## 4. REVIEW (inline, when it returns)

- Read the bundle: `status`, `implement` (`baselineGreen` / `contractPreserved`), `verify`,
  `reviewFindings`. The correctness reviewer also flags any behavior drift vs the original.
- **Eyeball the real diff** (`git status --short`); a refactor should touch only the planned
  files. Split any out-of-scope auto-fix (e.g. an unrelated flaky test) into its own commit.
- Confirm no public contract changed. Handle worker-barred files (architecture.md, etc.) inline.

## 5. COMMIT

Stage only the in-scope files; commit with `refactor(...)`. Leave unrelated changes out. Report
what changed, the contract-preservation evidence, verify status, and any deferred slices.

## Guardrails

- **Behavior-preserving only.** No new functionality, no contract changes.
- **Never delegate the bookends** (plan + approval, final review + commit).
- **Never let a worker touch** `docs/architecture.md`, `.env`, `infra/`, `.github/workflows/`.
- **Always eyeball the final diff** for scope creep.
- Tune models/effort in the `MODEL` / `EFFORT` / `MAX_FIX_ATTEMPTS` block at the top of
  `.claude/workflows/feature-session.js`.
