# ADR-012: Dependency Updates Escalate Only What Cannot Be Explained

**Date**: 2026-10
**Status**: Accepted (`/babysit-deps` now; deps-agent in the ADR-011 refactor phases below)

## Context

ADR-010 made deps-agent escalate every major bump (0.x minors included) and every failing
soft supply-chain rule. In the first shadow runs most escalations were not questions for the
owner but work an agent could do: a major whose breaking changes do not touch our code, a
provenance or publisher change with a benign cause (a repository redirect, a move to npm
trusted publishing), a review flag that a read of the release notes explains. The owner
wants escalations to mean "a human must decide", not "something changed".

ADR-010's main safety property still holds: the model only assesses, the deterministic
gate is the only writer, so prompt injection in upstream text can at worst cause an
escalation.

## Decision

1. **Hard stops** (always escalate, never resolved by an agent), for any version a PR
   introduces: a malware advisory; a package source other than `registry.npmjs.org`; a new
   or changed install script (a package gains one, or its install command differs from the
   previous version's); a publisher change to a human account that was not a maintainer of
   the previous version; `npm audit signatures` failing.
2. **Investigate, then resolve or escalate**: provenance or source-repository changes,
   publisher changes between bot accounts, cooldown edge cases, and the soft rules' flags.
   The root cause (repository redirect, attestation, registry signatures, release notes)
   is found and recorded as evidence; only what cannot be explained escalates. In deps-agent
   these resolvers are deterministic code in the gate (GitHub API redirects, npm
   attestations, `npm audit signatures`, trusted-publishing provenance), not the model's
   judgment, so the safety property above is unchanged.
3. **Majors are migrations, not stops.** Read the migration guide, map every breaking change
   to our usage (`file:line`), apply the changes, run the full suite including E2E.
   Escalate only for a product decision: a change users would see, a data migration, or
   security-relevant semantics that no test covers.
   - `/babysit-deps` (run in the owner's session) migrates and merges when every affected
     usage is covered and CI is green.
   - deps-agent (unattended) merges a major unattended only when the mapped breaking
     changes touch none of our code and the full suite is green. When our code must change,
     it migrates on its own branch, runs the suite, and opens a ready PR: the owner reviews
     only our-code diff and approves with `/deps merge`. A model that read
     attacker-writable text never ships our code without a human seeing it.
4. **Pre-authorized for `/babysit-deps`**: pushing non-Dependabot commits to a PR branch
   (merging `main` in, aligning peer packages, migrations), merging over `deps:needs-human`
   once its causes are resolved, removing that label after the merge, closing duplicate
   feature issues.

## Rollout in deps-agent (ADR-011 phases)

- Phase 1 (`facts.mjs`): attestation, signature (`npm audit signatures`) and
  repository-redirect facts; the hard-stop list becomes the hard rules.
- Phase 2 to 4: the resolvers, with each resolution recorded as evidence in the decision
  record; `semver` stops being a failing rule and routes majors to the migration path.
- After Phase 5 (`effects.mjs`): the migration job, with a write token scoped to its own
  branch, and the ready-PR flow.

Until then deps-agent keeps ADR-010's behavior; `/babysit-deps` already follows this ADR.

## Alternatives considered

- **Fully unattended migrations with guards** (diff limited to mapped files, no
  security-sensitive paths, an independent review that sees only our diff): rejected for
  now. An injected but plausible change that passes the tests would ship to production.
- **Keep escalating majors in deps-agent**: simpler, but leaves the owner doing work an
  agent can do and makes escalations noise.

## Consequences

- Escalations become rarer and each one is a real decision, with the evidence attached.
- `/babysit-deps` runs new package code on the laptop more often (migrations need a local
  checkout); its local-execution fence still applies, so that happens only once no hard stop
  applies and every flag is resolved.
- deps-agent gains its first job that writes code. It is scoped to its own branch and
  cannot merge what it wrote.
