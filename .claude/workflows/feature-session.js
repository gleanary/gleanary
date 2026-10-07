export const meta = {
  name: 'feature-session',
  description:
    'Run a Gleanary SESSION: feature (test-first build → simplify → verify → review) with cheap workers doing the work and Fable reserved for plan + final review',
  whenToUse:
    "After you (Fable) have produced the PLAN and the human has approved it. Pass the approved plan via args. The workflow runs feature.md steps 2-7 on cheap models and returns a structured bundle for your final review + commit. Pass mode:'refactor' in args for a behavior-preserving refactor: it swaps the test-first red/green Implement phase for a green-baseline + contract-preservation gate (everything else is identical). Pass mode:'bugfix' for a bug fix: the Implement phase becomes reproduce-with-failing-test → smallest fix, with root-cause and tech-debt reporting. Pass mode:'test-hygiene' to refactor EXISTING tests without weakening the suite (green-baseline → suite-contract gate: same it()/skip counts, no assertion dropped; E2E-touching runs add a --repeat-each stability proof in Verify). Pass mode:'test-coverage' to add tests for EXISTING code (tests must pass immediately → per-file mutation check; product bugs the new tests expose are reported in bugsDiscovered, never fixed inline — dispatch a mode:'bugfix' run for those). For a mechanical migration across many test files (~10+), use the test-sweep workflow instead of this one.",
  phases: [
    {
      title: 'Implement',
      detail:
        'One worker (feature: TEST+BUILD+SECURE red→green→mutation; refactor: green-baseline→preserve-contract; bugfix: reproduce-red→smallest-fix-green; test-hygiene: green-baseline→refactor-tests→suite-contract; test-coverage: write-passing-tests→mutation-per-file→bug-protocol)',
      model: 'opus',
    },
    { title: 'Simplify', detail: '/simplify on changed files', model: 'sonnet' },
    { title: 'Polish', detail: 'prettier --write + CHANGELOG line', model: 'haiku' },
    { title: 'Verify', detail: 'test-runner full scope, bounded fix loop', model: 'sonnet' },
    {
      title: 'Review',
      detail: 'correctness / security / simplification reviewers in parallel',
      model: 'sonnet',
    },
  ],
};

// ── Policy (tune here) ───────────────────────────────────────────────────────
// Workers MUST have an explicit model or they inherit Fable (the whole point is
// they don't). opus/sonnet/haiku are all cheaper than Fable; pick by difficulty,
// not a fixed ranking. Implement is the quality-critical step → opus/high.
const MODEL = {
  implement: 'opus', // TEST+BUILD+SECURE: correctness matters most here
  simplify: 'sonnet', // needs judgment, not mechanical
  polish: 'haiku', // pure mechanics: formatter + one changelog line
  verify: 'sonnet', // diagnoses failures
  fix: 'sonnet', // fixes verify failures
  review: 'sonnet', // dimension reviewers
};
const EFFORT = {
  implement: 'high',
  simplify: 'medium',
  polish: 'low',
  verify: 'medium',
  fix: 'high',
  review: 'medium',
};
const MAX_FIX_ATTEMPTS = 2; // bounded; if still red, hand back to Fable rather than loop forever

// ── Approved plan (from Fable, via args) ─────────────────────────────────────
const plan = args || {};
const GOAL = plan.goal || '(no goal provided)';
const APPROACH = plan.approach || plan.plan || '';
const FILES = Array.isArray(plan.files) ? plan.files : [];
const EDGE_CASES = Array.isArray(plan.edgeCases) ? plan.edgeCases : [];
const FILE_LIST = FILES.length ? FILES.join(', ') : '(worker to determine from approach)';
// 'feature' (default: test-first red→green), 'refactor' (behavior-preserving:
// green-baseline → preserve-contract), 'bugfix' (reproduce with a failing
// test → smallest fix), 'test-hygiene' (refactor tests without weakening the
// suite), or 'test-coverage' (add tests for existing code). Set via args.mode.
const MODES = ['feature', 'refactor', 'bugfix', 'test-hygiene', 'test-coverage'];
const MODE = MODES.includes(plan.mode) ? plan.mode : 'feature';
// Test modes change/add ONLY test files (plus sanctioned additions like data-testid).
const TEST_MODE = MODE === 'test-hygiene' || MODE === 'test-coverage';

