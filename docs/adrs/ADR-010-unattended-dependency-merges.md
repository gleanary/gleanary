# ADR-010: Unattended Dependabot Merges to Production

**Date**: 2026-10
**Status**: Accepted (rolls out in `shadow` mode first)

## Context

`/babysit-deps` triaged Dependabot PRs well, but only when run from the owner's laptop. A merge
to `main` deploys to production (`deploy.yml`), the repository is public, and Dependabot PRs
carry third-party text (changelogs, release notes) that an LLM reads. The owner accepts
unattended production merges provided security and quality gates give enough confidence.

Dependabot itself never merges: `dependabot.yml` has no auto-merge setting, so merging is
always a workflow's (or a human's) decision.

## Decision

Run the babysitter as a scheduled GitHub Actions workflow (`deps-agent.yml`) split by trust:

1. **The LLM assesses, a deterministic gate permits.** The assessment job holds only a read-only
   `GITHUB_TOKEN` and no `id-token`; it returns `merge` or `escalate` as a schema-validated
   artifact. A separate job without an LLM evaluates `gate.mjs` and is the only holder of a
   write token. Prompt injection can at worst cause an escalation.
2. **Supply-chain gates beyond CI** (see the threat model below): a 7-day cooldown, the GitHub
   malware feed, Claude's review of the published code diff, npm provenance not dropped, same
   publisher, no new install scripts, bounded new transitive packages, no new `npm audit`
   advisories, `package.json` changed only in declared ranges.
3. **0.x minors count as majors**, and majors always need the owner.
4. **One merge at a time, gated on production health.** A merge waits until the previous
   merge's CI on `main`, Deploy and a post-deploy `/api/health` check have succeeded. A broken
   `main` freezes merges, and a revert PR is opened when a deps-agent merge caused it.
5. **A GitHub App token performs merges**, because merges made with `GITHUB_TOKEN` do not
   trigger the push CI run that Deploy depends on.
6. **The agent records decisions on GitHub and never commits:** a sticky decision-record
   comment per PR (written only by the App, so forged records are ignored) and a dashboard
   issue. Bot commits to `main` would themselves deploy. Decisions that outlive a PR are
   made by a human: skipped versions are `ignore` entries in `dependabot.yml` (each with
   a comment giving the reason, enforced by Dependabot itself), and big decisions are ADRs.
   A free-form decisions file read by the model was rejected: only the LLM would enforce it.
7. **Assessments are cached per dependency state, not per commit.** The cache key is the
   set of `name@version` the PR moves to (from Dependabot's commit metadata, which a rebase
   keeps), a fingerprint of every version the lockfile introduces, the fingerprint of
   `policy.md`, `prompt.md` and the output schema, and whether CI is green or red. Serial
   merges make Dependabot rebase every sibling PR after each merge. Keyed on the commit,
   eight PRs could cost 30+ assessments in a week; keyed on the dependency state, about
   eight. A rebase that leaves the lockfile alone reuses the assessment. One that re-resolves
   it (new transitive versions the code review never saw) gets a fresh one. Every gate is
   still re-evaluated without AI on each commit, and a CI result turning red changes the key.
8. **An owner override approves one evaluated state.** `/deps merge` records the declared
   versions, the lockfile fingerprint and the soft rules failing in the last evaluation, and
   it refuses if the PR changed since then (Dependabot can push a newer version after the
   escalation). Only those rules are waived, each only while it fails for the reason the
   owner saw, and only for that lockfile; a rule that was merely pending is never waived.
   A rebase that brings in different dependency versions, a soft rule that starts failing
   later, or a waived rule failing for another reason escalates again, with an explanation.
   Two earlier versions were too broad: the first waived every soft rule for the declared
   versions (a rebase could slip a new transitive problem past the owner); the second also
   waived pending rules, so an override given before the review ran covered whatever the
   review found.
9. **Roll out in `shadow` mode first.** Shadow mode runs everything (assessments, gates,
   decision records, escalations, the dashboard) except the merge: a PR that would merge
   shows "would merge" instead. The owner compares those verdicts with their own judgment
   before setting `DEPS_AGENT_MODE=merge`.

## Threat model: a compromised dependency release

