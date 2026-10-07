export const meta = {
  name: 'dep-triage',
  description:
    'Build read-only triage dossiers for open Dependabot PRs — one cheap worker per PR digests the diff, changelog, our real usage, and CI status into a structured dossier; all decisions and mutations stay with the orchestrator',
  whenToUse:
    'Invoked by /babysit-deps when more than one Dependabot PR is open. Pass via args: prs ([{number, title}] from `gh pr list --author "app/dependabot"`) and mainCi (one-line summary of main\'s current CI baseline from Phase A.5, so N workers don\'t each re-analyze one pre-existing failure). Workers are STRICTLY read-only: no checkout, no merge, no push, no file edits — the orchestrator (Fable) walks the returned dossiers serially and does all merging/fixing/escalating itself. NOT for a single PR (triage it inline, the fan-out is overhead) and NOT a substitute for the merge policy in .claude/commands/babysit-deps.md.',
  phases: [
    {
      title: 'Dossiers',
      detail: 'One read-only worker per PR: classify, diff, changelog, usage cross-ref, CI status',
      model: 'sonnet',
    },
  ],
};

// ── Policy ───────────────────────────────────────────────────────────────────
const MODEL = { dossier: 'sonnet' };
const EFFORT = { dossier: 'medium' };

// ── Input ────────────────────────────────────────────────────────────────────
const input = args || {};
const prs = Array.isArray(input.prs) ? input.prs.filter((p) => p && p.number) : [];
if (!prs.length) {
  return {
    status: 'aborted',
    reason:
      'pass args.prs: [{number, title}] — the output of `gh pr list --author "app/dependabot" --state open --json number,title`',
  };
}
// One-line summary of main's current CI state (Phase A.5 in the command file). Injected into
// every worker prompt so N workers don't each re-discover the same pre-existing failure.
const mainCiNote =
  typeof input.mainCi === 'string' && input.mainCi.trim()
    ? input.mainCi.trim()
    : 'not checked — no baseline; analyze any CI failure yourself';
log(`Building dossiers for ${prs.length} Dependabot PR(s) · main CI baseline: ${mainCiNote}`);

// ── Schema — the dossier IS the contract ─────────────────────────────────────
const DOSSIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'pr',
    'pkg',
    'versionFrom',
    'versionTo',
    'semverDelta',
    'ecosystem',
    'diffClean',
    'diffAnomalies',
    'breakingChanges',
    'deprecations',
    'securityFixes',
    'adoptableFeatures',
    'engineChanges',
    'ci',
    'packageRisk',
    'notes',
  ],
  properties: {
    pr: { type: 'integer' },
    pkg: { type: 'string' },
    versionFrom: { type: 'string' },
    versionTo: { type: 'string' },
    semverDelta: { type: 'string', enum: ['patch', 'minor', 'major', 'unknown'] },
    ecosystem: { type: 'string', enum: ['npm', 'github-actions'] },
    diffClean: {
      type: 'boolean',
      description:
        'Diff touches ONLY package.json/package-lock.json (npm) or workflow files (actions)',
    },
    diffAnomalies: {
      type: 'array',
      items: { type: 'string' },
      description: 'Unexpected files or hunks in the diff — always a red flag, never omit one',
    },
    breakingChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'ourUsage', 'affectsUs', 'securitySensitive'],
        properties: {
          description: { type: 'string' },
          ourUsage: {
            type: 'array',
            items: { type: 'string' },
            description:
              'file:line hits where WE touch the affected API specifically (not just any import of the package); empty when unused',
          },
          affectsUs: { type: 'boolean' },
          securitySensitive: {
            type: 'boolean',
            description:
              'Any hit under src/lib/sanitize.ts, the article parser, src/db/, or another security-sensitive path',
          },
        },
      },
    },
    deprecations: { type: 'array', items: { type: 'string' } },
    securityFixes: { type: 'array', items: { type: 'string' } },
    adoptableFeatures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'whereWeCouldUseIt', 'changelogUrl'],
        properties: {
          description: { type: 'string' },
          whereWeCouldUseIt: { type: 'string' },
          changelogUrl: { type: 'string' },
        },
      },
      description: 'New features Gleanary could plausibly adopt — tracking-issue material only',
    },
    engineChanges: {
      type: 'string',
      description:
        'peer-dep / engines / Node implications vs our package.json and CI Node version, or "none"',
    },
    ci: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'failingJob', 'logExcerpt', 'failureReadGuess'],
      properties: {
        status: { type: 'string', enum: ['green', 'red', 'pending', 'unknown'] },
        failingJob: { type: 'string', description: 'Name of the failing job, or "" when green' },
        logExcerpt: {
          type: 'string',
          description: 'Decisive excerpt of the failing log (~30 lines max), or "" when green',
        },
        failureReadGuess: {
          type: 'string',
          enum: ['mechanical', 'real', 'n/a'],
          description:
            'Worker HINT, set ONLY when the failure does NOT match the known main-CI baseline: mechanical (lockfile drift, snapshot, shifted type, lint nit, 1:1 rename) vs real (behavior change, removed API, changed semantics). n/a when CI is green or the failure matches the pre-existing baseline. The orchestrator decides.',
        },
      },
    },
    packageRisk: {
      type: 'string',
      enum: ['clean', 'risky'],
      description:
        'Package-level verdict ONLY — semver, changelog-vs-our-usage, diff cleanliness, engines. Deliberately IGNORES CI state; the orchestrator combines it with CI evidence. clean = patch/minor, clean diff, no breaking change affecting code we use. risky = anything else.',
    },
    notes: {
      type: 'string',
      description: 'Anything that did not fit, incl. missing evidence (changelog 404, etc.)',
    },
  },
};