const CONVENTIONS = `Follow CLAUDE.md strictly: types in src/types/ (never inline in routes), Zod-validate all API input, Drizzle only (no raw SQL), logger from src/lib/logger.ts (never console.log), JSDoc on exported fns, semantic design tokens only (no hardcoded colors). Match surrounding code idiom. Do NOT edit docs/architecture.md, .env, infra/, or .github/workflows/ — flag if they need changing instead.`;

// ── Schemas ──────────────────────────────────────────────────────────────────
const IMPLEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'filesChanged',
    'testsAdded',
    ...(MODE === 'refactor'
      ? ['baselineGreen', 'green', 'contractPreserved']
      : MODE === 'bugfix'
        ? ['red', 'green', 'mutationCheck', 'rootCause', 'techDebtNote']
        : MODE === 'test-hygiene'
          ? ['baselineGreen', 'green', 'suiteContract']
          : MODE === 'test-coverage'
            ? ['green', 'mutationChecks', 'bugsDiscovered']
            : ['red', 'green', 'mutationCheck']),
    'securityScoped',
    'securityNotes',
    'docsImpact',
  ],
  properties: {
    summary: { type: 'string', description: 'One-paragraph description of what was built/changed' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsAdded: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Test files + case names added (feature: the failing-first tests; refactor: characterization tests only where coverage was thin — may be empty; bugfix: the failing repro test)',
    },
    green: { type: 'boolean', description: 'Full suite passes after the change' },
    // feature mode
    red: { type: 'boolean', description: 'feature: tests confirmed failing before implementation' },
    mutationCheck: {
      type: 'string',
      description:
        'feature: result of temporarily breaking impl to confirm a key test fails, then reverting',
    },
    // bugfix mode
    rootCause: {
      type: 'string',
      description: 'bugfix: the confirmed root cause (file:line + why the bug happens)',
    },
    techDebtNote: {
      type: 'string',
      description:
        'bugfix: design issue the bug revealed that is out of scope for the smallest fix (candidate for TECH_DEBT.md), or "none"',
    },
    // refactor + test-hygiene modes
    baselineGreen: {
      type: 'boolean',
      description:
        'refactor/test-hygiene: full suite was green BEFORE the change (regression baseline)',
    },
    // test-hygiene mode
    suiteContract: {
      type: 'string',
      description:
        'test-hygiene: before/after it()/test() and .skip counts for the files in scope, plus how you verified no assertion was removed or loosened and no test now escapes the MSW tripwire',
    },
    // test-coverage mode
    mutationChecks: {
      type: 'array',
      items: { type: 'string' },
      description:
        'test-coverage: one entry per new test file — what you temporarily broke in the implementation, which test went red, confirmation you reverted',
    },
    bugsDiscovered: {
      type: 'array',
      items: { type: 'string' },
      description:
        'test-coverage: real product bugs the new tests exposed (file:line + what is wrong), NOT fixed inline — empty array if none',
    },
    contractPreserved: {
      type: 'string',
      description:
        'refactor: how you verified no public contract changed (exports, API response shapes + status codes, exported types unchanged; tsc clean)',
    },
    securityScoped: {
      type: 'boolean',
      description:
        'Whether security checks 1-6 applied (external input / HTML / URL fetch / API route touched)',
    },
    securityNotes: {
      type: 'string',
      description: 'Findings from scoped security checks, or why skipped',
    },
    docsImpact: {
      type: 'string',
      description:
        'Which docs (module spec, README, .env.example, CLAUDE.md registry) need updating, or "none". Do NOT edit architecture.md yourself.',
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
    failures: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete failure messages if any',
    },
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
        required: ['file', 'line', 'severity', 'category', 'summary'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
};

// ── Steps 2-4: implement (one tightly-coupled worker) ────────────────────────
const FEATURE_STEPS = `Do feature.md steps 2-4 in order, no shortcuts:
2. TEST (red first): write failing tests BEFORE code — unit tests for new pure logic, integration tests for new/changed API routes (import the route handler directly, mock external HTTP via setupHandlers from __tests__/mocks/server.ts). Run \`npm run test -- --reporter=verbose\` and confirm they FAIL (set red). Also review existing tests for the touched modules and update/remove any that assert now-obsolete behavior.
3. BUILD (green): implement to make the tests pass, using existing patterns from similar components/routes. Then do a MUTATION CHECK — temporarily break one key assertion in the implementation, confirm the corresponding test goes red, then REVERT; report what you observed in mutationCheck. Set green.
4. SECURE: if the change touches external input, HTML rendering, URL fetching, or API routes, run security-audit.md checks 1-6 scoped to the changed files (XSS/sanitize-before-render, SSRF/validateUrl, Zod input validation, no raw SQL, no secrets, safe FTS5 escaping). Report. Skip only for purely internal UI with no data flow, and say so.`;

const REFACTOR_STEPS = `This is a REFACTOR: behavior-preserving, no new functionality. Do these in order, no shortcuts:
2. BASELINE (green first): run \`npm run test\` and confirm the FULL suite is green BEFORE you touch anything — this is your regression net (set baselineGreen). If it is already red, STOP and report instead of refactoring on a broken base.
3. REFACTOR (stay green): apply the change using existing patterns. Preserve ALL observable behavior and public contracts — module exports, function signatures, API response shapes + status codes, and exported types must stay IDENTICAL. Add characterization tests ONLY where the code you touch lacks coverage (testsAdded may be empty if coverage is already adequate). Re-run the full suite and confirm it is still green (set green).
4. PRESERVE + SECURE: in contractPreserved, state how you verified no public contract changed (exports unchanged, response shapes/status codes identical, \`npm run typecheck\` clean). Run security-audit.md checks 1-6 only if the refactor touches request handling or external input; otherwise set securityScoped false and say N/A.`;

const BUGFIX_STEPS = `This is a BUGFIX: the SMALLEST fix that addresses the root cause, no drive-by changes. Do these in order, no shortcuts:
2. REPRODUCE (red first): confirm the root cause in the code and record it in rootCause (file:line + why the bug happens). Then write a failing test that reproduces the bug — a unit test if it's pure logic, an integration test if it's API-route behavior (import the route handler directly, mock external HTTP via setupHandlers from __tests__/mocks/server.ts). Run \`npm run test -- --reporter=verbose\` and confirm it FAILS for the bug's reason, not a setup error (set red). If an existing test wrongly asserts the buggy behavior, correct that test too.
3. FIX (green): apply the SMALLEST fix that addresses the root cause — no refactoring, no new features, no fixing adjacent code smells (put those in techDebtNote instead; "none" if nothing). Run the repro test, then the full suite for regressions. MUTATION CHECK: temporarily revert the fix, confirm the repro test goes red again, then re-apply; report what you observed in mutationCheck. Set green.
4. SECURE: if the fix touches external input, HTML rendering, URL fetching, or API routes, run security-audit.md checks 1-6 scoped to the changed files (XSS/sanitize-before-render, SSRF/validateUrl, Zod input validation, no raw SQL, no secrets, safe FTS5 escaping). Report. Skip only for purely internal logic with no data flow, and say so.`;

const TEST_HYGIENE_STEPS = `This is TEST HYGIENE: refactor existing test files without weakening the suite. Product code stays untouched EXCEPT sanctioned additions explicitly named in the approach (e.g. adding data-testid attributes to components for E2E selectors — additive only, no logic changes). Never touch data/ (the dev database lives there). Do these in order, no shortcuts:
2. BASELINE (green first): run \`npm run test\` (and \`npx playwright test\` if e2e/ files are in scope) and confirm green BEFORE touching anything (set baselineGreen). If already red, STOP and report instead of refactoring on a broken base. Record the baseline contract for the files in scope: it()/test() count and .skip/.only count per file.
3. REFACTOR TESTS (stay green): apply the change. The suite contract is inviolable — no test deleted, no assertion removed or loosened (e.g. toEqual → toBeDefined), no new .skip/.only, every vi.stubGlobal('fetch', …) paired with vi.unstubAllGlobals() in afterAll, no module-level process.env writes left unrestored (use vi.stubEnv). Follow CLAUDE.md Testing Conventions (MSW tripwire, createTestDb, data-testid for E2E selectors — never CSS classes, no waitForTimeout: wait on the specific response or a locator assertion instead). Re-run the touched files, then the full suite; confirm green (set green).
4. CONTRACT: in suiteContract, report before/after it() and .skip counts for the files in scope and state concretely how you verified nothing was weakened (e.g. diffed each file for removed assertions). securityScoped is false unless you touched product request-handling code; say so in securityNotes.`;

const TEST_COVERAGE_STEPS = `This is TEST COVERAGE: add tests for EXISTING code. Do NOT modify product code — not even to "fix" something a test exposes (see step 4). Do these in order, no shortcuts:
2. WRITE (pass immediately): study each target module/route's ACTUAL current behavior first, then write tests asserting it. Unit: __tests__/unit/<module>.test.ts — pure logic, no DB/network/fs. Integration: __tests__/integration/<module>.test.ts — createTestDb() from __tests__/integration/setup.ts, import the route handler directly, mock external HTTP via setupHandlers from __tests__/mocks/server.ts. New tests for correct existing code must pass on FIRST run: \`npm run test -- <files>\`, then the full suite (set green). If the target is sanitization/security-adjacent, include hostile-input cases (script tags, event handlers, javascript: URLs) per architecture.md §16.
3. MUTATION CHECK (per new test file): temporarily break the implementation each file covers, confirm at least one of its tests goes red, then REVERT the implementation and re-run to green. Record each check in mutationChecks. A new test that cannot go red is not a test — strengthen it until it can.
4. BUG PROTOCOL: if a test exposes a REAL product bug (actual behavior is wrong, not just undocumented), do NOT fix the product code. Write the test asserting the CORRECT behavior, mark it it.skip with a "// BUG:" comment, and record it in bugsDiscovered (file:line + what is wrong). Fixing it is a separate mode:'bugfix' run — that is Fable's dispatch decision, not yours. bugsDiscovered is [] if none.`;

const STEPS_BY_MODE = {
  feature: FEATURE_STEPS,
  refactor: REFACTOR_STEPS,
  bugfix: BUGFIX_STEPS,
  'test-hygiene': TEST_HYGIENE_STEPS,
  'test-coverage': TEST_COVERAGE_STEPS,
};

phase('Implement');
const implement = await agent(
  `You are implementing an approved Gleanary change (mode: ${MODE}). Work in the repo working tree.

GOAL: ${GOAL}
APPROVED APPROACH: ${APPROACH}
FILES IN SCOPE: ${FILE_LIST}
EDGE CASES TO COVER: ${EDGE_CASES.length ? EDGE_CASES.join('; ') : '(derive from approach)'}

${STEPS_BY_MODE[MODE]}

${CONVENTIONS}

Return the structured result. Your final message is data, not prose.`,
  {
    label:
      MODE === 'refactor'
        ? 'implement:refactor'
        : MODE === 'bugfix'
          ? 'implement:reproduce+fix'
          : MODE === 'test-hygiene'
            ? 'implement:refactor-tests'
            : MODE === 'test-coverage'
              ? 'implement:add-tests'
              : 'implement:test+build+secure',
    phase: 'Implement',
    model: MODEL.implement,
    effort: EFFORT.implement,
    schema: IMPLEMENT_SCHEMA,
  },
);

if (!implement) {
  return {
    status: 'aborted',
    at: 'Implement',
    reason: 'implement worker returned null (skipped or died)',
  };
}
log(
  `Implemented (${MODE}): ${implement.filesChanged.length} files, ${implement.testsAdded.length} tests · ${
    MODE === 'refactor' || MODE === 'test-hygiene'
      ? `baselineGreen=${implement.baselineGreen}`
      : MODE === 'test-coverage'
        ? `mutationChecks=${(implement.mutationChecks || []).length} bugsDiscovered=${(implement.bugsDiscovered || []).length}`
        : `red=${implement.red}`
  } green=${implement.green}`,
);

// ── Step 5: SIMPLIFY ─────────────────────────────────────────────────────────
phase('Simplify');
const simplify = await agent(
  `Run the /simplify quality pass on the files just changed in this task and APPLY the fixes in the working tree.
Changed files: ${implement.filesChanged.join(', ')}
Look for: reuse of existing helpers instead of new code, dead/duplicated logic, over-complex control flow, needless allocations, wrong altitude. Quality only — do NOT hunt for bugs, do NOT change behavior or public contracts.${
    TEST_MODE
      ? ' These are TEST files: never remove or loosen an assertion, never delete a test case, never add .skip — simplify structure only (shared setup, helper reuse like createDbMock/createTestDb).'
      : ''
  } ${CONVENTIONS}
Return what you changed.`,
  {
    label: 'simplify',
    phase: 'Simplify',
    model: MODEL.simplify,
    effort: EFFORT.simplify,
    schema: CHANGES_SCHEMA,
  },
);

// ── Pre-commit mechanics: prettier + CHANGELOG (feature.md step 6 / CLAUDE.md) ─
phase('Polish');
const polish = await agent(
  `Two mechanical pre-commit tasks, nothing else:
1. Run \`./node_modules/.bin/prettier --write .\` (the local binary directly, NOT npx) to auto-fix formatting.
2. Add ONE line under the "Unreleased" heading in CHANGELOG.md describing this change: "${implement.summary}". Match the style of existing entries.
Do not touch any other file. Return the changelog line you added.`,
  {
    label: 'polish:prettier+changelog',
    phase: 'Polish',
    model: MODEL.polish,
    effort: EFFORT.polish,
    schema: CHANGES_SCHEMA,
  },
);

// ── Step 6: VERIFY (test-runner, full scope) with a bounded fix loop ──────────
phase('Verify');
// Flakiness fixes need a stability proof, not one lucky green pass.
const e2eTouched = implement.filesChanged.filter((f) => f.startsWith('e2e/'));
const stabilityCheck =
  MODE === 'test-hygiene' && e2eTouched.length
    ? `\nSTABILITY PROOF: this run changed E2E specs to fix flakiness — additionally run \`npx playwright test ${e2eTouched.join(' ')} --repeat-each=3\` and report the result in the e2e field. Any failure across the repeats counts as a verify failure.`
    : '';
const verifyPrompt = `Run the FULL verification suite for Gleanary: lint, typecheck, unit+integration tests, and E2E. Report each channel's result and any concrete failure messages. Do not fix anything — just report.${stabilityCheck}`;
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
    `The full verification suite is failing after implementing this change. Fix ONLY what's needed to make it pass, without weakening tests or changing the approved behavior. If a test now asserts obsolete behavior, update the test to the correct new expectation (don't delete coverage). ${CONVENTIONS}
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
if (verify && !verify.passed) {
  log(
    `Still failing after ${MAX_FIX_ATTEMPTS} fix attempts — handing back to Fable for judgment (no further auto-fix).`,
  );
}

// ── Step 7: CODE REVIEW (dimensions in parallel, read-only) ──────────────────
phase('Review');
const DIMENSIONS = [
  {
    key: 'correctness',
    brief:
      'Correctness & logic bugs: edge cases, error handling, off-by-one, null/undefined, async races, incorrect status codes, missing validation. Prioritize failures a real input could trigger.' +
      (MODE === 'refactor'
        ? ' This is a REFACTOR: also flag ANY behavior change vs the original — differing output, status code, ordering, or a moved/renamed/removed public export — since it must be behavior-preserving.'
        : MODE === 'bugfix'
          ? ' This is a BUGFIX: check the fix addresses the stated root cause rather than masking the symptom, and flag any change beyond the smallest fix (scope creep).'
          : MODE === 'test-hygiene'
            ? ' This is a TEST refactor: flag tests that could now pass against broken code (stale stub leaking between tests, mock answering instead of the real assertion, race hidden by a broad wait), and any product-code change beyond sanctioned additive testids.'
            : MODE === 'test-coverage'
              ? ' These are NEW tests for existing code: flag tautological assertions (asserting the mock, expect(true)), tests coupled to implementation details instead of behavior, and missing documented error-status cases for covered routes.'
              : ''),
  },
  TEST_MODE
    ? {
        key: 'no-weakening',
        brief:
          'Suite integrity: diff each touched test file against HEAD and flag any deleted it()/test(), removed or loosened assertion (e.g. toEqual → toBeTruthy), new .skip/.only (except a documented "// BUG:" skip recorded in bugsDiscovered), broadened mock that now answers what the test used to verify, or fetch/env stubbing left unrestored (stubGlobal without unstubAllGlobals, module-level process.env writes).',
      }
    : {
        key: 'security',
        brief:
          'Security (audit checks 1-6): unsanitized HTML → XSS, unvalidated URLs → SSRF, missing Zod validation, raw SQL, leaked/hardcoded secrets, unescaped FTS5. Only for the changed files.',
      },
  {
    key: 'simplification',
    brief:
      'Reuse, simplification, efficiency: duplicated logic, an existing helper that should have been used, needless complexity or allocations, wrong altitude. Not bugs.',
  },
];
const reviews = await parallel(
  DIMENSIONS.map(
    (d) => () =>
      agent(
        `Code-review ONLY the working-tree changes for this task (the diff), through the ${d.key} lens.
${d.brief}
Changed files: ${implement.filesChanged.join(', ')}
Report concrete, verifiable findings with file + line. Do not restate style the formatter handles. Empty array if clean.`,
        {
          label: `review:${d.key}`,
          phase: 'Review',
          model: MODEL.review,
          effort: EFFORT.review,
          schema: REVIEW_SCHEMA,
        },
      ),
  ),
);
const findings = reviews
  .filter(Boolean)
  .flatMap((r) => r.findings || [])
  .sort(
    (a, b) =>
      ({ high: 0, medium: 1, low: 2 })[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity],
  );

// ── Bundle for Fable's final review + commit decision ────────────────────────
return {
  status: verify && verify.passed ? 'green' : 'needs-attention',
  mode: MODE,
  goal: GOAL,
  implement,
  simplify,
  changelog: polish,
  verify,
  fixAttempts: fixLog,
  reviewFindings: findings,
  reminders: {
    docsImpact: implement.docsImpact,
    ...(MODE === 'bugfix' ? { techDebtNote: implement.techDebtNote } : {}),
    ...(MODE === 'test-coverage' ? { bugsDiscovered: implement.bugsDiscovered } : {}),
    note:
      'PLAN + approval happened inline before this run. Fable to now: read reviewFindings, decide which to fix, address docsImpact (architecture.md needs human approval), then commit with a conventional message.' +
      (MODE === 'test-coverage'
        ? ' If bugsDiscovered is non-empty: each entry has a skipped test asserting correct behavior — dispatch a mode:bugfix run per bug (the fix un-skips the test as its repro).'
        : ''),
  },
};
