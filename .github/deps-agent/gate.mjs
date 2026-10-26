// Deterministic merge gate for the Dependabot agent (.github/workflows/deps-agent.yml).
//
// Pure functions only: the CLI (cli.mjs) collects facts from GitHub and the npm
// registry, this module decides. The LLM assessment is ONE input (the `verdict`
// rule); it can only turn a permitted merge into an escalation, never the
// reverse. Policy rationale lives in policy.md next to this file.

import { createHash } from 'node:crypto';

/**
 * Short hex sha256 digest, for fingerprints and dedupe keys.
 * @param {string|Buffer} data - what to fingerprint
 * @param {number} [len] - hex characters to keep
 * @returns {string} digest prefix
 */
export const shortHash = (data, len = 12) => createHash('sha256').update(data).digest('hex').slice(0, len);

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
  sources: 'hard',
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
  registry: 'transient',
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
 * Cache key for Claude's assessment: the same declared versions, the same introduced
 * lockfile versions, the same policy and the same CI outcome get the same assessment, so a
 * Dependabot rebase that leaves the lockfile alone does not re-run it. A rebase that pulls
 * new transitive versions changes the key (the code review never saw them), and a newly
 * red CI changes it too, so the failure still gets read.
 * @param {object} p
 * @param {{name: string, version?: string}[]} p.updates - declared updates
 * @param {{status: string, conclusion: string|null}[]} p.checks - head SHA check runs
 * @param {string} p.policyHash - fingerprint of policy.md, prompt.md and the schema
 * @param {string} p.lockFingerprint - lockFingerprint() of the introduced versions
 * @returns {string} the cache key
 */
export function assessmentKey({ updates, checks, policyHash, lockFingerprint }) {
  const ci = failedChecks(checks).length ? 'red' : 'green';
  return `${policyHash}|ci-${ci}|${updatesKey(updates)}|lock-${lockFingerprint}`;
}

/**
 * Fingerprint of every version the lockfile introduces. A rebase that re-resolves the
 * lockfile (new transitive versions) changes it, so a cached assessment, whose code review
 * never saw those versions, and an owner override, which approved a specific lockfile, stop
 * applying. A rebase that leaves the introduced versions alone keeps both.
 * @param {{name: string, to: string}[]} changed - diffLockfiles().changed
 * @returns {string} short hex digest
 */
export function lockFingerprint(changed) {
  const specs = changed.map((c) => `${c.name}@${c.to}`).sort();
  return shortHash(specs.join('\n'), 16);
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
 * @param {{packages?: Record<string, {version?: string, name?: string, hasInstallScript?: boolean}>}} head
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
      // An npm alias (`"string-width-cjs": "npm:string-width@4"`) is installed under the
      // alias path but published under `entry.name`: registry and malware lookups need
      // the real name.
      const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      changed.set(`${name}@${entry.version}`, {
        name,
        from: b[key]?.version ?? null,
        to: entry.version,
        installScript: Boolean(entry.hasInstallScript),
        resolved: entry.resolved ?? null,
        // Bundled (inBundle) and linked entries are never fetched on their own.
        bundled: Boolean(entry.inBundle || entry.link),
      });
    }
  }
  const sorted = [...changed.entries()].sort(([a], [z]) => a.localeCompare(z));
  return { added, newInstallScripts, changed: sorted.map(([, c]) => c) };
}

/**
 * One registry fact, built from a slimmed packument (cli.mjs `slimPackument`). Pure, and
 * the only place the fact shape is defined: the CLI maps over it and the tests call it, so
 * a test fixture can never drift from what the CLI produces.
 * @param {object} p
 * @param {string} p.name - package name
 * @param {string|null} p.from - previous version (null for a new package)
 * @param {string} p.to - introduced version
 * @param {boolean} p.direct - declared by the PR
 * @param {{time: Record<string, string>, versions: Record<string, {attested: boolean,
 *   publisher: string|null, installCmd: string|null, repo: string|null}>}|null} p.doc
 *   slimmed packument; null when the registry did not answer (an outage), as opposed to an
 *   answer without this version: the gate waits on the first and escalates on the second
 * @returns {object} the registry fact the gate rules read
 */
