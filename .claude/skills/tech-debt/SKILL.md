---
name: tech-debt
description: Triage and pay down the items tracked in `TECH_DEBT.md` reliably. Two modes. ASSESS — verify every active item against the current code (entries go stale, get partially fixed elsewhere, or understate reality), then rank by real severity and report which to tackle. EXECUTE — fix one or more chosen items through the repo's bugfix workflow (failing test → smallest fix → simplify → verify → code review → commit), and reconcile `TECH_DEBT.md` afterward. Use this whenever the user asks what tech debt to address, to assess/triage/rank `TECH_DEBT.md`, whether a debt item is still relevant, or to "do"/"fix"/"pay down" specific tracked items. Do NOT use it for ad-hoc refactoring of untracked code (that's SESSION: refactor), for a full security sweep (SESSION: security-audit), or for the provider currency skills (`claude-sdk-update-check`, `mistral-ocr-update-check`).
---

# Tech debt

## Why this exists

`TECH_DEBT.md` is a ledger, not a source of truth. Between the day a row is written and the day
someone reads it, three things happen that the table never reflects on its own:

1. **Items get fixed elsewhere.** A row's problem is often resolved as a side effect of unrelated
   work — a helper gets extracted, a backfill completes, a dependency is bumped. The row still
   reads "open."
2. **Items get partially fixed.** The chunked code path gains a guard but the non-chunked one
   doesn't; two of four missing test files get written. The row's wording is now wrong in scope.
3. **Items drift out of date.** "esbuild — 4 moderate vulns" was really 27 vulnerabilities (6
   high) by the time it was re-audited. A ranking built from the row text alone is built on sand.

So the first job is always **verification against the current code**, and only then ranking. The
second job — when the user picks items — is to fix them the same disciplined way any bug is fixed
here, because the review gate on your _own_ fix is load-bearing: in the session that seeded this
skill, the code review of an SSRF fix caught two further holes (`0.0.0.0/8`, a trailing-dot
literal) that the original fix missed. Debt work that skips the gate just mints new debt.

The output the user wants from ASSESS is not "here is the table." It is: _which of these are
still real, how bad each actually is, and what I should do first_ — ranked so they can act. From
EXECUTE it is: _what was broken, what fixed it, and the ledger is now honest._

## Mode A — ASSESS (read-only triage)

Trigger: "what tech debt should I tackle", "assess/triage TECH_DEBT.md", "is item X still
relevant", "rank the tech debt".

1. **Read `TECH_DEBT.md`** — both the Active Items and Resolved tables (Resolved tells you what
   patterns already got fixed, which hints at side-effect fixes to look for).

