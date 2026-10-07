# AI-First Development

Gleanary is built almost entirely by AI coding agents ([Claude Code](https://docs.claude.com/en/docs/claude-code/overview)),
directed and reviewed by one human. This document explains the setup that makes that work: what
the agent reads, which process it must follow, which guardrails it cannot bypass, and how the
work is split across models to keep cost down.

Everything described here is in the repository and is what is actually used day to day.

## The idea in one paragraph

An agent is fast and tireless, but it forgets everything between sessions, takes the shortest
path to "done", and is confidently wrong at times. The setup therefore does three things:
**write the context down** (so every session starts with the same knowledge), **make the process
explicit and checkable** (so "done" means tested, simplified, verified and reviewed), and **put
hard limits outside the model** (hooks and permissions that hold even when the agent ignores its
instructions). The human keeps the decisions: plans, architecture, infrastructure and anything
irreversible.

## Map of the moving parts

| Layer             | Where                                                                                                                                     | Role                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Project memory    | [`CLAUDE.md`](../CLAUDE.md)                                                                                                               | Conventions, design tokens, testing rules, session routing; loaded into every session    |
| Source of truth   | [`docs/architecture.md`](architecture.md)                                                                                                 | Technical decisions; agents read it first and may not edit it without human approval     |
| Module specs      | [`docs/modules/`](modules/)                                                                                                               | Per-module contract (API, behavior), written before the module is built                  |
| Decisions         | [`docs/adrs/`](adrs/)                                                                                                                     | Why a non-obvious choice was made, so a later session does not undo it                   |
| Process           | [`docs/sessions/`](sessions/)                                                                                                             | One workflow per kind of work (feature, bugfix, refactor, module-build, security-audit…) |
| Orchestration     | [`.claude/workflows/`](../.claude/workflows/)                                                                                             | Scripts that fan a session out to cheaper worker models                                  |
| Entry points      | [`.claude/commands/`](../.claude/commands/)                                                                                               | `/feature`, `/bugfix`, `/refactor`, `/babysit-deps`                                      |
| Specialist agents | [`.claude/agents/`](../.claude/agents/)                                                                                                   | `test-runner`: runs the suite and reports, nothing else                                  |
| Recurring checks  | [`.claude/skills/`](../.claude/skills/)                                                                                                   | Provider-currency checks (Anthropic SDK, Mistral OCR) and tech-debt triage               |
| Guardrails        | [`.claude/settings.json`](../.claude/settings.json), [`.claude/hooks/`](../.claude/hooks/), [`scripts/pre-commit`](../scripts/pre-commit) | Permissions, sandbox, pre-commit gates, secret scanner                                   |
| Debt ledger       | [`TECH_DEBT.md`](../TECH_DEBT.md)                                                                                                         | Known shortcuts, with severity, so they are paid down on purpose rather than forgotten   |

## 1. Written context

Every session starts cold. Instead of re-explaining the project each time, the knowledge lives
in files the agent loads automatically or is told to read first:

- **`CLAUDE.md`** carries the rules an agent would otherwise guess at: TypeScript strictness,
  the API-route error pattern, logging, the design-token system (no raw colors), test layout,
  and the files it must never touch.
- **`docs/architecture.md`** is the reference for the system. Agents may propose changes to it,
  but only the human applies them. That keeps one document authoritative instead of letting it
  drift with each session.
- **Module specs and ADRs** record the contract and the reasoning. A spec is written before a
  module is built; an ADR is written when a decision is surprising enough that a future session
  might "fix" it.

## 2. Explicit process: session types

Each kind of work has its own written workflow in [`docs/sessions/`](sessions/). The agent
picks one (feature by default) and turns its numbered steps into a checklist before writing
code. The feature workflow, for example:

1. **Plan** and wait for human approval.
2. **Test first**: write failing tests (red).
3. **Build** until green, then a **mutation check**: break the implementation on purpose and
   confirm a test catches it, so tests that cannot fail are caught.
4. **Secure**: scoped checks from the [security-audit](sessions/security-audit.md) session
   whenever the change touches external input, HTML, URL fetching or API routes.
5. **Simplify**: a dedicated pass for reuse and needless complexity, because agents tend to
   add rather than consolidate.
6. **Verify**: lint, typecheck, unit/integration and E2E, all green.
7. **Review**: correctness, security and simplification reviewers on the diff.

Bugfix, refactor, module-build, docs, infra and security-audit sessions follow the same shape,
with gates suited to the work (a bugfix starts by reproducing the bug in a failing test; a
refactor starts from a green baseline and must preserve it).

## 3. Cost-aware orchestration

Planning and final review need the most capable model; writing a test file or running prettier
does not. The workflows in [`.claude/workflows/`](../.claude/workflows/) split a session
accordingly:

- The **orchestrator** (the most capable model) scouts the code, writes the plan, gets it
  approved, and at the end reviews the result and commits.
- **Workers** on cheaper models do the steps in between. In
  [`feature-session.js`](../.claude/workflows/feature-session.js) the model and effort per phase
  are set in one block at the top: Implement on a strong model at high effort (correctness
  matters most there), Simplify/Verify/Review on a mid-tier model, Polish (prettier plus a
  changelog line) on the smallest one.
- Verify has a **bounded fix loop**: a couple of attempts, then it hands back to the
  orchestrator rather than looping.
- The workflow returns a structured bundle (diff summary, test results, review findings), so
  the orchestrator reviews outcomes without reading every intermediate file.

The same script has modes for refactors, bugfixes, test hygiene and test coverage, and
[`test-sweep.js`](../.claude/workflows/test-sweep.js) handles one mechanical change across many
test files. The README's [Orchestrated Feature Workflow](../README.md#orchestrated-feature-workflow)
section covers how to run them.

## 4. Guardrails outside the model

Instructions can be ignored; hooks and permissions cannot. The project relies on both:

- **Pre-commit gate** ([`pre-commit-check.sh`](../.claude/hooks/pre-commit-check.sh)): any
  `git commit` issued by the agent is blocked unless lint, typecheck and tests pass and
  `CHANGELOG.md` is staged. A separate git hook ([`scripts/pre-commit`](../scripts/pre-commit))
  blocks schema changes committed without a matching `docs/architecture.md` update.
- **Secret scanner** ([`secret-scanner.sh`](../.claude/secret-scanner.sh)): blocks tool calls
  that would read, write or send secrets. Hooks run even when permission prompts are skipped.
- **Permissions** ([`settings.json`](../.claude/settings.json)): reads of `~/.ssh`, cloud
  credentials and `.env` are denied; network tools and publishing are denied; `git push` and
  edits to CI workflows, the Dockerfile and `package.json` require confirmation.
- **Sandbox**: shell commands run sandboxed by default.
- **A global network tripwire in tests**: any unmocked HTTP request fails the test, so an agent
  cannot accidentally write tests that hit the real network.

## 5. What stays with the human

- Approving every plan before code is written.
- `docs/architecture.md`, `infra/`, `.github/workflows/` and secrets: agents may propose
  changes, the human applies them.
- Anything irreversible or outward-facing: pushes, deploys, releases, infrastructure applies.
- Choosing which tech debt to pay down (the [`tech-debt`](../.claude/skills/tech-debt/SKILL.md)
  skill verifies and ranks it; the human picks).

## Lessons learned

- **Tests that cannot fail are the main risk.** Agents write tests that pass; the mutation-check
  step and the reviewers exist because "green" alone proved not to be enough.
- **Simplify is a separate step for a reason.** Left alone, agents add a new helper instead of
  reusing the one two files away.
- **Write down the "why", not just the "what".** ADRs and spec notes stop later sessions from
  reverting deliberate choices that look like mistakes.
- **Keep the debt visible.** Shortcuts taken under pressure go into `TECH_DEBT.md` with a
  severity, instead of disappearing into commit history.
- **Pick models per step, not per project.** Most of the tokens in a session go to mechanical
  work that a cheaper model does just as well.

## Using this setup elsewhere

None of this is specific to Gleanary. A reasonable order to adopt it in another project:
`CLAUDE.md` with conventions, then one written session workflow (feature), then the pre-commit
hook, then orchestration once the process is stable enough to delegate.

Gleanary does not accept outside contributions (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)),
but you are welcome to reuse these ideas under the terms of the [license](../LICENSE.md).