The scenario that matters most: an attacker takes over a maintainer account or release
pipeline and publishes a malicious patch or minor of a production dependency. Recent npm
incidents show both shapes: payloads that run at install time (the 2025 Shai-Hulud worm)
and runtime code injected into the library itself (the September 2025 `chalk`/`debug`
hijack, pulled within hours). Most are caught within days. Some are not (`event-stream`,
2018, about two months).

The hijacked version usually does not arrive as the package Dependabot bumps. It arrives as
a **transitive** dependency: Dependabot's cooldown only delays the package it bumps, and
when it rebuilds the lockfile, that package's dependencies can resolve to versions
published minutes earlier. That is how the `chalk`/`debug` versions reached most projects.
So every layer below states which versions it covers. "Introduced versions" means every
version the lockfile adds or changes, direct or transitive.

| Layer                                                                                            | Scope                                                                                                                                                                                             | Catches                                                                                                                                                                                                                                                | Misses                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependabot cooldown (7 days)                                                                     | Direct only                                                                                                                                                                                       | Direct releases pulled within a week                                                                                                                                                                                                                   | Everything transitive                                                                                                                                                |
| Gate cooldown (7 days, publish time from the registry)                                           | All introduced versions. A young transitive version **waits** until it ages, so routine bumps don't escalate                                                                                      | Releases caught and pulled within a week, including transitive ones                                                                                                                                                                                    | Attacks nobody notices for a week                                                                                                                                    |
| GitHub malware feed (hard gate)                                                                  | All introduced versions                                                                                                                                                                           | Anything listed as malware during the cooldown                                                                                                                                                                                                         | Unlisted releases                                                                                                                                                    |
| Claude's review of the published code diff (`npm diff`, size- and time-capped, binaries skipped) | Direct packages, plus up to 10 transitive versions (install-script packages first)                                                                                                                | New network calls, `eval`/`child_process`, credential reads, obfuscated code, unannounced changes                                                                                                                                                      | Payloads in large compiled bundles or binaries beyond the cap, and transitive versions past the first 10 (coverage is reported, `partial` when anything was skipped) |
| Provenance rule                                                                                  | All introduced versions: attestation present, and the same `repository.url` as the previous version (npm only accepts a provenance publish whose `repository.url` matches the attestation's repo) | A stolen npm token used outside the maintainer's CI, including one publishing with provenance from the attacker's own repo (the source repo changes)                                                                                                   | A compromised maintainer CI (valid provenance, same repo); packages that never had provenance                                                                        |
| Publisher rule                                                                                   | Direct only (transitive maintainer changes are too common to escalate on)                                                                                                                         | A different npm account                                                                                                                                                                                                                                | The maintainer's own hijacked account; anything transitive                                                                                                           |
| Install-script rule                                                                              | All introduced versions: a package that gains a script, or a new version of one that already runs a script                                                                                        | Install-time payloads. A trusted package (`better-sqlite3`, `esbuild`, `msw`, `unrs-resolver`) passes only with an unchanged install command and provenance on both versions, so a hijack that changes the command or loses provenance still escalates | Runtime payloads; a compromised maintainer CI that keeps the command and changes the script's file (left to cooldown and the code review)                            |
| CI, E2E, health check                                                                            | Whole tree                                                                                                                                                                                        | Payloads that break behavior                                                                                                                                                                                                                           | Quiet payloads                                                                                                                                                       |

Where the code runs before the gate: PR CI executes it, but Dependabot-triggered runs have a
read-only token and no secrets. The owner's laptop was the larger exposure: `/babysit-deps`
used to check out PRs and run `npm ci` and the tests. It now does so only when the release
passes the same cooldown, malware and install-script checks, and always installs with
`--ignore-scripts`.

The assessment itself reads attacker-controlled text (changelogs, package code), so its tools
are fenced: file reads stay inside the repository (no `/proc/self/environ`, where the API key
lives), web fetches are limited to github.com, raw.githubusercontent.com and www.npmjs.com,
and no tool can reach an arbitrary host (`npm view --registry=<url>` was removed for that
reason; package repository URLs come from the registry facts instead). The fence is built
from path-scoped allow rules (`Read(./**)`, `Grep(./**)`, `Glob(./**)`) plus a few explicit
denies. It must never deny `/home` or `~`: GitHub runners check out under
`/home/runner/work`, and a deny rule beats every allow rule, so the model would be blind to
its own checkout. A first version did exactly that and was caught in review. A test now
renders the real flags and checks them against a runner checkout path. Because a blind
review reports `coverage: "none"` with no findings, the gate also fails `codeReview` on
coverage "none" whenever there were version changes to review.

**Residual risk.** A careful attacker who stays unlisted for a week and hides the payload in
code the review cannot see in full (a large bundle, a binary, or a transitive version past
the first ten) still gets through. A human approving a green PR would
let the same release through, so the agent raises the bar rather than lowering it. The
remaining defense is limiting what a payload can do once deployed (next section).

## Runtime hardening (proposed, not implemented)

Code inside the app process can read whatever the app can: `process.env` (including
`SETTINGS_ENCRYPTION_KEY`) and the database with the encrypted provider keys. Hardening
cannot hide those. It limits what else a payload can reach, whether it can persist, and how
much it can exfiltrate. Current state: the container starts as root, `start.sh` chowns
`/data` and drops to uid 1001 with `su-exec`, the root filesystem is writable, default
capabilities apply, there are no resource limits, and outbound traffic is unrestricted.

Each step below keeps Gleanary working (it must still fetch arbitrary feed and article URLs,
reach the AI providers, and poll IMAP for newsletters), in order of risk:

1. **Resource limits** (no breakage risk): `mem_limit` around 1.5 GB (the heap is capped at
   1 GB for PDF parsing), `pids_limit: 256`, a `cpus` cap. Limits crypto-mining and fork bombs.
2. **Never run as root, drop capabilities**: `USER nextjs` in the Dockerfile, remove the
   `chown` and `su-exec` from `start.sh`, and add `cap_drop: [ALL]` and
   `security_opt: [no-new-privileges:true]` in compose. Node binds port 3000, so no
   capability is needed. One-time prerequisite on the server:
   `chown -R 1001:1001 /opt/gleanary/data`, otherwise the app cannot write its database.
3. **Read-only root filesystem**: `read_only: true`, with `tmpfs` for `/tmp` and
   `/app/.next/cache` (Next.js image and fetch caches, rebuilt after a restart). A payload
   can then no longer modify the app's code or persist outside `/data`. Prerequisite: the
   server's compose file bind-mounts only `/opt/gleanary/data/db`. The TTS cache and PDF
   originals live in the anonymous volume created by the Dockerfile's `VOLUME /data`, which
   survives `docker compose up` but is orphaned by a `down`/`up` and is not backed up.
   Bind-mount the whole `/opt/gleanary/data` to `/data` first. That fix is worth doing on
   its own, since unattended merges make deploys more frequent. Then verify PDF import,
   TTS and the E2E suite against the hardened container.
4. **Egress limits that keep feed fetching working**: a host allowlist is impossible
   (Gleanary fetches arbitrary URLs), but two host firewall rules on the container's network
   (the `DOCKER-USER` iptables chain, provisioned through `infra/` cloud-init) are safe:
   - allow outbound TCP only to ports 53, 80, 443 and the configured IMAP port (993 by
     default). This blocks reverse shells, mining pools and SMTP on other ports;
   - block private ranges and the cloud metadata address (`169.254.169.254`, `10.0.0.0/8`,
     `172.16.0.0/12`, `192.168.0.0/16`), apart from the Docker network Caddy uses. The app's
     `validateUrl()` already blocks these for URLs it fetches, but a payload bypasses app
     code and would not bypass the host firewall.

   Exfiltration over HTTPS remains possible; these rules only close the cheap channels.

5. **Smaller runtime image**: remove `npm`/`npx` from the runner stage (only `node` is
   needed at runtime) and pin the base image by digest.
6. **Recovery**: keep provider-key rotation ready (the key-rotation tool is tracked in the
   public issue tracker), so a suspected compromise ends with rotated keys, not just a revert.

Steps 1 and 5 change `docker/Dockerfile` and `scripts/start.sh`. Steps 1 to 4 also change
the server's compose file and firewall, both provisioned by `infra/cloud-init.yml` (the
server does not use `docker/compose.yml`), so they need applying on the existing server too.
Each should be its own `SESSION: infra`, reviewed before apply, with feed polling, IMAP
ingestion, PDF import and TTS checked afterward. Tracked in
[#43](https://github.com/gleanary/gleanary/issues/43).

## Cost and model choice

Assessments run on Claude Opus 5.5 ($4 / $20 per million input / output tokens, $0.20 for
cache reads). One assessment is about 10–20 agent turns, with a context growing to roughly
80K tokens when it reads a capped code diff: about $0.40 for a small package, $0.75
typical, up to $1.50 for a large one such as `next`. With the cache, that is roughly
$20–30 a month at current PR volume. A monthly spend limit on the dedicated API key is the
hard ceiling; hitting it fails safe (assessments fail, PRs wait, nothing merges unreviewed).

**Considered: Opus delegating to Sonnet.** `claude-code-action` runs Claude Code, which
supports subagents (`.claude/agents/*.md` with `model: sonnet`). The design:

- Claude Sonnet 5.5 subagents do the bulk reading: changelog research and usage search
  (returning `file:line` references and changelog quotes), CI failure reads, and adoptable
  features.
- The Opus main loop spot-checks their evidence (opens cited `file:line`s and quotes)
  before trusting a summary, reviews the published code diff itself, and writes the verdict
  and escalation question.
- A deterministic pre-scan of the diffs (network calls, `eval`, `child_process`, environment
  reads, long base64 strings) points Opus at the riskiest hunks first, and adds a signal
  that does not depend on any model.

Trade-offs:

- **Saves an estimated 30–50%**, because the token-heavy reading moves to a model at half
  the price and Opus's context stays small. With the cache in place, that is about $10 a
  month.
- **Opens a new prompt-injection path.** A changelog that misleads Sonnet reaches Opus as a
  summary that looks trustworthy. The spot-checks are the mitigation. The deterministic
  gates are unaffected.
- **More moving parts** to debug, and a second model's behavior to track.
- **The code review stays on Opus either way.** It is the one layer aimed at a careful
  attacker, and the place where review quality matters most.

**Decision:** run a week of `shadow` mode on Opus alone, with the cache, and read the real
cost per assessment from the job logs (Claude Code reports it). Add the Sonnet subagents
for changelog and CI research only if measured spend is higher than wanted. Even then,
the published-code review and the verdict stay on Opus. `DEPS_AGENT_MODEL` can swap the
whole assessment to another model without a code change, but that would also move the code
review, so it is not the preferred lever.

## Alternatives considered

- **Claude Code cloud routine (`/schedule`)**: simpler to set up, but one broad credential for
  both reading untrusted text and merging, and no comment-triggered owner replies.
- **Per-PR `pull_request` trigger**: Dependabot-triggered runs get a read-only token and only
  Dependabot secrets, and parallel per-PR runs break the serial-merge requirement that
  lockfile conflicts impose.
- **A plain auto-merge workflow** (`dependabot/fetch-metadata` + `gh pr merge --auto` for
  patch/minor): no API cost, but `fetch-metadata` treats 0.x minors as minors, a
  `GITHUB_TOKEN` merge would not trigger Deploy, nothing serializes merges against deploy
  health, and nothing reviews the published code.
- **Auto-fixing mechanical CI failures** (as `/babysit-deps` does locally): deferred. It is
  the only step that would execute PR code with a write token.

## Consequences

- Up to 8 merges a day (cron every 3 h), each one attributable to a single production bump.
  Routine fixes arrive about a week after release; security updates skip the cooldown. A
  bump whose transitive versions are younger than 7 days waits until they age, and pings
  the owner after 14 days of waiting (a fast-moving dependency can keep resetting the clock).
- Overrides are append-only and cannot be withdrawn; `/deps hold` is the revocation (a held
  PR never merges).
- Install scripts run in CI's `npm ci` (no secrets), so a version change of a package that
  runs one escalates. Escalating every bump of the few packages that legitimately run scripts and
  bump often (`better-sqlite3`, `esbuild`, `msw`, `unrs-resolver`) was too much friction,
  so those four pass when the install command is byte-identical to the previous version's
  and both versions have npm provenance (all four publish with it). The cooldown and the
  code review still apply; a changed command, lost provenance, a new script or any other
  package still escalates. Considered and rejected: relaxing all dev dependencies (the
  Docker builder stage runs a full `npm ci`, so dev scripts can still tamper with the
  production bundle). Complementary, done in #43: the image builds with
  `npm ci --ignore-scripts`, so new versions' scripts don't run in the production build at
  all (`better-sqlite3` 13 ships N-API prebuilds, so no rebuild step is needed).
- `/deps` commands never merge and never write the decision record. `/deps merge` posts an
  append-only App comment naming the approved versions, and the scheduled `act` job (the
  only writer of records and the only merger) reads it. A command can therefore neither
  race `act` nor be dropped by a shared concurrency group: GitHub keeps only one pending
  run per group, so the command job has no concurrency group at all.
- If Dependabot ignores the App's `@dependabot rebase` (unverified whether it accepts
  commands from an App), the PR escalates after 24 h, so the owner can rebase by hand.
