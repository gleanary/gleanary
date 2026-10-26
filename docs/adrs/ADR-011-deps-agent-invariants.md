# ADR-011: deps-agent Is Rebuilt Around Explicit Invariants

**Date**: 2026-10
**Status**: Accepted (Phase 0 in progress)

## Context

ADR-010 introduced deps-agent: an LLM assesses Dependabot PRs and a deterministic gate
decides whether to merge to production. Twelve review rounds of PR #45 kept finding real
issues, each fixed test-first, and each round found new ones. Some fixes produced the next
finding (the outage clock led to the flapping-source fix, which led to the cooldown clock
surviving an outage; capping coverage at `partial` led to a review that saw no code
passing).

Grouped, the findings fall into eight classes (listed in
[docs/deps/invariants.md](../deps/invariants.md)), each caused by one missing design
decision:

- A package's identity depended on where it sat in the lockfile.
- Review coverage was the model's own claim.
- Every wait had its own clock, some with no deadline.
- "Could not look" and "found nothing" looked the same.
- "The situation the owner saw" was computed in six places.
- Deciding and acting were interleaved in one function.
- Untrusted text was escaped per output.
- Production health was inferred from workflow results.

Most of these bugs only show across several runs (a re-ping, a clock that never resets, a
waiver that lapses), while the tests evaluated one run at a time on hand-built fixtures.

## Decision

1. **Eight invariants (I1 to I8 in `docs/deps/invariants.md`) are the design contract.**
   Each has one owner in the code, and a change that breaks one is a bug even when no
   scenario shows it yet.
2. **Test the invariants, not the findings.** A run-sequence simulator drives the real CLI
   through scripted sequences of runs (world state, owner comments, clock) and checks run
   properties (P1 to P8) after every run of every scenario. A corpus of real lockfile pairs
   from past Dependabot PRs checks the change set. A property the current code breaks is a
   skipped test naming its TECH_DEBT.md entry.
3. **Refactor in phases toward the target modules**, each a `feature-session` run in
   `refactor` mode (green baseline, preserved contract). Behavior changes come from
   TECH_DEBT.md, are listed per phase, and are made test-first:

   | Phase | Content                                                                      |
   | ----- | ---------------------------------------------------------------------------- |
   | 0     | invariants doc, this ADR, simulator, lockfile corpus, properties             |
   | 1     | `changes.mjs` (I1) and `facts.mjs` (I4)                                      |
   | 2     | `review.mjs`: coverage from the review manifest (I2)                         |
   | 3     | `waits.mjs`: one clock model with deadlines (I3)                             |
   | 4     | `identity.mjs` and the escalation state machine (I5)                         |
   | 5     | `decide.mjs` and `effects.mjs` (I6)                                          |
   | 6     | `encode.mjs` and a lint rule (I7)                                            |
   | 7     | production reports its commit; main is healthy only when it runs main's (I8) |

4. **Rollout.** The shadow week starts on the current code: shadow mode cannot merge, so the
   worst case is a wrong ping, and its records feed the scenario corpus. Merge mode needs
   Phases 0 to 5, the two pending workflow fixes (`!cancelled()` on the act job, `set -e` in
   the Deploy script), #43 (the `/data` mount) and a clean shadow week whose cases are in
   the simulator. Phase 7 is the strongest single safeguard and should follow soon after.
5. **New review findings are triaged into a phase** rather than patched on the side, unless
   one blocks shadow mode.

## Alternatives considered

- **Keep fixing findings as they come.** Twelve rounds show the rate does not fall: each fix
  adds state, which creates new interactions.
- **Rewrite from scratch.** Loses the tested behavior and the reasons behind it. The phased
  refactor keeps every existing test green and moves one invariant at a time.
- **Drop features to shrink the surface** (overrides, the trusted install-script list,
  transitive review). Each was added for a concrete risk or friction; the invariants make
  them cheaper to keep correct rather than removing them.

## Consequences

- The gate's code is mostly pure and table-testable after Phase 5; I/O lives in
  `facts.mjs`, `effects.mjs` and the CLI wiring.
- Merge mode starts later than if review fixes continued, but on a design whose classes of
  bugs are closed rather than sampled.
- The simulator becomes the place to reproduce any future incident: a finding is a scenario
  first, then a fix.
