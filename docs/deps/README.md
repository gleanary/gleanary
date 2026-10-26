# Dependency updates: how deps-agent works

Gleanary keeps its npm dependencies current without a human in the loop for routine
bumps. Dependabot opens the pull requests; **deps-agent** (a scheduled GitHub Actions
workflow) checks each one and merges the safe ones. A merge to `main` deploys to
production, so the agent only merges when every gate passes, and it asks a human
about everything else.

| You want to know…             | Read                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------- |
| How it works and what you do  | this page                                                                    |
| The exact merge rules (gates) | [`.github/deps-agent/policy.md`](../../.github/deps-agent/policy.md)         |
| Why it was built this way     | [ADR-010](../adrs/ADR-010-unattended-dependency-merges.md)                   |
| Versions we deliberately skip | `ignore` entries in [`.github/dependabot.yml`](../../.github/dependabot.yml) |
| The workflow itself           | [`.github/workflows/deps-agent.yml`](../../.github/workflows/deps-agent.yml) |

## In one minute

- Every **3 hours** the agent looks at open Dependabot PRs.
- For each PR whose CI has finished, **Claude reads the changelog against our code** and
  answers `merge` or `escalate`. Claude only has read access: it cannot merge, push or comment.
- A **deterministic gate** (plain code, no AI) then checks 19 rules: CI green, only
  `package.json`/lockfile changed, patch or minor version, release at least 7 days old,
  no malware advisory, nothing suspicious in the published code diff,
  npm provenance and publisher unchanged, no new install scripts or advisories, and more.
- If everything passes, the agent merges **at most one PR per run**, and only once the
  previous merge has passed CI on `main`, deployed, and answered the health check.
  Each production change therefore maps to a single dependency bump.
- If anything needs judgment, **you get a GitHub notification** with a question and a
  recommendation, and you answer with a `/deps` comment on the PR.
- If `main` breaks after one of its merges, the agent **stops merging**, opens a revert
  PR and pings you.

What you will see day to day:

| Where                          | What                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| Your GitHub notifications      | Only escalations and "main is broken" issues                     |
| **Dependency dashboard** issue | One row per open Dependabot PR and its current state             |
| Each Dependabot PR             | A **decision record** comment: gate results, assessment, history |
| `main` history                 | Squash merges with a `Merged-by: deps-agent` trailer             |
| Issues labeled `enhancement`   | New dependency features worth adopting (at most two per PR)      |

## How a PR travels

### 1. Happy path: a routine bump reaches production

```mermaid
sequenceDiagram
    autonumber
    participant DB as Dependabot
    participant CI as CI (ci.yml)
    participant P as Agent (plan)
    participant A as Agent (assess)
    participant C as Claude (read-only)
    participant G as Agent (gate and act)
    participant M as GitHub main
    participant DP as Deploy (deploy.yml)
    participant S as Production server

    DB->>CI: opens PR once the release is 7+ days old
    CI-->>DB: lint, type-check, tests, E2E all green
    Note over P: scheduled run, every 3 h
    P->>P: pick PRs whose CI finished and whose head commit has no assessment yet
    P->>A: one job per PR, up to 5 per run
    A->>A: collect facts: lockfile diff, npm registry, npm audit, malware feed
    A->>A: diff the published code of each updated package
    A->>C: facts, policy and instructions
    C->>C: read changelogs, search our code for affected APIs, review the code diff
    C-->>A: verdict merge, validated against a schema
    A-->>G: assessment file
    G->>G: evaluate the 19 gate rules
    G->>G: main healthy and no merge yet in this run?
    G->>M: squash-merge, pinned to the evaluated commit
    G->>G: update decision record and dashboard
    M->>CI: push to main runs CI again
    CI-->>DP: success triggers Deploy
    DP->>S: build image, pull, restart
    DP->>S: poll /api/health for up to 60 s
    S-->>DP: healthy, old images pruned
    Note over G,S: the next run sees main healthy and may merge the next PR
```

### 2. Escalation: the agent needs your decision