2. **Verify every active item against the current code — batch it.** For each row, run the cheapest
   check that could falsify it, and fan the independent checks out in parallel (one `Bash`/`Grep`/
   `Read` block with many calls). Typical checks by item type:
   - _"X is not called / Y has no caller"_ → `grep` for the symbol across `src/`.
   - _"file/function does Z"_ → `Read` the cited `file:line`; code moves, line numbers rot.
   - _dependency vulns_ → `npm audit` (real current count + severities, not the row's number);
     `npm ls <pkg>` for version-invalid markers.
   - _"once backfill/telemetry confirms, remove v1 path"_ → query the actual dev DB
     (`sqlite3 data/gleanary.db "…"`) to see if the gating condition is met (e.g. all rows v2).
   - _CI/workflow claims_ → read the referenced `.github/workflows/*.yml` / `docker/*` line.
   - _"missing tests for A, B, C"_ → `ls __tests__/**` for those names.

   Never rank from the row text alone. Cite the evidence (`file:line`, audit count, row count) in
   the report — a claim without a check is exactly the staleness this skill exists to catch.

3. **Classify each item** into one of:
   - **Still fully relevant** — verified open, wording accurate.
   - **Partially resolved** — part is fixed; the entry should be _narrowed_ (say to what).
   - **Stale / closeable** — already fixed elsewhere, or unresolvable-by-construction (needs data
     that no longer exists), or by-design; recommend moving to Resolved or deleting.
   - **Understated / overstated** — real but the severity or scope in the row is wrong; restate.

4. **Rank by real severity, not the table's Severity column.** The column is the author's
   point-in-time guess; re-derive it. Order:
   1. **Exploitable now** — a reachable security hole (SSRF/XSS/injection/auth) in shipped code.
   2. **Integrity of the safety net** — anything that makes a green build lie (a masked/ignored
      test gate, a disabled check), because it silently degrades every other guarantee.
   3. **Correctness / data** — wrong output, silent misreporting, orphan/leak risk.
   4. **Cheap high-value wins** — small, user-visible, low-risk (a missing button, a one-line fix).
   5. **Cleanup / observability / tuning** — deferrable; often correctly parked on telemetry.
   6. **Docs-only / accepted / by-design** — close or note, don't schedule.

5. **Report.** Lead with the one-line bottom line (which few to do now, which to close). Then, per
   item, a short verdict with the evidence and a recommendation. Group by the ranking tiers above.
   Flag the closeable/partial ones explicitly — surfacing that the ledger itself needs a cleanup
   pass is part of the deliverable, not a footnote.

This mode changes no files. If the user then says "do items N…", switch to Mode B.

## Mode B — EXECUTE (fix chosen items)

Trigger: "do items 1–3", "fix the IPv6 one", "pay down the top two".

Fixing tracked debt **is a `SESSION: bugfix`** (or, if the item is a genuine new capability rather
than a defect, `SESSION: feature`). Do not invent a parallel process — run the repo's own workflow
so the mandatory gates apply.

1. **Set up the TodoWrite/Task checklist** from `docs/sessions/bugfix.md` (per `CLAUDE.md`'s
   Workflow Enforcement), plus the Mandatory Pre-Commit Steps. Add one todo per chosen debt item's
   REPRODUCE→FIX, then the shared SIMPLIFY / PRETTIER / VERIFY / DOCUMENT / CODE-REVIEW / COMMIT
   steps. The checklist is the contract; don't skip ahead.

2. **Per item: reproduce before fixing.** Write the failing test (or capture the failing
   `npm audit` / failing E2E run) that proves the item is real _right now_ — this doubles as the
   step-2 re-verification and guards against "fixing" something already fixed. Then apply the
   **smallest** fix and run the reproduction to green.
   - Batchable items (add `resolve6` to N identical dns mocks; bump deps) can be done together.
   - Interdependent or judgment-heavy items get their own reproduce→fix cycle.

3. **Run the mandatory pre-commit gates** (from `CLAUDE.md` — these are not optional):
   `/simplify` on changed files → `./node_modules/.bin/prettier --write .` (local binary, not
   `npx`) → `test-runner` agent, full scope → docs freshness → `/code-review`. **Address the
   code-review findings** — treat a finding on your own debt fix as the default expectation, not a
   surprise; verify and fix the confirmed/plausible ones before committing.

4. **Reconcile `TECH_DEBT.md` — this is the step that keeps the ledger honest:**
   - Move each fully-fixed item to the **Resolved** table (date in the Resolved column, a Notes
     line saying what fixed it and any tests added).
   - **Narrow** partially-resolved rows to the remaining gap rather than deleting them.
   - If the work surfaced _new_ debt (a pre-existing flake the fix exposed, a shortcut you took),
     add an Active row for it — better a tracked known-issue than a silent one.
   - Update `CHANGELOG.md` (a Security/Fixed entry as appropriate) and any doc the change touches.

5. **Commit** only when asked (the user says "commit"). If on the default branch, branch first.
   The commit convention and co-author trailer are in the environment/`CLAUDE.md`; group the fixes
   into one coherent commit and call out any `.github/`, `infra/`, or `docs/architecture.md` change
   that needs human review.

## Gleanary specifics worth knowing

- **`TECH_DEBT.md` shape.** Two markdown tables: `## Active Items` (cols: Severity, Item, Added,
  Target Phase, Notes) and `## Resolved` (Severity, Item, Resolved, Notes). Keep the Prettier
  formatting — run `./node_modules/.bin/prettier --write TECH_DEBT.md` after editing; the table
  columns get re-padded.
- **Verification environment gotchas** (see the `gleanary-verification-env-limits` memory):
  `npm install`/`audit fix` need `--cache "$TMPDIR/npmcache-claude"` in-sandbox; Playwright and
  `gh` need the sandbox disabled; migrate the dev DB before E2E after any schema change; use
  `./node_modules/.bin/prettier`, never `npx prettier`.
- **Ranking calibration for this repo.** It's a single-user self-hosted app: a spray/DoS or
  multi-tenant concern is lower here than an SSRF that reaches the user's own network; a UX papercut
  the owner hits daily can outrank a theoretical edge case. Weight by what actually bites a
  self-hoster.

## What good looks like

ASSESS: a ranked report where every "still relevant / stale / partial" verdict cites a check you
ran, the top few actionable items are separated from the deferrable majority, and the ledger's own
rot (closeable and mis-scoped rows) is called out. EXECUTE: the chosen items fixed test-first,
your own fix run through `/code-review` with findings addressed, full suite green, and
`TECH_DEBT.md` + `CHANGELOG.md` left honest. If verification shows an item is already resolved,
the right move is to say so and close the row — not to manufacture a fix.