export function registryFact({ name, from, to, direct, doc }) {
  const prev = from ? doc?.versions?.[from] : null;
  const cur = doc?.versions?.[to];
  return {
    name,
    version: to,
    direct,
    publishedAt: doc?.time[to] ?? null,
    prevAttested: Boolean(prev?.attested),
    attested: Boolean(cur?.attested),
    prevPublisher: prev?.publisher ?? null,
    publisher: cur?.publisher ?? null,
    prevInstallCmd: prev?.installCmd ?? null,
    installCmd: cur?.installCmd ?? null,
    prevRepo: prev?.repo ?? null,
    repo: cur?.repo ?? null,
    repoUrl: cur?.repo ? `https://${cur.repo}` : null,
    registryError: doc === null,
  };
}

/**
 * What the published-code review diffs: declared updates with an old and a new version,
 * and transitive version changes, riskiest (install scripts) first. Shared by the diff
 * step (cli.mjs `package-diffs`) and the codeReview rule, so "what should have been
 * reviewed" can never drift from "what was offered for review".
 * @param {{updates: {name: string, from: string|null, to: string|null}[],
 *   lock: {changed: {name: string, from: string|null, to: string, installScript: boolean}[]}}} f
 * @returns {{direct: object[], transitive: object[]}} diff targets
 */
export function diffTargets(f) {
  const declared = new Set(f.updates.map((u) => u.name));
  return {
    direct: f.updates.filter((u) => u.from && u.to),
    transitive: f.lock.changed
      .filter((c) => c.from && !declared.has(c.name))
      .sort((a, b) => Number(b.installScript) - Number(a.installScript)),
  };
}

/**
 * Packages we know legitimately run an install script and bump often. A new version of one
 * of these passes the installScripts rule only when its install command is byte-identical
 * to the previous version's and both versions carry npm provenance. The 7-day cooldown and
 * a clean code review (install-script packages are diffed first) are enforced by their own
 * rules. Anything else (a new script, a changed command, lost or missing provenance, an
 * unlisted package) still escalates. Decided in ADR-010.
 */
export const TRUSTED_INSTALL_SCRIPTS = new Set(['better-sqlite3', 'esbuild', 'msw', 'unrs-resolver']);

/**
 * Install-time code the bump introduces: packages that gain an install script, and new
 * versions of packages that already run one (a hijacked better-sqlite3 or esbuild release
 * would run its script during `npm ci` in the Docker build).
 * @param {{newInstallScripts: string[],
 *   changed: {name: string, from: string|null, to: string, installScript: boolean}[]}} lock
 * @param {{name: string, version: string, prevAttested?: boolean, attested?: boolean,
 *   prevInstallCmd?: string|null, installCmd?: string|null}[]} [registry] - registry facts
 * @returns {{offenders: string[], trusted: string[]}} what escalates, and trusted packages
 *   whose new version passed with an unchanged command and provenance
 */