```mermaid
sequenceDiagram
    autonumber
    participant G as Agent (gate and act)
    participant PR as Pull request
    participant O as You
    participant K as Agent (command)

    G->>G: a hard or soft gate fails, e.g. a major bump
    G->>PR: label deps:needs-human
    G->>PR: new comment mentioning you: failing gates, question, recommendation
    PR-->>O: GitHub notification
    alt only soft gates fail and you accept the risk
        O->>PR: /deps merge
        PR->>K: comment event, accepted only from your login
        K->>PR: App comment recording the override for these package versions
        K->>G: start a run
        G->>G: re-run the gate, soft gates waived for those versions
        G->>PR: merge if hard gates pass and main is healthy, otherwise keep waiting
    else park it
        O->>PR: /deps hold reason
        K->>PR: label deps:hold, the agent ignores the PR until /deps unhold
    else you do not want this version
        O->>O: add an ignore entry with its reason to dependabot.yml
        Note over O,PR: Dependabot closes the PR and stops proposing that version
    end
    G->>PR: the next run appends your decision to the decision history
```

Hard gates (wrong author, files outside the lockfile, red CI, suspected prompt
injection…) cannot be overridden: fix the cause or close the PR.

### 3. Broken main: a merge breaks CI or production

```mermaid
sequenceDiagram
    autonumber
    participant M as GitHub main
    participant CI as CI and Deploy
    participant G as Agent (gate and act)
    participant I as Issue
    participant O as You

    M->>CI: deps-agent merge pushed to main
    CI-->>M: CI fails, or Deploy fails its health check
    Note over G: next scheduled run
    G->>G: main is broken: freeze every merge
    opt the breaking commit carries Merged-by: deps-agent
        G->>M: push branch deps-agent/revert-SHA and open a revert PR
    end
    G->>I: open "deps-agent: main SHA is broken", mentioning you
    I-->>O: GitHub notification
    O->>M: merge the revert PR once its CI is green
    M->>CI: CI, then Deploy of the previous version
    Note over G: a later run sees main healthy
    G->>I: comment and close the issue, merges resume
```

When CI fails on `main`, nothing was deployed and production is untouched. When the
health check fails, the new container is already running, so production stays degraded
until you merge the revert (or roll back by hand, see below).

### PR states

The decision record and the dashboard show one of these states:

```mermaid
stateDiagram-v2
    [*] --> waiting: PR opened
    waiting --> waiting: CI running, not assessed yet, conflict, main busy
    waiting --> needs_human: a hard or soft gate fails
    waiting --> would_merge: all gates pass, shadow mode
    waiting --> queued: all gates pass, another PR merged this run
    waiting --> merged: all gates pass, merge mode
    queued --> waiting: next run re-evaluates
    needs_human --> merged: /deps merge, soft gates only
    needs_human --> waiting: new commit (rebase or newer version)
    waiting --> held: /deps hold
    needs_human --> held: /deps hold
    held --> waiting: /deps unhold
    merged --> [*]
```

## Your role

### Reading an escalation

The escalation comment lists the failing gates, then Claude's question, recommendation
and options. The decision record above it has the full gate table and history. Typical
cases:

