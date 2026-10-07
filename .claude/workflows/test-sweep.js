export const meta = {
  name: 'test-sweep',
  description:
    'Mechanical migration across many test files: fan out cheap workers per file group, each scoped to its own files, then one full verify + no-weakening review',
  whenToUse:
    "For a repetitive, well-defined transformation across ~10+ test files (e.g. migrate to createDbMock(), replace process.env writes with vi.stubEnv, adopt a stubbing pattern) where feature-session's single Implement worker would be slow and wasteful. Pass via args: goal (one line), transformation (the exact before/after pattern, with a reference file if one exists), and files (flat list — the workflow chunks it) or groups ([{name, files}]). NOT for judgment-heavy test work (use feature-session mode:'test-hygiene'), new coverage (mode:'test-coverage'), or product-code changes of any kind.",
  phases: [
    {
      title: 'Migrate',
      detail: 'One worker per file group, scoped test runs only (no full suite, no E2E)',
      model: 'sonnet',
    },
    { title: 'Review', detail: 'No-weakening reviewer per group, diff vs HEAD', model: 'sonnet' },
    { title: 'Polish', detail: 'prettier --write + CHANGELOG line', model: 'haiku' },
    { title: 'Verify', detail: 'test-runner full scope, bounded fix loop', model: 'sonnet' },
  ],
};

// ── Policy ───────────────────────────────────────────────────────────────────
const MODEL = {
  migrate: 'sonnet',
  review: 'sonnet',
  polish: 'haiku',
  verify: 'sonnet',
  fix: 'sonnet',
};
const EFFORT = {
  migrate: 'medium',
  review: 'medium',
  polish: 'low',
  verify: 'medium',
  fix: 'high',
};
const MAX_FIX_ATTEMPTS = 2;
const DEFAULT_GROUP_SIZE = 6;

// ── Input ────────────────────────────────────────────────────────────────────
const input = args || {};
const GOAL = input.goal || '(no goal provided)';
const TRANSFORMATION = input.transformation || '';
if (!TRANSFORMATION) {
  return {
    status: 'aborted',
    reason: 'args.transformation is required — the exact before/after pattern workers must apply',
  };
}
let groups;
if (Array.isArray(input.groups) && input.groups.length) {
  groups = input.groups;
} else if (Array.isArray(input.files) && input.files.length) {
  const size = input.groupSize || DEFAULT_GROUP_SIZE;
  groups = [];
  for (let i = 0; i < input.files.length; i += size) {
    groups.push({ name: `group-${groups.length + 1}`, files: input.files.slice(i, i + size) });
  }
} else {
  return {
    status: 'aborted',
    reason: 'pass args.files (flat list) or args.groups ([{name, files}])',
  };
}
log(`Sweep: ${groups.length} groups, ${groups.reduce((n, g) => n + g.files.length, 0)} files`);

// ── Schemas ──────────────────────────────────────────────────────────────────
const MIGRATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'filesChanged',
    'skipped',
    'beforeIts',
    'afterIts',
    'beforeSkips',
    'afterSkips',
    'scopedGreen',
    'notes',
  ],
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' } },
    skipped: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Files left untouched because the pattern does not apply, with why — never silently skip',
    },
    beforeIts: { type: 'integer', description: 'Total it()/test() count across the group BEFORE' },
    afterIts: { type: 'integer', description: 'Total it()/test() count across the group AFTER' },
    beforeSkips: {
      type: 'integer',
      description: 'Total .skip/.only count across the group BEFORE',
    },
    afterSkips: { type: 'integer', description: 'Total .skip/.only count across the group AFTER' },
    scopedGreen: {
      type: 'boolean',
      description: 'npm run test -- <group files> passes after the change',
    },
    notes: { type: 'string' },
  },
};
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'severity', 'summary'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          summary: { type: 'string' },
        },
      },
    },
  },
};
const CHANGES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['changes', 'notes'],
  properties: {
    changes: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'lint', 'typecheck', 'tests', 'e2e', 'failures'],
  properties: {
    passed: { type: 'boolean' },
    lint: { type: 'string' },
    typecheck: { type: 'string' },
    tests: { type: 'string' },
    e2e: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
  },
};

