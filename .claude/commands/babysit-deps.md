---
description: Triage, verify, and (safely) merge open Dependabot PRs — fan out read-only dossier workers per PR, then decide serially: auto-merge patch/minor when clean, auto-fix mechanical CI failures, escalate real judgment calls, and open tracking issues for adoptable new features.
argument-hint: '[PR number, or blank for all open dependabot PRs]'
allowed-tools: Bash, Read, Grep, Glob, WebFetch, AskUserQuestion, Edit, Write, Workflow
---

# Babysit Dependabot PRs

You are triaging Dependabot dependency-bump PRs for Gleanary. Three phases: preflight →
dossiers (fanned out, read-only) → decide (inline, serial). Workers gather evidence; **you**
make every call and perform every mutation. Be decisive within the policy; only stop to ask
on genuine judgment calls.

## Phase A — Preflight (inline)

1. Verify auth: `gh auth status`. If the token is invalid, STOP and tell the user to run
   `! gh auth refresh -h github.com` — nothing below works without it.
2. Enumerate targets:
   - If `$ARGUMENTS` is a PR number, operate on just that PR.
   - Otherwise: `gh pr list --author "app/dependabot" --state open --json number,title,headRefName,labels,mergeable,mergeStateStatus --limit 50`
3. Print the list.
4. **A.5 — main CI baseline** (one inline check so N workers don't each re-analyze the same
   failure): `gh run list --branch main --workflow CI --limit 3 --json databaseId,conclusion`.
   If the latest run is red, get the failing job names (`gh run view <id> --json jobs`) and one
   signature line from `--log-failed`. Summarize as ONE line, e.g. "main red on 'E2E Tests
   (critical paths)': login-submit-button never enabled, 35/44 failing — pre-existing". If
   main is red and no bug issue tracks it yet, open one. Note:
   `gh` needs the sandbox override to read the keychain — all these calls are read-only.

## Phase B — Dossiers

**Single PR** (`$ARGUMENTS` given, or only one open): build the dossier inline — run the
worker steps yourself (classify, diff, changelog, usage cross-ref, CI status; they are
spelled out in the workflow script). The fan-out is overhead for one PR.

**Multiple PRs**: run the `dep-triage` workflow — invoke it by scriptPath
(`.claude/workflows/dep-triage.js`), not by name (name resolution can be stale), passing
`args: { prs: [{number, title}, ...], mainCi: "<the A.5 one-liner>" }`. It fans out one
**read-only** worker per PR and returns one dossier each: semver delta, diff cleanliness,
breaking changes cross-referenced against our actual usage (file:line), deprecations,
security fixes, adoptable features, engine/peer-dep implications, CI status (baseline-aware:
failures matching `mainCi` are recorded but not re-analyzed), and `packageRisk`.

Treat each dossier as evidence, not verdict: `packageRisk` is deliberately CI-blind (you
combine it with CI state), and `ci.failureReadGuess` is a cheap-model hint. Any PR in
`failedPrs` gets triaged inline like the single-PR case.

## Phase C — Decide (inline, serial — one PR at a time)

Walk the dossiers in this order: `packageRisk: clean` merges first, then fix-then-merge
candidates, then escalations. **Never act on two PRs concurrently** — every npm PR touches
`package-lock.json`, so each merge rebases the siblings.

### 1. Decide — POLICY (combine `packageRisk` with CI state yourself)

- **Non-attribution rule**: a PR-CI red that matches the A.5 main baseline is
  **non-attributable** to the PR — it neither blocks nor validates that PR. If main is red,
  ask the user ONCE (batched, AskUserQuestion) whether to merge the clean PRs over the
  known-pre-existing red; never treat either answer as standing policy for future runs.
- ✅ **Auto-merge** when ALL hold: `packageRisk: clean`, and CI is green (or set to pass, or
  red only with baseline-matching failures the user approved merging over).
  → `gh pr merge <n> --squash --auto`. Prefer `--auto` so branch protection is respected.
  Green CI is the verification signal — it runs the same gates as a local checkout; do not
  check out green PRs locally.
- ⚠️ **Escalate (AskUserQuestion)** when ANY hold: **major** bump; breaking/deprecation note
  touching a path we use; any breaking change marked `securitySensitive` (always an
  escalation, regardless of semver); `diffAnomalies` non-empty; or a non-baseline CI failure
  that is a real code change (see step 2). Give the user a crisp recommendation + the
  evidence from the dossier.
- 🔧 **Auto-fix then merge** for **mechanical** non-baseline CI failures only (see step 2).

### 2. CI failures — POLICY: auto-fix mechanical, escalate real

Start from the dossier's `ci.logExcerpt` and `failureReadGuess`, but read the logs yourself
before acting (`gh pr checks <n>` / `gh run view <id> --log-failed`).

- **Mechanical** (fix, push, re-wait for green): lockfile drift / peer-dep resolution,
  test snapshot updates, a type signature that shifted, an ESLint/Prettier auto-fixable nit,
  a renamed export with a 1:1 replacement. This is the ONE case for local checkout:
  `gh pr checkout <n>`, make the fix, run the affected gates locally
  (`npm run lint && npm run typecheck && npm run test`), commit
  (`fix(deps): adapt to <pkg> <B>`), push, restore with `git checkout <original-branch>`,
  and re-monitor. Sequential only — never while another PR is mid-checkout or mid-merge.
- **Real** (STOP, escalate): behavior/logic changes, removed APIs with no drop-in, failing
  assertions that reflect changed semantics, anything security-relevant. Ask the user with
  the log excerpt and your read of it.

### 3. After every merge — overlap the rebases, refresh before acting

Immediately after each merge, comment `@dependabot rebase` on **all** remaining queue PRs so
their rebases run while you wait on the next one. The dossiers' changelog/usage analysis
stays valid, but `mergeable`/`mergeStateStatus` and CI go stale the moment a sibling merges.
Before acting on the next PR: `gh pr view <n> --json state,mergeable,mergeStateStatus` and
`gh pr checks <n>`; wait for the rebase + re-run rather than forcing. If Dependabot closes a
queued PR mid-train as **superseded by a newer version**, that's benign — count it as
handled and triage the successor PR next cycle, don't chase it now.

### 4. Adoptable new features — POLICY: open a tracking issue/todo

For each dossier `adoptableFeatures` entry, do NOT act on it in this PR. Instead:
`gh issue create --title "chore: evaluate <feature> from <pkg> <B>" --label enhancement --body "<what it is, where we'd use it, link to changelog>"`
If `gh issue create` isn't available/permitted, append a line to `TECH_DEBT.md` instead.

## Final report

Print a table: PR | pkg A→B | semver | usage impact | pkg risk | decision | CI | notes —
flag any row where your decision differs from what `packageRisk` alone would suggest, and why
(usually the CI axis).
Then list: merged, escalated (with the open questions), and tracking issues opened.

## Guardrails

- **Workers never mutate**: no checkout, no merge, no push, no file edits, no `npm ci`, no
  touching `data/`. All mutations happen here in Phase C, serially. (The workflow prompt
  enforces this too — but if a dossier reports it changed something, stop and tell the user.)
- Never merge a **major** bump without explicit user confirmation.
- Never merge while required checks are pending/failing (use `--auto`, don't force).
- Never edit `.github/workflows/`, `.env`, `infra/`, or `docs/architecture.md` to make a bump
  pass — those are protected; escalate instead.
- One PR's failure must not block triage of the others — continue and report.
