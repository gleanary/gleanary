# deps-agent invariants

The rules deps-agent's design builds on. Each invariant has **one owner** in the code, and
the tests check the invariant itself, not just the cases past reviews found. Why these
invariants exist, and the plan to reach them, is in
[ADR-011](../adrs/ADR-011-deps-agent-invariants.md). How the agent works day to day is in
the [guide](README.md).

Twelve review rounds of PR #45 produced findings in eight classes. Each class came from one
missing design decision, so fixing instances never stopped the next one:

| Class                                                              | Invariant |
| ------------------------------------------------------------------ | --------- |
| A. A package's identity changed with where it sits in the lockfile | I1        |
| B. Review coverage was the model's own claim                       | I2        |
| C. Every wait had its own clock, some with no deadline             | I3        |
| D. "Could not look" and "found nothing" looked the same            | I4        |
| E. "The situation the owner saw" was computed in six places        | I5        |
| F. Deciding and acting were interleaved                            | I6        |
| G. Untrusted text was escaped per output, ad hoc                   | I7        |
| H. Production health was inferred from workflow results            | I8        |

`Status` below is the state of the code today. "Target" names the module that will own the
invariant after the refactor (ADR-011); until then the owner is the function named.

## I1. One change set, keyed by `name@version`

The lockfile diff yields one list of introduced versions. A version is _introduced_ when main
has no copy of that `name@version` anywhere. Each entry carries `name`, `version`,
`previous` (the base version at the same lockfile key, else the base copy of the same name,
else `null`), the lockfile locations, resolved URLs, the install-script claim, and whether
it is the PR's declared (direct) update. Where a package sits is an attribute, never its
identity. Every rule, the review and the cache key read only this list.

- Owner today: `diffLockfiles` (`gate.mjs`). Target: `changes.mjs`.
- Status: mostly holds since the tenth review. `added` and `newInstallScripts` are separate
  views rather than fields of the entries; `foreignSources` is per lockfile entry by design
  (a second copy of a version must not hide behind a clean first one).

## I2. The gate computes coverage; the model reports findings

`package-diffs` writes a review manifest: one entry per introduced version, with status
`reviewed`, `truncated`, `unreviewable` (binaries), `failed` or `over-budget`. Coverage is a
pure function of the manifest. A declared version must be reviewed. A version whose diff
failed waits on the outage clock (I3, I4). Versions over the budget make coverage partial.
The model's coverage claim is kept for information only.

- Owner today: `diffCoverage` (`cli.mjs`), which caps the model's claim. Target: `review.mjs`.
- Known gaps: a declared update with no diff target can still read `full`; a failed diff of a
  declared package next to a successful transitive one reads `partial` (passes); an `npm
diff` outage fails the review instead of waiting (TECH_DEBT.md).

## I3. Every wait comes from one module and has a deadline

A wait is `{reason, since, deadline, onExpiry}`. Its clock starts the first run that
observes the reason and resets when the reason disappears, the same way for every reason.
Clocks start at moments the agent observed, not at timestamps others wrote (a commit's
committer date is not a push time). There is no wait without a deadline: past it, the PR
escalates (or main counts as broken).

- Owner today: none; the clocks live in `evaluatePr` (`cli.mjs`: rebase, outage, cooldown)
  and in rules (`gate.mjs`: no CI, cancelled checks, cancelled main). Target: `waits.mjs`.
- Known gaps: the cooldown clock survives an outage; a PR whose assessment always fails waits
  forever; the no-CI-on-main timeout uses the committer date (TECH_DEBT.md).

## I4. Every external fact has three states

An external fact (registry document, malware advisories, audit, published diff, CI runs) is
either `ok` with a complete value (all pages read, the whole document fetched) or
`unavailable` with a reason. Rules never receive `null` or `[]` standing for "could not
look". `unavailable` becomes a wait under one outage reason (I3).

- Owner today: each fetcher in `cli.mjs` (`registryFact` encodes it as `registryError`,
  malware and audit as `null`, a failed diff as an `error` field). Target: `facts.mjs`.