- Every comment on any issue or PR starts a Deps agent run in which every job is skipped
  unless it is an owner `/deps` command. That is noise in the Actions tab, but harmless:
  `issue_comment` cannot be filtered by body at the trigger level.
- Owner involvement drops to escalations (majors, breaking changes touching our code,
  supply-chain signals, suspicious code, red CI, broken main), answered with `/deps …` PR
  comments.
- One Claude assessment per set of package versions (Dependabot rebases reuse it; every gate
  is still re-checked on the new commit), including a size-capped review of the published code.
  Estimated $0.40–$1.50 each on Claude Opus 5.5, roughly $20–30 a month at current PR volume.
  A rebase that re-resolves the lockfile triggers a new assessment.
- Hard gates also check where the change came from: the head commit must be a signed
  Dependabot commit, and every introduced version must resolve from registry.npmjs.org.
- An npm registry outage (timeout, 5xx) makes PRs wait, like a malware-feed outage, instead
  of escalating every open PR: the registry-based rules skip the versions they could not
  check, and a separate `registry` rule of kind transient waits. A 404 is an answer (the
  version is not on npm) and escalates. Two attempts failed first: making only the cooldown
  wait left the publisher rule escalating on the empty facts, and carrying the outage inside
  the cooldown rule let a waived cooldown failure on one package mask an unchecked package
  (rule ordering decided the outcome). A transient rule can never be waived, so the outage
  guarantee no longer depends on ordering. The tests build outage facts with the CLI's own
  builder (`registryFact`).