export function installScriptChanges(lock, registry = []) {
  const gained = new Set(lock.newInstallScripts.map((key) => key.replace(/^.*node_modules\//, '')));
  const facts = new Map(registry.map((r) => [label(r), r]));
  const unchangedAndAttested = (c, r) => {
    if (!TRUSTED_INSTALL_SCRIPTS.has(c.name)) return false;
    return (
      Boolean(r?.prevAttested && r.attested && r.installCmd) &&
      r.installCmd === r.prevInstallCmd &&
      !repoChanged(r)
    );
  };
  const offenders = [...gained].map((name) => `${name} (new script)`);
  const trusted = [];
  // A package that gains a script while changing version is reported once, as "new script".
  for (const c of lock.changed) {
    if (!c.installScript || !c.from || gained.has(c.name)) continue;
    const r = facts.get(`${c.name}@${c.to}`);
    // Registry down: the install command is unknown, not changed. Cooldown keeps the PR waiting.
    if (r?.registryError) continue;
    if (unchangedAndAttested(c, r)) trusted.push(`${c.name}@${c.to}`);
    else offenders.push(`${c.name} ${c.from}→${c.to} (runs an install script)`);
  }
  return { offenders, trusted };
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
 * npm only accepts a provenance publish when package.json's `repository.url` matches the
 * attestation's source repo. So a stolen token publishing "with provenance" from the
 * attacker's own GitHub repo has to change `repository`: comparing it with the previous
 * version's catches that, where a bare "has an attestation" check does not. Only attested
 * versions are compared: without an attestation `repository` is free text an attacker would
 * simply keep, while legitimate moves (org renames, transfers) would escalate for nothing.
 */
const repoChanged = (r) => Boolean(r.attested && r.prevRepo && r.repo && r.prevRepo !== r.repo);

/** Author email of every commit Dependabot creates (GitHub signs them). */
export const DEPENDABOT_COMMIT_EMAIL = '49699333+dependabot[bot]@users.noreply.github.com';
const NPM_REGISTRY = 'https://registry.npmjs.org/';

/**
 * The PR author alone does not prove the branch content is Dependabot's: anyone with push
 * access could add a commit. The head commit must be authored by Dependabot and carry a
 * valid signature.
 */
function authorRule(f) {
  if (f.author !== DEPENDABOT_LOGIN) return result('author', 'fail', `PR author ${f.author}`);
  const c = f.headCommit;
  if (!c || c.authorEmail !== DEPENDABOT_COMMIT_EMAIL || !c.verified) {
    return result('author', 'fail', `head commit is not a signed Dependabot commit (author ${c?.authorEmail ?? '?'}, verified ${c?.verified ?? '?'})`);
  }
  return result('author', 'pass', 'Dependabot PR, head commit signed by Dependabot');
}

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
  // The registry answered but has no publish time for this version: suspicious, escalate.
  const blocking = registry.filter((r) => !r.publishedAt || (r.direct && young(r)));
  if (blocking.length) {
    return unless('cooldown', blocking.map(label), `published < ${LIMITS.cooldownDays}d ago (or unknown)`, '');
  }
  const aging = registry.filter(young);
  return aging.length
    ? result('cooldown', 'pending', `waiting for dependency versions to age: ${aging.map(label).join(', ')}`)
    : result('cooldown', 'pass', `all ${registry.length} introduced versions older than ${LIMITS.cooldownDays}d`);
}

/**
 * The verdict's detail. An "escalate" carries a short fingerprint of the model's reasons
 * (summary, question, breaking changes): an override waives the verdict only for the
 * reasons the owner read, and a re-assessment that escalates for something else is a new
 * failure, not the same one.
 * @param {{verdict: string, summary?: string, escalation?: {question?: string},
 *   breakingChangesAffectingUs?: unknown[]}} assessment - an assessment
 * @returns {string} the verdict rule's detail
 */
export function verdictDetail(assessment) {
  if (assessment.verdict === 'merge') return 'assessment: merge';
  const reasons = JSON.stringify([
    assessment.summary ?? '',
    assessment.escalation?.question ?? '',
    assessment.breakingChangesAffectingUs ?? [],
  ]);
  return `assessment: escalate [${shortHash(reasons, 8)}]`;
}

/**
 * Suspicious findings from Claude's review of the published code diff. An empty
 * `suspicious` list only means something if the model actually saw code: coverage "none"
 * while there were version changes to diff is a review that did not happen (e.g. the
 * model could not read the diff files), so it fails instead of passing silently.
 */
function codeReviewRule(assessment, diffsExpected) {
  if (!assessment) return result('codeReview', 'pending', 'not assessed yet');
  const review = assessment.codeReview;
  if (!review) return result('codeReview', 'fail', 'assessment has no code review');
  if (review.coverage === 'none' && diffsExpected) {
    return result('codeReview', 'fail', 'the code review saw no code although version changes had diffs');
  }
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
  const targets = diffTargets(f);
  const scripts = installScriptChanges(f.lock, f.registry);
  // An npm registry outage leaves facts empty, not suspicious: rules that read them skip
  // those entries, and the cooldown rule keeps the PR waiting until the registry answers.
  const reachable = [];
  const unreachable = [];
  for (const r of f.registry) (r.registryError ? unreachable : reachable).push(r);

  return [
    authorRule(f),
    unless(
      'sources',
      f.lock.changed.filter((c) => !c.bundled && !c.resolved?.startsWith(NPM_REGISTRY)).map((c) => `${c.name}@${c.to} from ${c.resolved ?? '?'}`),
      'not resolved from registry.npmjs.org',
      'every introduced version resolves from registry.npmjs.org',
    ),
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
    unless(
      'installScripts',
      scripts.offenders,
      'install-time code',
      scripts.trusted.length
        ? `trusted install script unchanged, with provenance: ${scripts.trusted.join(', ')}`
        : 'no install script added or updated',
    ),
    result(
      'newPackages',
      TRI[f.lock.added.length <= LIMITS.maxNewPackages],
      `${f.lock.added.length} new package(s) in lockfile`,
    ),
    // An npm registry outage is its own transient rule, not a cooldown state: transient
    // rules can never be waived, so a waived cooldown failure on one package cannot hide
    // the fact that another package's install script and provenance were never checked.
    unreachable.length
      ? result('registry', 'pending', `npm registry unavailable for: ${unreachable.map(label).join(', ')}`)
      : result('registry', 'pass', 'npm registry answered for every introduced version'),
    cooldownRule(reachable, f.now),
    unless(
      'provenance',
      reachable.flatMap((r) => {
        if (repoChanged(r)) return [`${label(r)} (source repo ${r.prevRepo} → ${r.repo})`];
        return r.prevAttested && !r.attested ? [`${label(r)} (provenance dropped)`] : [];
      }),
      'provenance regression',
      'no provenance drop or source-repo change in any introduced version',
    ),
    // Direct packages only: maintainer rotation in transitive packages is common enough
    // that it would escalate most bumps; transitive versions get cooldown, provenance,
    // malware and (within budget) the code review instead.
    unless(
      'publisher',
      reachable
        .filter((r) => r.direct && (!r.publisher || (r.prevPublisher && r.publisher !== r.prevPublisher)))
        .map((r) => `${r.name} (${r.prevPublisher ?? '?'} → ${r.publisher ?? '?'})`),
      'publisher changed',
      'same npm publisher as the previous version',
    ),
    unless('audit', f.newAdvisories, 'new advisories', 'no new advisories'),
    codeReviewRule(f.assessment, targets.direct.length + targets.transitive.length > 0),
    f.assessment
      ? result('verdict', TRI[f.assessment.verdict === 'merge'], verdictDetail(f.assessment))
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
 * @param {Map<string, string>} [p.waived] - soft rules the owner's `/deps merge` waived for
 *   this exact lockfile, each with the detail it failed with at the time. A rule is skipped
 *   only while it still fails with that same detail: a rule that starts failing later, or
 *   fails for a different reason (e.g. a re-assessment that finds suspicious code), or is
 *   merely pending (not assessed yet), is not covered
 * @param {boolean} p.held - the PR carries the deps:hold label
 * @param {boolean} p.slotFree - no merge has happened yet in this run
 * @returns {'held'|'escalate'|'wait'|'would-merge'|'queued'|'merge'} the outcome
 */
export function decide({ rules, mode, waived = new Map(), held, slotFree }) {
  if (held) return 'held';
  const isWaived = (r) => r.kind === 'soft' && r.status === 'fail' && waived.get(r.id) === r.detail;
  if (rules.some((r) => r.kind === 'hard' && r.status === 'fail')) return 'escalate';
  if (rules.some((r) => r.kind === 'soft' && r.status === 'fail' && !isWaived(r))) return 'escalate';
  const blocking = rules.filter((r) => r.status !== 'pass' && !isWaived(r));
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