## I5. One evaluation identity

One function gives the identity of an evaluated state: head SHA, change-set fingerprint,
policy hash, and each rule's stable key. The assessment cache key, waiver matching, override
binding and ping dedupe are projections of it. Escalation is a state machine per PR: `idle
→ escalated(identity) → idle` when the PR stops escalating, so the same failure coming back
pings again.

- Owner today: `assessmentKey`, `lockFingerprint`, `waiverKey`, `escalationFingerprint`
  (`gate.mjs`), plus `record.headSha` and `record.escalatedKey` (`cli.mjs`). Target:
  `identity.mjs`, with the state machine in `decide.mjs`.
- Known gap: `escalatedKey` is never cleared (TECH_DEBT.md).

## I6. Decide, then act

A pure function returns the outcome and an ordered list of effects (save record, label,
comment, ping, rebase request, merge) from the evaluation, the previous record, the mode and
the run's merge slot. One executor applies them in order, each with an idempotency marker,
and applies nothing after a failed effect. Mode is applied in one place: shadow mode removes
every effect that changes the PR or main.

- Owner today: `evaluatePr` (`cli.mjs`) decides and acts inline. Target: `decide.mjs` and
  `effects.mjs`.

## I7. One encoder per output

Untrusted text (changelogs, PR metadata, package code, lockfile fields) reaches an output
only through that output's encoder: the prompt, comment markdown, issue titles, CLI
arguments and the record payload. When the lockfile and the registry disagree about a fact
the registry publishes, the registry wins.

- Owner today: `neutralize` and `renderRecord` (`record.mjs`), function replacements in
  `prompt`, `schemaArg` (`cli.mjs`). Target: `encode.mjs`, plus a lint rule against
  template strings with untrusted fields outside it.
- Known gap: issue titles go through the markdown encoder (TECH_DEBT.md).

## I8. Production health is checked directly

main counts as healthy only when production reports running main's commit. Workflow results
(CI, Deploy) are hints for "still running" or "failed", never the proof of success.

- Owner today: `classifyMain` (`gate.mjs`) reads CI and Deploy conclusions. Target: a
  commit SHA served by the app's health endpoint and compared with main's head.
- Known gaps: the Deploy script lacks `set -e`, so a failed pull still reports success
  (TECH_DEBT.md); cancelled and skipped runs are handled one by one.

## Properties checked on every run

The run-sequence simulator (`__tests__/integration/deps-agent-sim.test.ts`, world in
`deps-agent-world.ts`) drives the real CLI through scripted sequences of scheduled runs
(plan, assess, act) and owner commands. P1 to P4 and P6 are checked after every run of every
scenario; P5 by freezing the world in one blocking state and running once a day; P7 by the
override scenarios; P8 on a corpus of real lockfile pairs from past Dependabot PRs
(`__tests__/mocks/fixtures/deps-lockfiles/`, trimmed to the packages that changed):

| #   | Property                                                                                                                          | Invariant |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | --------- |
| P1  | At most one merge per run                                                                                                         | I6        |
| P2  | No write that changes a PR or main in shadow mode (merge, rebase request, revert)                                                 | I6        |
| P3  | Never the same escalation message twice in a row, unless the PR left `escalate` in between; a failure that comes back pings again | I5        |
| P4  | Every introduced `name@version` appears in the review targets                                                                     | I1, I2    |
| P5  | A PR left in an unchanged world either merges or escalates within 15 days (no endless wait)                                       | I3        |
| P6  | Nothing is posted in a run whose record save failed                                                                               | I6        |
| P7  | An override applies only to the evaluated state it was written for                                                                | I5        |
| P8  | Every lockfile pair in the corpus yields its expected change set                                                                  | I1        |

A property the current code breaks is a skipped test that names its TECH_DEBT.md entry, and
the refactor phase that fixes it turns it on. At Phase 0 these are skipped: an assess job that
always fails (P5), a required check stuck in progress (P5), a failure that comes back after
recovering (P3), a declared package that was only nested before (P4), and the cooldown clock
surviving an outage (I3).
