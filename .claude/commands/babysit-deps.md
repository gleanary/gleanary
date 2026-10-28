---
description: Triage, verify, and merge open Dependabot PRs — fan out read-only dossier workers per PR, then decide serially: hard-stop only on real supply-chain red flags, investigate and resolve the rest, migrate majors yourself (map breaking changes to our code, apply, run the full suite), escalate only product decisions, and open tracking issues for adoptable new features.
argument-hint: '[PR number, or blank for all open dependabot PRs]'
allowed-tools: Bash, Read, Grep, Glob, WebFetch, AskUserQuestion, Edit, Write, Workflow
---

# Babysit Dependabot PRs

> **Unattended counterpart:** `.github/workflows/deps-agent.yml` runs this triage every 3 h
> with the shared policy in `.github/deps-agent/policy.md` (deterministic gate, one merge per
> run, decision records on each PR). Use this command for hands-on triage. Before merging
> by hand, read the PR's deps-agent decision record, and never merge a PR labeled
> `deps:hold`. This command goes further than the agent: it resolves the agent's soft
> escalations itself when it can explain them, and it migrates majors (policy below).

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

**Supply-chain checks: a failure is a question to investigate, not an automatic stop**,
except for the hard stops.

- 🛑 **Hard stop (escalate, never resolve yourself)** when ANY holds for a version the PR
  introduces (direct or transitive):
  - a malware advisory:
    `gh api -X GET /advisories -f type=malware -f ecosystem=npm -f affects=<pkg>@<version>`
    is not `[]`;
  - a package source other than `registry.npmjs.org` (any added or changed lockfile entry
    whose `resolved` URL points elsewhere);
  - a new or changed install script: a package gains `hasInstallScript`, or its install
    command differs from the previous version's (`npm view <pkg>@<v> scripts`);
  - a publisher change to an unknown human account: the new version's `_npmUser` is a
    person who is not among the previous version's `maintainers`
    (`npm view <pkg>@<old> maintainers`);
  - `npm audit signatures` failing. Run it in a scratch directory outside the repo, never
    in the checkout: copy the PR's `package.json` and `package-lock.json` there, then run
    `npm ci --ignore-scripts` (downloads only, runs no package code) and
    `npm audit signatures`.
- 🔎 **Investigate and resolve yourself**: provenance or source-repo changes, publisher
  changes between bot accounts (e.g. a move to npm trusted publishing from GitHub Actions),
  cooldown edge cases, and every flag from deps-agent's soft rules (its decision record,
  including `codeReview` findings and an `escalate` verdict). Find the root cause: a repo
  redirect (`gh api repos/<old-owner>/<old-repo> --jq .full_name` names the new repo), an
  attestation (`npm view <pkg>@<v> dist.attestations`), registry signatures (the
  `npm audit signatures` check above), the release notes. If it is benign, record the evidence in the final
  report and continue. If you cannot explain it, escalate with what you found.

**Major bumps (including 0.x minors) are never a reason to stop on their own.**

- 🔧 **Migrate**: read the migration guide and the changelog for every version in between,
  map every breaking change to our usage (`file:line`; the dossier's `breakingChanges`
  is the starting point, verify it with Grep), apply the changes on the PR branch (local
  checkout, after the local-execution fence in step 2), and run the full suite including
  E2E (`npm run lint && npm run typecheck && npm run test && npx playwright test`). Commit
  (`fix(deps): migrate to <pkg> <B>`) and push. **Merge** when every affected usage is
  covered and CI is green.
- ⚠️ **Escalate (AskUserQuestion) only for a product decision**: a change users would see,
  a data migration, or security-relevant semantics (auth, sanitization, URL validation,
  crypto) that no test covers. Give a crisp recommendation and the evidence.

- ✅ **Merge** (`gh pr merge <n> --squash --auto`, so branch protection is respected) when no
  hard stop applies, every investigated flag is resolved with recorded evidence, any
  migration is applied, and CI is green (or red only with baseline-matching failures the
  user approved merging over). Green CI is the verification signal for PRs that need no
  code change — do not check those out locally. A `deps:needs-human` label is no blocker
  once you have resolved its causes; remove it after the merge
  (`gh pr edit <n> --remove-label deps:needs-human`).

