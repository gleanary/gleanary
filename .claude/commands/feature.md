---
description: Run a Gleanary SESSION: feature as a cost-optimized orchestration — scout + plan inline (Fable), then delegate build/verify/review to cheap subagents via the feature-session workflow, then review + commit inline.
argument-hint: '[brief describing the feature to build]'
allowed-tools: Agent, Workflow, Bash, Read, Grep, Glob, Edit, Write, AskUserQuestion
---

# /feature — orchestrated feature session

`$ARGUMENTS` is the feature brief. Invoking this command is an **explicit opt-in** to the
orchestrated `feature-session` workflow: you (the orchestrator) do only the judgment-heavy
bookends — scout, plan, final review, commit — and delegate feature.md steps 2–7 to cheap
subagents. Do not do the implementation yourself.

Follow this spine exactly. Do not skip the approval gate.

## 1. SCOUT (inline, keep your own context lean)

Dispatch an `Explore` subagent to map the code the brief touches: the files to create/modify,
the existing patterns to mirror (similar routes/components), the relevant types/validators, and
any existing tests that are the regression net. Ask it for tight `file:line` findings, not file
dumps. If the brief is trivial and self-evident, you may skip the subagent — but prefer scouting.

## 2. PLAN (feature.md step 1) — then STOP

From the scout's findings, post a plan:

- **Files** to create/modify
- **Approach** in 3–5 bullets
- **Edge cases** to cover (these become the workflow's test targets)

Then **wait for explicit human approval.** Do not launch the workflow until the user approves.
If they adjust, revise and re-post.

## 3. LAUNCH (on approval)

Call the workflow with the approved plan as args:

```
Workflow({
  scriptPath: ".claude/workflows/feature-session.js",
  args: {
    goal:      "<one-line goal>",
    approach:  "<the approved approach, with concrete instructions the implement worker needs>",
    files:     ["<path>", ...],
    edgeCases: ["<edge case / test target>", ...]
  }
})
```

`mode` defaults to `feature` (test-first red→green). It runs in the background and returns a
structured bundle. Tell the user they can watch with `/workflows`.

## 4. REVIEW (inline, when it returns)

- Read the bundle: `status`, `implement`, `verify`, `reviewFindings`, `reminders.docsImpact`.
- **Eyeball the real diff** (`git status --short`). The auto-fix loop can pull in files outside
  the planned scope — if it did, split that work into its own commit rather than bundling it.
- Decide which `reviewFindings` are worth fixing; make those edits yourself.
- Handle what workers are barred from: `docs/architecture.md`, `.env`, `infra/`,
  `.github/workflows/` need your inline edit (architecture.md needs the plan's approval).
- Run the CLAUDE.md doc-freshness check (module spec / README / Module Registry) if applicable.

## 5. COMMIT

Stage only the in-scope files and commit with a conventional message (`feat(...)` / `fix(...)`).
Leave unrelated working-tree changes (e.g. `.claude/settings.json`) out. Report a short summary:
what shipped, verify status, and any deferred follow-ups.

## Guardrails

- **Never delegate the bookends.** PLAN + approval and final review + commit stay with you.
- **Never let a worker touch** `docs/architecture.md`, `.env`, `infra/`, `.github/workflows/`.
- **Always eyeball the final diff** for scope creep before committing.
- Tune per-phase model/effort/fan-out in the `MODEL` / `EFFORT` / `MAX_FIX_ATTEMPTS` block at the
  top of `.claude/workflows/feature-session.js`.