- Pings are deduplicated on each failing rule's id and reason, and an "escalate" verdict
  carries a fingerprint of the model's reasons: a waived rule that fails again for a new
  reason, including a re-assessment that escalates for something else, pings the owner
  again instead of sitting silently under the old override. Transient rules (main busy,
  branch behind, conflict) are left out of that key: they flip on their own, and an early
  version re-pinged the owner about the same escalation each time main's CI ran or a sibling
  merged.
- The run's single merge slot is marked used the moment `merge()` succeeds: a failure later in
  the same evaluation (saving the record, a label) used to free it again, so a second PR
  could merge in the same run.
- Ping dedupe uses each failing rule's `waiverKey`, like waivers, so an overdue cooldown whose
  aging list shrinks stays one escalation instead of one @-mention per maturing version.
- The `sources` rule checks every lockfile entry whose `resolved` URL is new or changed, not
  one entry per package version; the install-script flag is cross-checked against the
  registry's published scripts (a lockfile can be edited; only the "registry has a script the
  lockfile hides" direction counts, since npm implies one for native builds); only the copy
  at the declared version counts as a direct update, so nested copies of a declared package
  are reviewed; text copied into the App's comments cannot render links or images.
- Robustness: the prompt template is filled with literal replacements (`$&` and friends are
  not interpreted), a compare result at GitHub's 300-file cap counts as "main changed the
  lockfile" (rebase requested), an assessment is dated by when it was made (an older one
  cannot satisfy a newer `/deps recheck`), and a held evaluation no longer moves the commit
  that `/deps merge` checks against.