### 2. CI failures — POLICY: fix mechanical failures and migrations, escalate product decisions

Start from the dossier's `ci.logExcerpt` and `failureReadGuess`, but read the logs yourself
before acting (`gh pr checks <n>` / `gh run view <id> --log-failed`).

- **Mechanical or migration** (fix, push, re-wait for green): lockfile drift / peer-dep resolution,
  test snapshot updates, a type signature that shifted, an ESLint/Prettier auto-fixable nit,
  a renamed export with a 1:1 replacement. This is the ONE case for local checkout, and it
  must pass the **local-execution fence** first (below): `gh pr checkout <n>`, install with
  `npm ci --ignore-scripts`, then `npm rebuild better-sqlite3` (the only install script we
  rely on; skip the rebuild if the bump IS better-sqlite3 and escalate instead), make the
  fix, run the affected gates locally
  (`npm run lint && npm run typecheck && npm run test`), commit
  (`fix(deps): adapt to <pkg> <B>`), push, restore with `git checkout <original-branch>`,
  and re-monitor. Sequential only — never while another PR is mid-checkout or mid-merge.
  Breaking changes from a major bump follow the same path (step 1, Migrate).
- **Product decision** (STOP, escalate): a failure that reflects a change users would see,
  a data migration, or security-relevant semantics no test covers. Ask the user with the
  log excerpt and your read of it. A removed API or changed semantics with a clear
  replacement in the migration guide is a migration, not a stop.

**Local-execution fence.** Checking out a PR and running npm or the tests executes the new
package code on this laptop, which holds real credentials (`.env`, SSH keys, the `gh`
token). A compromised release would run here before any gate sees it. Check out and run a
PR locally ONLY when all of these hold for its current head commit:

1. No hard stop applies (step 1), and the PR's deps-agent decision record (the comment by
   the deps-agent App) shows `cooldown`, `malware`, `installScripts`, `provenance`,
   `publisher` and `codeReview` passing for this head SHA, or each one failing has been
   investigated and resolved with recorded evidence (step 1). Without a current record,
   check it yourself:
   - every updated version is at least 7 days old (`npm view <pkg> time --json`);
   - no malware advisory: `gh api -X GET /advisories -f type=malware -f ecosystem=npm -f affects=<pkg>@<version>`
     returns `[]` for each updated version;
   - no lockfile entry that is added or changes version has `"hasInstallScript": true`
     (check the entry in the new lockfile, not just the diff: a version bump of a package
     that already runs a script leaves that line unchanged).
2. You install with `--ignore-scripts`, as above.

If any check fails, do NOT check out. Escalate to the user with the proposed fix as a patch
in your message, and let CI (which has no secrets) be the only place the new code runs.

### 3. After every merge — overlap the rebases, refresh before acting

Immediately after each merge, comment `@dependabot rebase` on **all** remaining queue PRs
that only carry Dependabot's commits, so
their rebases run while you wait on the next one. The dossiers' changelog/usage analysis
stays valid, but `mergeable`/`mergeStateStatus` and CI go stale the moment a sibling merges.
Before acting on the next PR: `gh pr view <n> --json state,mergeable,mergeStateStatus` and
`gh pr checks <n>`; wait for the rebase + re-run rather than forcing. If Dependabot closes a
queued PR mid-train as **superseded by a newer version**, that's benign — count it as
handled and triage the successor PR next cycle, don't chase it now.
Dependabot stops rebasing a PR once it carries someone else's commits (and
`@dependabot recreate` would drop them): for a PR you pushed to, merge `main` into it
yourself instead.

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
- Never run a PR's dependency code on this machine unless it passed the local-execution
  fence (step 2).
- **Pre-authorized** (no need to ask): pushing non-Dependabot commits to a PR branch
  (merging `main` in, aligning peer packages, migration changes); merging over a
  `deps:needs-human` label once you have resolved its causes; removing that label after
  the merge; closing duplicate feature issues.
- Never merge a PR labeled `deps:hold`, and never resolve a hard stop yourself.
- Never merge while required checks are pending/failing (use `--auto`, don't force).
- Never edit `.github/workflows/`, `.env`, `infra/`, or `docs/architecture.md` to make a bump
  pass — those are protected; escalate instead.
- One PR's failure must not block triage of the others — continue and report.