// ── Migrate → review, per group, no barrier between the two stages ───────────
const migratePrompt = (
  g,
) => `You are one worker in a parallel sweep over test files. Other workers are editing OTHER files in the SAME working tree right now. Touch ONLY your assigned files — nothing else, ever.

GOAL: ${GOAL}
TRANSFORMATION (apply exactly this, no drive-by changes): ${TRANSFORMATION}
YOUR FILES: ${g.files.join(', ')}

Rules, in order:
1. BEFORE: count it()/test() and .skip/.only occurrences across your files (report as beforeIts/beforeSkips).
2. Apply the transformation to each file. The suite contract is inviolable: no test deleted, no assertion removed or loosened, no new .skip/.only. If the pattern genuinely does not apply to a file, leave it unchanged and list it in skipped with the reason.
3. AFTER: re-count (afterIts/afterSkips). Run ONLY your files: \`npm run test -- ${g.files.join(' ')}\` and set scopedGreen. NEVER run the full suite, \`npx playwright test\`, or E2E of any kind — concurrent Playwright runs collide on the port, and the full suite is verified once at the end.
4. FORBIDDEN: data/ (the dev database lives there), package.json, vitest.config.ts, playwright.config.ts, src/, docs/, .github/, any file outside YOUR FILES.

Return the structured result. Your final message is data, not prose.`;

const reviewPrompt = (
  g,
  m,
) => `Review a mechanical test-file migration for suite weakening. Diff each of these files against HEAD (\`git diff HEAD -- <file>\`) and check ONLY that the suite was not weakened:
FILES: ${(m.filesChanged.length ? m.filesChanged : g.files).join(', ')}
TRANSFORMATION THAT WAS APPLIED: ${TRANSFORMATION}

Flag: deleted it()/test() blocks, removed or loosened assertions (e.g. toEqual → toBeTruthy), new .skip/.only, a mock broadened so it now answers what the test used to verify, stubbing left unrestored (vi.stubGlobal without vi.unstubAllGlobals, module-level process.env writes), or any change beyond the stated transformation. Empty findings if clean.`;

phase('Migrate');
const results = await pipeline(
  groups,
  (g) =>
    agent(migratePrompt(g), {
      label: `migrate:${g.name}`,
      phase: 'Migrate',
      model: MODEL.migrate,
      effort: EFFORT.migrate,
      schema: MIGRATE_SCHEMA,
    }),
  (migrated, g) =>
    migrated
      ? agent(reviewPrompt(g, migrated), {
          label: `review:${g.name}`,
          phase: 'Review',
          model: MODEL.review,
          effort: EFFORT.review,
          schema: REVIEW_SCHEMA,
        }).then((review) => ({ group: g.name, migrated, review }))
      : null,
);
const done = results.filter(Boolean);
const failedGroups = groups.filter((g) => !done.some((r) => r.group === g.name)).map((g) => g.name);
if (failedGroups.length)
  log(`Groups with no result (worker skipped/died): ${failedGroups.join(', ')}`);

// Aggregate suite-contract check — plain code, not an agent.
const totals = done.reduce(
  (t, r) => ({
    beforeIts: t.beforeIts + r.migrated.beforeIts,
    afterIts: t.afterIts + r.migrated.afterIts,
    beforeSkips: t.beforeSkips + r.migrated.beforeSkips,
    afterSkips: t.afterSkips + r.migrated.afterSkips,
  }),
  { beforeIts: 0, afterIts: 0, beforeSkips: 0, afterSkips: 0 },
);
const contractIntact =
  totals.afterIts >= totals.beforeIts && totals.afterSkips <= totals.beforeSkips;