| Failing gate                         | Usually means                                                                                                                                                                                                                           | Typical answer                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `semver`                             | Major, or 0.x minor (no compatibility promise below 1.0)                                                                                                                                                                                | Read the breaking changes Claude found, then decide                                                  |
| `verdict`                            | Claude found a breaking change touching our code                                                                                                                                                                                        | Fix it in a follow-up PR, or hold                                                                    |
| `checks`                             | CI failed on the PR, or no CI ran 60 min after the commit                                                                                                                                                                               | Read Claude's `ciRead`, fix or close; if CI never ran, check the Actions tab                         |
| `cooldown`                           | A direct release younger than 7 days (often a security fix), or a publish time the registry didn't return. Young _transitive_ versions don't escalate: the PR waits until they age                                                      | `/deps merge` if the fix matters, otherwise wait                                                     |
| `malware`                            | GitHub lists the new version as malware                                                                                                                                                                                                 | Close the PR; check nothing installed it elsewhere                                                   |
| `codeReview`                         | Claude found suspicious code in the published diff, or its review saw no code although there were diffs                                                                                                                                 | Read the finding and the diff before anything else; for "saw no code", check the assess job log      |
| `publisher` / `provenance`           | The package was published differently than last time: a different npm account, provenance dropped, or a different source repository                                                                                                     | Check the package's repo and npm page before merging; a source-repo change is a strong hijack signal |
| `installScripts`                     | A package gained an install script, a package that runs one changed version, or a trusted one (`better-sqlite3`, `esbuild`, `msw`, `unrs-resolver`) changed its install command or lost provenance. The script runs in the Docker build | Check what the script does now and that the code review covered it; native modules are usually fine  |
| "Why now: has not rebased"           | Dependabot ignored deps-agent's rebase request for 24 h                                                                                                                                                                                 | Comment `@dependabot rebase` yourself                                                                |
| `cooldown` after 14 days             | Young transitive versions kept the PR waiting for 14 days (a fast-moving dependency can reset the clock on every rebase)                                                                                                                | `/deps merge` to take it as is (it waives this failure), or `/deps hold`                             |
| "Why now: a source has not answered" | The npm registry, the malware feed or `npm audit` kept failing for this PR for 48 h, so part of it is unchecked                                                                                                                         | Check the package on npm, then `/deps recheck`, or `/deps hold`                                      |
| `author` / `sources`                 | The head commit is not a signed Dependabot commit, or a version resolves from somewhere other than registry.npmjs.org                                                                                                                   | Hard gates: find out who changed the branch, or close the PR                                         |
| `injection`                          | Changelog or PR text tried to instruct the agent                                                                                                                                                                                        | Treat the release as suspicious; close or wait                                                       |

### Commands

Comment on the Dependabot PR. Only the login in `DEPS_AGENT_OWNER` is obeyed.