// ── Worker prompt ────────────────────────────────────────────────────────────
const dossierPrompt = (
  pr,
) => `You are building a READ-ONLY triage dossier for one Dependabot PR in the Gleanary repo. Other workers are triaging OTHER PRs right now; you all share one working tree, so you must not change ANY state.

PR #${pr.number}: ${pr.title}

FORBIDDEN, no exceptions: \`gh pr checkout\`, \`git checkout\`/\`git switch\`/\`git stash\` or any git command that writes, \`gh pr merge\`, pushing, creating/editing/deleting any file, \`npm install\`/\`npm ci\`/\`npm update\`, and touching data/ in any way (the dev database lives there). You gather evidence; the orchestrator acts on it.

MAIN CI BASELINE (checked once by the orchestrator — trust it, do not re-derive it): ${mainCiNote}

ENVIRONMENT NOTES (known quirks, don't rediscover them):
- \`gh\` cannot read the macOS keychain inside the sandbox; run gh commands with the sandbox override (every gh command you need here is read-only).
- \`npm view\` may fail with a cache EPERM; fall back to WebFetch of the GitHub/npm pages.
- Dependabot's PR body usually embeds the relevant release notes — read it FIRST (\`gh pr view ${pr.number} --json body\`) and only WebFetch external pages for what's missing.

Steps:
1. CLASSIFY — parse "bump <pkg> from A to B" (or "chore(deps): ...") from the title; semver delta patch/minor/major. Ecosystem: npm dep, or github-actions bump (label "ci" — then "usage" means the files under .github/workflows/).
2. DIFF — \`gh pr diff ${pr.number}\`. Confirm it only touches package.json/package-lock.json (npm) or workflow files (actions). Anything else → diffClean=false and list every anomaly.
3. CHANGELOG — start from the Dependabot PR body (see ENVIRONMENT NOTES); if it doesn't cover every release between A and B, WebFetch the gaps. Prefer, in order: https://github.com/<owner>/<repo>/releases (find the repo via \`npm view <pkg> repository.url\` — read-only, allowed), the repo's CHANGELOG.md rendered on github.com, then https://www.npmjs.com/package/<pkg>?activeTab=versions. Extract breaking changes, deprecations, security fixes, and notable new features. If the notes are unreachable, say so in notes — never guess.
4. USAGE CROSS-REF (the point of this dossier — impact on OUR code, not abstract severity) — for npm: \`grep -rn "from ['\\"]<pkg>" src/\` and \`grep -rn "require(['\\"]<pkg>" src/\`; for actions: grep .github/workflows/. Then, for EACH breaking change, find the file:line hits of the affected API specifically and set affectsUs. Mark securitySensitive when a hit lands in src/lib/sanitize.ts, the article parser, src/db/, or another security-sensitive path. Cross-check peer-dep/engines bumps against package.json "engines" and the CI Node version → engineChanges.
5. CI — \`gh pr checks ${pr.number}\`. If a failing job MATCHES the main CI baseline above (same job, same failure shape): record status='red' and the job name, set logExcerpt to 'matches known pre-existing main failure' and failureReadGuess='n/a', and move on — do NOT re-analyze those logs. Only if a DIFFERENT job fails, or the same job fails with a different signature, fetch the failing log (\`gh run view <run-id> --log-failed\`), put the decisive ~30 lines in ci.logExcerpt, and set failureReadGuess (mechanical vs real — a HINT, not a decision).
6. PACKAGE RISK — set packageRisk from the package evidence ALONE, ignoring CI entirely: clean (patch/minor, clean diff, no breaking change touching code we use) or risky (major; a breaking change with affectsUs; anything securitySensitive; a dirty diff). The orchestrator combines this with CI state — do not fold CI into it.

Your final message is the structured dossier, not prose.`;

// ── Fan out — one worker per PR, no inter-PR dependency ──────────────────────
phase('Dossiers');
const results = await parallel(
  prs.map(
    (pr) => () =>
      agent(dossierPrompt(pr), {
        label: `dossier:#${pr.number}`,
        phase: 'Dossiers',
        model: MODEL.dossier,
        effort: EFFORT.dossier,
        schema: DOSSIER_SCHEMA,
      }),
  ),
);
const dossiers = results.filter(Boolean);
const failedPrs = prs
  .filter((pr) => !dossiers.some((d) => d.pr === pr.number))
  .map((pr) => pr.number);
if (failedPrs.length)
  log(`PRs with no dossier (worker skipped/died) — triage these inline: #${failedPrs.join(', #')}`);
log(
  `Dossiers: ${dossiers.length}/${prs.length} · package risk: ${dossiers
    .map((d) => `#${d.pr}=${d.packageRisk}`)
    .join(' ')}`,
);

return {
  status: failedPrs.length ? 'partial' : 'complete',
  dossiers,
  failedPrs,
  reminders: {
    note: 'Fable to now: walk the dossiers SERIALLY per the /babysit-deps policy — combine packageRisk with the CI evidence yourself (a red that matches the main baseline is non-attributable to the PR). Merge with `gh pr merge --squash --auto`, one at a time; immediately after each merge, comment `@dependabot rebase` on ALL remaining PRs so rebases overlap the next wait, then re-check mergeable/mergeStateStatus before acting (siblings share package-lock.json; a PR Dependabot closes mid-train as superseded by a newer version is benign — count it handled, triage the successor next cycle). Local `gh pr checkout` only for CI failures that do NOT match the baseline. Triage any failedPrs inline.',
  },
};