- The lockfile diff looks a package's previous version up by name across main's lockfile,
  not only at the same key: a bump that also moves a package (hoisted to nested or back)
  used to look like a brand-new package, which skipped its code diff, the provenance-drop
  check and the trusted install-script comparison. A copy that only moves, at a version
  main already has, is not an introduced version at all.
- The published-code review hides only what cannot carry a payload by itself (source maps,
  type declarations, markdown, licences, images, fonts). Code in `test/`, `docs/` and
  `examples/` folders is shown last, and binaries and archives, which are not diffed, are
  listed so the review can flag them. A claimed `full` coverage is capped at `partial`
  when any diff was truncated, failed or had unreviewable files.
- A cancelled or stale required check waits for a re-run (up to 24 h after
  the cancellation)
  instead of failing the hard `checks` rule, which nobody can waive.
- Packages new to the lockfile are code-reviewed too, ranked after install-script packages
  in the transitive budget: a dependency that did not exist before is how the event-stream
  payload arrived. With no previous version, `npm diff` runs against an empty placeholder
  package, so the new package goes through the same file selection and caps, every
  published file shown as added. When no diff at all could be produced,
  the recorded coverage is `none`, which fails the code review.
- main's state picks the newest Deploy run that was not skipped (Deploy skips itself for
  CI on a fork PR, which a public repo can receive from a branch named `main`).