| Command               | Effect                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/deps merge`         | Waive the soft gates that are failing now, each for its current reason, for exactly this state (versions and lockfile), and merge if everything else passes. Pending gates are never waived (wait for the review). Refused if the PR changed since its last evaluation. A rebase that changes the lockfile, a new failing gate, or a waived gate failing for another reason asks you again |
| `/deps hold <reason>` | Label `deps:hold`; the agent leaves the PR alone                                                                                                                                                                                                                                                                                                                                           |
| `/deps unhold`        | Remove the hold                                                                                                                                                                                                                                                                                                                                                                            |
| `/deps recheck`       | Run a fresh assessment of this PR now. The request is kept until a fresh assessment is stored, even if the run is cancelled                                                                                                                                                                                                                                                                |

Commands never merge on their own. Each one leaves a durable trace (an App comment
naming the approved versions, or the `deps:hold` label) and starts a run; that run's gate
does the merging. Two quick commands in a row are both kept. An override cannot be withdrawn;
`/deps hold` does that job (a held PR never merges, override or not).

Dependabot's own commands still work: `@dependabot rebase`, `@dependabot close`,
`@dependabot ignore this major version`.

### Decisions that outlive a PR

- **"Not this version"** (e.g. hold eslint 10 until typescript-eslint supports it): add
  an `ignore` entry to [`.github/dependabot.yml`](../../.github/dependabot.yml), with a
  comment giving the reason and when to revisit. Dependabot never opens a PR for it, so
  the agent never sees it, and git history records who decided and when. Delete the
  entry when the reason no longer holds.

  ```yaml
  ignore:
    # typescript-eslint does not support eslint 10 yet. Revisit when it does. (2026-10)
    - dependency-name: 'eslint'
      versions: ['>=10']
  ```

  Prefer this to `@dependabot ignore this major version`: that comment works, but the
  rule lives only on GitHub, with no reason attached.

- **Big decisions** (replacing a library, pinning a framework for months): write an ADR
  in [`docs/adrs/`](../adrs/).

- **"Always ask me before bumping package X"** is not supported yet. Majors, 0.x minors
  and breaking changes that touch our code already escalate. If a real case comes up,
  the plan is an `ALWAYS_ESCALATE` list in `gate.mjs`, checked by a soft gate.

## Runbooks

### Enable the agent

1. Create a GitHub App with repository permissions **Contents, Pull requests, Issues,
   Actions: read & write** and **Checks: read**, then install it on the repository.
   Merges need the App token: merges made with the default `GITHUB_TOKEN` do not
   trigger the CI run on `main` that Deploy waits for.
2. Repository secrets: `ANTHROPIC_API_KEY` (a dedicated key with a spend limit) and
   `DEPS_AGENT_APP_KEY` (the App's private key).
3. Repository variables: `DEPS_AGENT_APP_ID`, `DEPS_AGENT_APP_SLUG`,
   `DEPS_AGENT_OWNER` (your login), `DEPS_AGENT_MODE=shadow`, optionally
   `DEPS_AGENT_MODEL` (defaults to `claude-opus-5-5`).
4. Protect `main` with a ruleset requiring the four CI checks.
5. Run it once by hand: Actions → Deps agent → Run workflow.

### Switch from shadow to merge

In `shadow` mode the agent does everything except merge: PRs it would merge show
**would merge**. After one or two weeks, compare those rows with what you would have
done. When they agree, set `DEPS_AGENT_MODE=merge`.

### Stop everything

Set `DEPS_AGENT_MODE=off`: the next run does nothing. For an immediate stop, also
disable the workflow (Actions → Deps agent → ⋯ → Disable workflow). Open PRs and their
records stay as they are.

### Roll back a bad merge

- **CI or health check failed:** the agent opens a revert PR on its own. Merge it once
  its CI is green; Deploy ships the previous version.
- **Production misbehaves but every check is green** (a bug our tests miss): revert the
  squash commit through a normal PR, then add a `dependabot.yml` `ignore` entry for the
  bad version, with the reason.
- **Need production back before CI finishes:** on the server, a failed health check
  leaves the previous image in place (untagged). Find it with `docker images`, re-tag it
  `ghcr.io/gleanary/gleanary:latest`, then `docker compose up -d` in `/opt/gleanary`.

### Re-assess a PR

Comment `/deps recheck`, or run the workflow by hand with the `pr` input. Editing
`policy.md`, `prompt.md` or `assessment.schema.json` changes the policy fingerprint, so
every open PR is re-assessed over the next runs (up to five per run).

### When the agent itself fails

A PR whose assessment or evaluation errors stays **waiting**; the dashboard shows
`error` with the message, and the failed job is in the Actions tab. One PR's failure
never blocks the others.

## Reference

- **Gates and escalation rules:** [`policy.md`](../../.github/deps-agent/policy.md).
  The agent reads it at runtime, so it is the single source.
- **Code:** [`gate.mjs`](../../.github/deps-agent/gate.mjs) (rules, unit-tested in
  `__tests__/unit/deps-gate.test.ts`), [`cli.mjs`](../../.github/deps-agent/cli.mjs)
  (GitHub and npm I/O), [`record.mjs`](../../.github/deps-agent/record.mjs) (comments),
  [`prompt.md`](../../.github/deps-agent/prompt.md) and
  [`assessment.schema.json`](../../.github/deps-agent/assessment.schema.json) (Claude's
  instructions and output format).
- **Dependabot settings:** [`.github/dependabot.yml`](../../.github/dependabot.yml): weekly,
  7-day cooldown (none for security updates), dev patch/minor bumps grouped.
- **Hands-on triage:** the `/babysit-deps` Claude Code command uses the same policy.
- **Architecture context:** [`architecture.md` §9.5](../architecture.md#95-dependency-updates-deps-agent).
- **Cost:** one Claude assessment per set of package versions. A Dependabot rebase reuses
  it (every gate is still re-checked on the new commit); a newer version, a policy edit or
  a CI result turning red triggers a new one. Expect roughly $0.40–$1.50 per assessment
  on Claude Opus 5.5, and set a monthly spend limit on the dedicated API key.