const redGroups = done.filter((r) => !r.migrated.scopedGreen).map((r) => r.group);
log(
  `Contract: it() ${totals.beforeIts}→${totals.afterIts}, skips ${totals.beforeSkips}→${totals.afterSkips} (${contractIntact ? 'intact' : 'VIOLATED'})${redGroups.length ? ` · scoped-red groups: ${redGroups.join(', ')}` : ''}`,
);

// ── Polish: prettier + CHANGELOG ─────────────────────────────────────────────
phase('Polish');
const polish = await agent(
  `Two mechanical pre-commit tasks, nothing else:
1. Run \`./node_modules/.bin/prettier --write .\` (the local binary directly, NOT npx) to auto-fix formatting.
2. Add ONE line under the "Unreleased" heading in CHANGELOG.md describing this change: "${GOAL}". Match the style of existing entries.
Do not touch any other file. Return the changelog line you added.`,
  {
    label: 'polish:prettier+changelog',
    phase: 'Polish',
    model: MODEL.polish,
    effort: EFFORT.polish,
    schema: CHANGES_SCHEMA,
  },
);

// ── Verify: full suite once, bounded fix loop ────────────────────────────────
phase('Verify');
const verifyPrompt = `Run the FULL verification suite for Gleanary: lint, typecheck, unit+integration tests, and E2E. Report each channel's result and any concrete failure messages. Do not fix anything — just report.`;
let verify = await agent(verifyPrompt, {
  label: 'verify:full',
  phase: 'Verify',
  agentType: 'test-runner',
  model: MODEL.verify,
  effort: EFFORT.verify,
  schema: VERIFY_SCHEMA,
});
const fixLog = [];
let attempt = 0;
while (verify && !verify.passed && attempt < MAX_FIX_ATTEMPTS) {
  attempt++;
  log(`Verify failed (attempt ${attempt}/${MAX_FIX_ATTEMPTS}) — dispatching fix worker`);
  const fix = await agent(
    `The full suite is failing after a mechanical test-file sweep (${GOAL}). Fix ONLY what's needed to make it pass. These are TEST files: never remove or loosen an assertion, never delete a test, never add .skip — fix the migration mistake instead. Do not touch product code, data/, or config files.
Failures:
${(verify.failures || []).join('\n')}
Lint: ${verify.lint}
Typecheck: ${verify.typecheck}
Tests: ${verify.tests}
E2E: ${verify.e2e}
Return what you changed.`,
    {
      label: `fix:attempt-${attempt}`,
      phase: 'Verify',
      model: MODEL.fix,
      effort: EFFORT.fix,
      schema: CHANGES_SCHEMA,
    },
  );
  if (fix) fixLog.push(fix);
  verify = await agent(verifyPrompt, {
    label: `verify:re-run-${attempt}`,
    phase: 'Verify',
    agentType: 'test-runner',
    model: MODEL.verify,
    effort: EFFORT.verify,
    schema: VERIFY_SCHEMA,
  });
}

// ── Bundle for Fable's final review + commit decision ────────────────────────
const findings = done
  .flatMap((r) => (r.review && r.review.findings) || [])
  .sort(
    (a, b) =>
      ({ high: 0, medium: 1, low: 2 })[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity],
  );
return {
  status:
    verify && verify.passed && contractIntact && !failedGroups.length ? 'green' : 'needs-attention',
  goal: GOAL,
  groups: done.map((r) => ({
    group: r.group,
    filesChanged: r.migrated.filesChanged,
    skipped: r.migrated.skipped,
    scopedGreen: r.migrated.scopedGreen,
    notes: r.migrated.notes,
  })),
  failedGroups,
  suiteContract: { ...totals, intact: contractIntact },
  changelog: polish,
  verify,
  fixAttempts: fixLog,
  reviewFindings: findings,
  reminders: {
    note: 'Fable to now: check suiteContract.intact and failedGroups, read reviewFindings and skipped lists (a skipped file may need a manual pass), then commit with a conventional message.',
  },
};