- A cancelled CI or Deploy run on main waits for a re-run and only counts as broken a day
  later: cancelling CI right after a deps-agent merge used to file a freeze issue and open
  a revert PR. Required checks must succeed (a future `if:` that skips E2E for bots must
  not let bumps through), and an escalated PR is never asked to rebase (each merge touches
  the lockfile; a rebase can re-resolve it, costing an assessment and voiding a pending
  `/deps merge`).
- Waivers match a hash of each rule's full failure detail (`waiverKey`), stored with the rule
  before the record is trimmed for display: an earlier version compared details, and a
  record trimmed to fit a comment produced overrides that could never match, silently. The
  overdue cooldown matches on "overdue" rather than on its version list: the override is
  tied to one lockfile, so that list can only shrink as versions mature, and a PR getting
  safer must not void the owner's decision.
- A bump introducing more than 300 versions fails the hard `scale` rule: above that limit the
  registry checks are skipped, and an earlier placeholder entry let provenance and publisher
  pass on facts never collected.
- A main commit with no CI run 30 minutes after the push counts as broken (merges freeze, the
  owner is pinged) instead of pending forever. A failure while handling a broken main (e.g.
  a rejected revert push) no longer stops the run: PRs are still evaluated and the dashboard
  shows the error.
- `plan` skips PRs whose AI assessment cannot change the outcome: held PRs, non-npm PRs, and
  PRs whose last evaluation of the same commit failed a hard rule that no assessment or CI
  result can change. Held PRs used to be re-assessed every run once their state changed,
  taking the per-run assessment slots from other PRs.
- The outage clock only resets after 24 hours without any outage, so a source that fails most
  runs and answers once in a while still escalates after 48 hours.
- Rules that only ever wait get a clock, so nothing waits silently forever: an unanswered
  `@dependabot rebase` pings after 24 hours, and an outage of any external source (npm
  registry, malware feed, npm audit) after 48 hours. A cooldown that has not settled after
  14 days turns into a failure rather than a ping, because only a failure can be waived:
  the escalation tells the owner to `/deps merge`, and that has to work.
- A failed `npm audit` run is an outage (the PR waits), not an advisory: recording the error
  as an advisory pinged the owner over network hiccups and let an override waive an audit
  that never ran.
- The decision record is saved before the escalation and rebase comments are posted, and the
  "already sent" markers only after they are: a record that cannot be saved (e.g. over
  GitHub's 65,536-character comment limit) can then never cause the same comments to be
  posted on every run. Assessments are clamped to fixed field lengths when stored, and the
  record renderer drops history, then the assessment's free text, then long rule details
  until the comment fits; dropping text changes the verdict fingerprint, so a waiver tied to
  it stops applying (the safe direction).
- In shadow mode, and on held PRs, deps-agent does not ask Dependabot to rebase: shadow only
  observes, and a hold means hands off. Held PRs skip fact collection entirely.
- A `/deps recheck` is an append-only App comment, and `plan` re-assesses any PR whose
  latest recheck is newer than its last stored assessment: a dispatched run cancelled while
  queued behind another one can no longer lose the request.
- An assessment made for an earlier state of the PR is kept (it may match again) but shown
  as outdated in the decision record, never as a live recommendation.
- Requires a GitHub App, an Anthropic API key (with its own spend limit), and repository
  variables; see `docs/deps/README.md`.
