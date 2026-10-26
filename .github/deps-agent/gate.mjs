// Deterministic merge gate for the Dependabot agent (.github/workflows/deps-agent.yml).
//
// Pure functions only: the CLI (cli.mjs) collects facts from GitHub and the npm
// registry, this module decides. The LLM assessment is ONE input (the `verdict`
// rule); it can only turn a permitted merge into an escalation, never the
// reverse. Policy rationale lives in policy.md next to this file.

/** Check runs that must be green on the PR head SHA (names from ci.yml). */
export const REQUIRED_CHECKS = [
  'Lint',
  'Type-check',
  'Unit + Integration Tests',
  'E2E Tests (critical paths)',
];

export const LIMITS = {
  /** Days a release must have been public before we merge it (detection window). */
  cooldownDays: 7,
  /** New transitive packages one bump may add before a human looks. */
  maxNewPackages: 15,
};

/**
 * hard     : never overridable; failure escalates.
 * soft     : the owner can override with `/deps merge`.
 * transient: failure means "wait for the next run", not escalate.
 */
export const RULE_KIND = {
  author: 'hard',
  ecosystem: 'hard',
  injection: 'hard',
  files: 'hard',
  manifest: 'hard',
  checks: 'hard',
  malware: 'hard',
  semver: 'soft',
  installScripts: 'soft',
  newPackages: 'soft',
  cooldown: 'soft',
  provenance: 'soft',
  publisher: 'soft',
  audit: 'soft',
  codeReview: 'soft',
  verdict: 'soft',
  mergeable: 'transient',
  fresh: 'transient',
  mainHealthy: 'transient',
};

export const DEPENDABOT_LOGIN = 'dependabot[bot]';
export const NPM_BRANCH_PREFIX = 'dependabot/npm_and_yarn/';
export const LOCK_FILES = new Set(['package.json', 'package-lock.json']);
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Parse the `updated-dependencies` YAML block Dependabot puts in its commit message.
 * @param {string} message - the PR's head commit message
 * @returns {{name: string, type: string, version: string}[]} declared updates (empty if none found)
 */
export function parseUpdatedDependencies(message) {
  const updates = [];
  let current = null;
  const unquote = (v) => v.replace(/^['"]|['"]$/g, '');
  for (const line of message.split('\n')) {
    const name = line.match(/^- dependency-name:\s*(\S+)/);
    if (name) {
      current = { name: unquote(name[1]), type: '', version: '' };
      updates.push(current);
      continue;
    }
    const field = line.match(/^\s+dependency-(type|version):\s*(\S+)/);
    if (field && current) current[field[1]] = unquote(field[2]);
  }
  return updates;
}

/**
 * The package versions a PR moves to. A rebase keeps it, so it identifies "this
 * dependency change" independently of the commit.
 * @param {{name: string, version?: string}[]} updates - declared updates
 * @returns {string} sorted `name@version` list
 */
export function updatesKey(updates) {
  return updates
    .map((u) => `${u.name}@${u.version || '?'}`)
    .sort()
    .join(',');
}

/**
 * Cache key for Claude's assessment: the same package versions under the same policy and
 * the same CI outcome get the same assessment, so a Dependabot rebase does not re-run it.
 * A newly red CI changes the key, so the failure still gets read.
 * @param {object} p
 * @param {{name: string, version?: string}[]} p.updates - declared updates
 * @param {{status: string, conclusion: string|null}[]} p.checks - head SHA check runs
 * @param {string} p.policyHash - fingerprint of policy.md, prompt.md and the schema
 * @returns {string} the cache key
 */
export function assessmentKey({ updates, checks, policyHash }) {
  const ci = failedChecks(checks).length ? 'red' : 'green';
  return `${policyHash}|ci-${ci}|${updatesKey(updates)}`;
}

/**
 * Classify a version change. 0.x minors and 0.0.x patches are treated as majors
 * (semver gives no compatibility promise below 1.0), as are prereleases.
 * @param {string} from - installed version before the bump
 * @param {string} to - installed version after the bump
 * @returns {'major'|'minor'|'patch'|'none'} the effective update type
 */
export function classifyBump(from, to) {
  if (from === to) return 'none';
  const parse = (v) => {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
    return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: Boolean(m[4]) } : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b || a.pre || b.pre) return 'major';
  if (a.major !== b.major) return 'major';
  if (a.major === 0 && (a.minor !== b.minor || a.minor === 0)) return 'major';
  return a.minor !== b.minor ? 'minor' : 'patch';
}

/**
 * Compare two lockfiles (v3 `packages` map).
 * @param {{packages?: Record<string, {version?: string, hasInstallScript?: boolean}>}} base
 * @param {{packages?: Record<string, {version?: string, hasInstallScript?: boolean}>}} head
 * @returns {{added: string[], newInstallScripts: string[],
 *   changed: {name: string, from: string|null, to: string, installScript: boolean}[]}}
 *   lock keys added; keys that gained an install script (new package, or existing one that
 *   did not have one); and every introduced version, direct or transitive (added, or version
 *   changed), deduplicated by `name@to` and sorted
 */
export function diffLockfiles(base, head) {
  const b = base.packages ?? {};
  const h = head.packages ?? {};
  const added = [];
  const newInstallScripts = [];
  const changed = new Map();
  for (const [key, entry] of Object.entries(h)) {
    if (!key) continue; // root project entry
    if (!(key in b)) added.push(key);
    if (entry.hasInstallScript && !b[key]?.hasInstallScript) newInstallScripts.push(key);
    if (entry.version && b[key]?.version !== entry.version) {
      const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      changed.set(`${name}@${entry.version}`, {
        name,
        from: b[key]?.version ?? null,
        to: entry.version,
        installScript: Boolean(entry.hasInstallScript),
      });
    }
  }
  const sorted = [...changed.entries()].sort(([a], [z]) => a.localeCompare(z));
  return { added, newInstallScripts, changed: sorted.map(([, c]) => c) };
}

/**
 * Install-time code the bump introduces: packages that gain an install script, and new
 * versions of packages that already run one (a hijacked better-sqlite3 or esbuild release
 * would run its script during `npm ci` in the Docker build).
 * @param {{newInstallScripts: string[],
 *   changed: {name: string, from: string|null, to: string, installScript: boolean}[]}} lock
 * @returns {string[]} human-readable offenders
 */
export function installScriptChanges(lock) {
  const gained = new Set(lock.newInstallScripts.map((key) => key.replace(/^.*node_modules\//, '')));
  // A package that gains a script while changing version is reported once, as "new script".
  const updated = lock.changed
    .filter((c) => c.installScript && c.from && !gained.has(c.name))
    .map((c) => `${c.name} ${c.from}→${c.to} (runs an install script)`);
  return [...[...gained].map((name) => `${name} (new script)`), ...updated];
}

/**
 * True when package.json changed only in the version ranges of the declared updates.
 * @param {Record<string, unknown>} base - package.json on main
 * @param {Record<string, unknown>} head - package.json on the PR head
 * @param {string[]} names - declared dependency names
 * @returns {boolean} whether the manifest change is limited to those ranges
 */
export function manifestChangeIsScoped(base, head, names) {
  const strip = (pkg) => {
    const copy = structuredClone(pkg);
    for (const field of DEP_FIELDS) {
      const deps = copy[field];
      if (deps && typeof deps === 'object') for (const n of names) delete deps[n];
    }
    return copy;
  };
  return JSON.stringify(strip(base)) === JSON.stringify(strip(head));
}

const result = (id, status, detail) => ({ id, kind: RULE_KIND[id], status, detail });
/** Pass when `offenders` is empty, else fail listing them. */
const unless = (id, offenders, failMsg, passMsg) =>
  offenders.length ? result(id, 'fail', `${failMsg}: ${offenders.join(', ')}`) : result(id, 'pass', passMsg);
const TRI = { true: 'pass', false: 'fail' };
/** `name@version` of a registry fact. */
const label = (r) => `${r.name}@${r.version}`;

/**
 * Required checks that have not completed on the head SHA.
 * @param {{name: string, status: string}[]} checks - from latestCheckRuns
 * @returns {string[]} required check names still missing or running
 */
export function pendingChecks(checks) {
  const byName = new Map(checks.map((c) => [c.name, c]));
  return REQUIRED_CHECKS.filter((n) => byName.get(n)?.status !== 'completed');
}

/**
 * Completed check runs that did not succeed.
 * @param {{name: string, status: string, conclusion: string|null}[]} checks - from latestCheckRuns
 * @returns {{name: string}[]} the failed runs
 */
export function failedChecks(checks) {
  return checks.filter(
    (c) => c.status === 'completed' && !['success', 'skipped', 'neutral'].includes(c.conclusion),
  );
}

/** Minutes after a push with no check run at all before we call CI missing, not slow. */
const NO_CI_GRACE_MINUTES = 60;

function checksRule(checks, headCommittedAt, now) {
  const failed = failedChecks(checks);
  if (failed.length) return unless('checks', failed.map((c) => c.name), 'failed', '');
  const pending = pendingChecks(checks);
  if (!pending.length) return result('checks', 'pass', 'all required checks green');
  if (!checks.length) {
    const age = headCommittedAt ? (now.getTime() - new Date(headCommittedAt).getTime()) / 60_000 : 0;
    return age > NO_CI_GRACE_MINUTES
      ? result('checks', 'fail', `no CI ran on this commit within ${NO_CI_GRACE_MINUTES} min`)
      : result('checks', 'pending', 'waiting for CI to start');
  }
  // Everything that ran has finished, yet a required name never appeared: a CI job was
  // renamed or removed. Escalate instead of waiting forever.
  const idle = checks.length > 0 && checks.every((c) => c.status === 'completed');
  return idle
    ? unless('checks', pending, 'required check never ran (renamed in ci.yml?)', '')
    : result('checks', 'pending', `waiting on: ${pending.join(', ')}`);
}

/**
 * Release age for every introduced version, direct or transitive. Dependabot's cooldown
 * only delays the package it bumps; the lockfile can still pull a transitive version
 * published minutes earlier (how the 2025 chalk/debug hijack reached most projects).
 * A young transitive version waits until it ages; a young direct version (in practice a
 * security update, which skips Dependabot's cooldown) escalates so the owner can
 * fast-track it; an unknown publish time escalates.
 */
function cooldownRule(registry, now) {
  const cutoff = now.getTime() - LIMITS.cooldownDays * 86_400_000;
  const young = (r) => r.publishedAt && new Date(r.publishedAt).getTime() > cutoff;
  const blocking = registry.filter((r) => !r.publishedAt || (r.direct && young(r)));
  if (blocking.length) {
    return unless('cooldown', blocking.map(label), `published < ${LIMITS.cooldownDays}d ago (or unknown)`, '');
  }
  const aging = registry.filter(young);
  return aging.length
    ? result('cooldown', 'pending', `waiting for dependency versions to age: ${aging.map(label).join(', ')}`)
    : result('cooldown', 'pass', `all ${registry.length} introduced versions older than ${LIMITS.cooldownDays}d`);
}

/** Suspicious findings from Claude's review of the published code diff. */
function codeReviewRule(assessment) {
  if (!assessment) return result('codeReview', 'pending', 'not assessed yet');
  const review = assessment.codeReview;
  if (!review) return result('codeReview', 'fail', 'assessment has no code review');
  return unless(
    'codeReview',
    review.suspicious.map((s) => `${s.file}: ${s.finding}`),
    'suspicious code',
    `nothing suspicious (coverage: ${review.coverage})`,
  );
}

/**
 * Evaluate every gate rule against collected facts.
 * @param {object} f - facts gathered by cli.mjs `collectFacts`
 * @param {string} f.author - PR author login
 * @param {string} f.branch - PR head branch
 * @param {string[]} f.files - changed file paths
 * @param {{name: string, type: string, from: string|null, to: string|null}[]} f.updates
 * @param {boolean} f.manifestScoped - result of manifestChangeIsScoped
 * @param {{name: string, status: string, conclusion: string|null}[]} f.checks - head SHA check runs
 * @param {string|null} [f.headCommittedAt] - when the head commit was created (no-CI timeout)
 * @param {{added: string[], newInstallScripts: string[],
 *   changed: {name: string, from: string|null, to: string, installScript: boolean}[]}} f.lock
 *   result of diffLockfiles
 * @param {{name: string, version: string, direct: boolean, publishedAt: string|null,
 *   prevAttested: boolean, attested: boolean, prevPublisher: string|null,
 *   publisher: string|null}[]} f.registry - one per introduced version (direct and transitive)
 * @param {string[]} f.newAdvisories - advisory ids present on head but not on main
 * @param {string[]|null} f.malware - GitHub malware advisories for introduced versions
 *   (null = feed unavailable)
 * @param {boolean|null} f.mergeable - GitHub mergeability (null = still computing)
 * @param {boolean} f.fresh - head contains main, or main has not touched package*.json since
 * @param {'healthy'|'pending'|'broken'} f.main - main CI + deploy state
 * @param {{verdict: string, injectionSuspected?: boolean,
 *   codeReview?: {coverage: string, suspicious: {file: string, finding: string}[]}}|null} f.assessment
 *   LLM assessment for this head
 * @param {Date} f.now - evaluation time
 * @returns {{id: string, kind: string, status: 'pass'|'fail'|'pending', detail: string}[]}
 */
export function evaluateRules(f) {
  const bumps = f.updates.map((u) => ({
    ...u,
    kind: u.from && u.to ? classifyBump(u.from, u.to) : 'major',
  }));
  const injected = Boolean(f.assessment?.injectionSuspected);

  return [
    result('author', TRI[f.author === DEPENDABOT_LOGIN], `author ${f.author}`),
    result('ecosystem', TRI[f.branch.startsWith(NPM_BRANCH_PREFIX)], `branch ${f.branch}`),
    result(
      'injection',
      TRI[!injected],
      injected ? 'PR or changelog text tried to instruct the agent' : 'no instructions found',
    ),
    unless(
      'files',
      f.files.filter((p) => !LOCK_FILES.has(p)),
      'unexpected files',
      'package.json/lockfile only',
    ),
    f.updates.length
      ? result(
          'manifest',
          TRI[f.manifestScoped],
          f.manifestScoped
            ? 'only declared version ranges changed'
            : 'package.json changed beyond the declared updates',
        )
      : result('manifest', 'fail', 'no updated-dependencies metadata in the commit'),
    checksRule(f.checks, f.headCommittedAt, f.now),
    f.malware
      ? unless('malware', f.malware, 'malware advisory', 'no malware advisory for any introduced version')
      : result('malware', 'pending', 'malware feed unavailable, retrying next run'),
    result(
      'semver',
      TRI[!bumps.some((u) => u.kind === 'major')],
      bumps.map((u) => `${u.name} ${u.from ?? '?'}→${u.to ?? '?'} (${u.kind})`).join('; '),
    ),
    unless('installScripts', installScriptChanges(f.lock), 'install-time code', 'no install script added or updated'),
    result(
      'newPackages',
      TRI[f.lock.added.length <= LIMITS.maxNewPackages],
      `${f.lock.added.length} new package(s) in lockfile`,
    ),
    cooldownRule(f.registry, f.now),
    unless(
      'provenance',
      f.registry.filter((r) => r.prevAttested && !r.attested).map(label),
      'provenance dropped',
      'no provenance regression in any introduced version',
    ),
    // Direct packages only: maintainer rotation in transitive packages is common enough
    // that it would escalate most bumps; transitive versions get cooldown, provenance,
    // malware and (within budget) the code review instead.
    unless(
      'publisher',
      f.registry
        .filter((r) => r.direct && (!r.publisher || (r.prevPublisher && r.publisher !== r.prevPublisher)))
        .map((r) => `${r.name} (${r.prevPublisher ?? '?'} → ${r.publisher ?? '?'})`),
      'publisher changed',
      'same npm publisher as the previous version',
    ),
    unless('audit', f.newAdvisories, 'new advisories', 'no new advisories'),
    codeReviewRule(f.assessment),
    f.assessment
      ? result('verdict', TRI[f.assessment.verdict === 'merge'], `assessment: ${f.assessment.verdict}`)
      : result('verdict', 'pending', 'not assessed yet'),
    result(
      'mergeable',
      TRI[f.mergeable] ?? 'pending',
      f.mergeable === false ? 'merge conflict (waiting for a rebase)' : `mergeable: ${f.mergeable}`,
    ),
    result(
      'fresh',
      TRI[f.fresh],
      f.fresh ? 'dependency state matches main' : 'main changed package*.json since this PR was built',
    ),
    result('mainHealthy', TRI[f.main === 'healthy'], `main is ${f.main}`),
  ];
}

/**
 * Turn rule results into one outcome.
 * @param {object} p
 * @param {{kind: string, status: string}[]} p.rules - from evaluateRules
 * @param {'off'|'shadow'|'merge'} p.mode - DEPS_AGENT_MODE
 * @param {boolean} p.override - the owner commented `/deps merge` on this head SHA
 * @param {boolean} p.held - the PR carries the deps:hold label
 * @param {boolean} p.slotFree - no merge has happened yet in this run
 * @returns {'held'|'escalate'|'wait'|'would-merge'|'queued'|'merge'} the outcome
 */
export function decide({ rules, mode, override, held, slotFree }) {
  if (held) return 'held';
  const failing = (kind) => rules.some((r) => r.kind === kind && r.status === 'fail');
  if (failing('hard')) return 'escalate';
  if (failing('soft') && !override) return 'escalate';
  // An owner override stands in for the assessment, so a pending verdict does not block it.
  const blocking = rules.filter(
    (r) => r.status !== 'pass' && !(override && r.kind === 'soft'),
  );
  if (blocking.length) return 'wait';
  if (mode !== 'merge') return 'would-merge';
  return slotFree ? 'merge' : 'queued';
}

/**
 * Keep the latest run per check name (re-runs create new check runs on the same SHA).
 * @param {{id: number, name: string, status: string, conclusion: string|null}[]} runs
 * @returns {{name: string, status: string, conclusion: string|null}[]} one entry per name
 */
export function latestCheckRuns(runs) {
  const byName = new Map();
  for (const r of [...runs].sort((a, b) => a.id - b.id)) {
    byName.set(r.name, { name: r.name, status: r.status, conclusion: r.conclusion });
  }
  return [...byName.values()];
}

/**
 * Classify main from its latest push CI run and the Deploy run that CI triggered.
 * A missing Deploy run 30 minutes after CI finished counts as broken, so a disabled or
 * stuck deploy pipeline escalates instead of freezing merges silently.
 * @param {{status: string, conclusion: string|null, updated_at: string}|null} ci
 * @param {{status: string, conclusion: string|null}|null} deploy
 * @param {Date} now - evaluation time
 * @returns {{state: 'healthy'|'pending'|'broken', detail: string}} main's state
 */
export function classifyMain(ci, deploy, now) {
  if (!ci || ci.status !== 'completed') return { state: 'pending', detail: 'CI on main is running' };
  if (ci.conclusion !== 'success') return { state: 'broken', detail: `CI on main: ${ci.conclusion}` };
  if (!deploy) {
    const stale = now.getTime() - new Date(ci.updated_at).getTime() > 30 * 60_000;
    return stale
      ? { state: 'broken', detail: 'no Deploy run 30 min after CI succeeded' }
      : { state: 'pending', detail: 'waiting for Deploy to start' };
  }
  if (deploy.status !== 'completed') return { state: 'pending', detail: 'Deploy is running' };
  return ['success', 'skipped'].includes(deploy.conclusion)
    ? { state: 'healthy', detail: `CI green, Deploy ${deploy.conclusion}` }
    : { state: 'broken', detail: `Deploy: ${deploy.conclusion}` };
}

/**
 * Advisory identifiers in an `npm audit --json` report.
 * @param {{vulnerabilities?: Record<string, {via: unknown[]}>}} report
 * @returns {string[]} sorted unique advisory URLs (or source ids when no URL)
 */
export function advisoryKeys(report) {
  const keys = new Set();
  for (const v of Object.values(report.vulnerabilities ?? {})) {
    for (const via of v.via) {
      if (via && typeof via === 'object') keys.add(String(via.url ?? via.source));
    }
  }
  return [...keys].sort();
}
