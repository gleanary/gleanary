#!/usr/bin/env node
// CLI for the Dependabot agent (.github/workflows/deps-agent.yml).
//
//   plan                                   prs=[...] for the assess matrix (read-only)
//   facts --pr N                           gate facts for one PR as JSON (read-only)
//   package-diffs --facts F --out DIR      capped diffs of the published code (read-only)
//   prompt --pr N --facts F --diffs DIR    prompt + claude_args step outputs
//   save-assessment --pr N --facts F --out F   validate $ASSESSMENT into a file
//   act --assessments DIR                  evaluate, record, escalate, merge at most one PR
//   command                                record an owner's `/deps ...` PR comment (never merges)
//
// Env: GITHUB_REPOSITORY, GH_TOKEN, MODE (off|shadow|merge), OWNER_LOGIN, APP_SLUG,
// RUN_URL. Only `act` and `command` run with a write token (the GitHub App's), and
// neither runs an LLM: the assessment arrives as a validated artifact. Importing this
// module runs nothing (tests import it); only direct execution runs a subcommand.

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEPENDABOT_LOGIN,
  LOCK_FILES,
  NPM_BRANCH_PREFIX,
  advisoryKeys,
  assessmentKey,
  classifyMain,
  decide,
  diffLockfiles,
  diffTargets,
  evaluateRules,
  latestCheckRuns,
  manifestChangeIsScoped,
  parseUpdatedDependencies,
  pendingChecks,
  updatesKey,
} from './gate.mjs';
import {
  MARKER,
  approvedVersions,
  decodeRecord,
  fromApp,
  neutralize,
  pushHistory,
  renderDashboard,
  renderEscalation,
  renderOverride,
  renderRecord,
} from './record.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.GITHUB_REPOSITORY;
const MODE = process.env.MODE || 'shadow';
const OWNER = process.env.OWNER_LOGIN || '';
const BOT = `${process.env.APP_SLUG || 'deps-agent'}[bot]`;
const RUN_URL = process.env.RUN_URL || '';
const LABEL = { escalated: 'deps:needs-human', hold: 'deps:hold', dashboard: 'deps:dashboard' };
const MAX_ASSESS_PER_RUN = 5;
const MAX_FEATURE_ISSUES = 2;
const BUFFER = 512 * 1024 * 1024;
// Published-code review: a full `npm diff` of a large package (e.g. next) exhausts the heap,
// so Claude gets package.json, install/bin scripts and top-level files first, then the rest
// up to these caps, and is told what it did not see.
// Binaries are excluded too: a text review can't read them, and `npm diff` on a large native
// binary (e.g. @next/swc-*'s .node file) runs for many minutes at hundreds of MB.
const DIFF_NOISE =
  /(\.map|\.d\.[cm]?ts|\.md|(^|\/)LICENSE[^/]*|\.(node|wasm|so|dylib|dll|exe|bin|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|gz|tgz|zip))$|(^|\/)(__tests__|tests?|docs?|examples?)\//i;
// Hard wall-clock limit per `npm diff` call: a slow package costs coverage, never the job.
const DIFF_TIMEOUT_MS = 120_000;
const DIFF_MAX_FILES = 80;
const DIFF_MAX_BYTES = 200_000;
// Transitive versions get a smaller review budget: the riskiest first (install scripts).
const DIFF_MAX_TRANSITIVE = 10;
const DIFF_MAX_BYTES_TRANSITIVE = 40_000;
// Registry checks (cooldown, provenance) for every introduced version, direct or transitive.
const REGISTRY_CONCURRENCY = 8;
const REGISTRY_MAX_PACKAGES = 300;
// Hours to wait for Dependabot to act on our `@dependabot rebase` before asking the owner.
const REBASE_STUCK_HOURS = 24;
// Days a PR may wait on young transitive versions before the owner is asked.
const COOLDOWN_WAIT_ESCALATE_DAYS = 14;

// ── GitHub / registry I/O ────────────────────────────────────────────────────

const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: BUFFER, input });
const api = (path) => JSON.parse(gh(['api', path]));
const apiWrite = (method, path, body) =>
  JSON.parse(gh(['api', '-X', method, path, '--input', '-'], JSON.stringify(body ?? {})) || '{}');
/** Paginated GET; `key` unwraps envelope responses like `{check_runs: [...]}`. */
const apiPaged = (path, key) =>
  JSON.parse(gh(['api', '--paginate', '--slurp', path])).flatMap((page) => (key ? page[key] : page));
const rawFile = (path, ref) =>
  JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${REPO}/contents/${path}?ref=${ref}`]));

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// The full packument is the only registry source of per-version publish time, and it
// already carries every version manifest. Fetched once per package per run, but only the
// fields the gate reads are kept: full packuments (e.g. next) run to tens of MB each.
const packuments = new Map();
const slimPackument = (doc) => ({
  time: doc.time ?? {},
  repoUrl: typeof doc.repository === 'string' ? doc.repository : (doc.repository?.url ?? null),
  versions: Object.fromEntries(
    Object.entries(doc.versions ?? {}).map(([v, m]) => [
      v,
      { attested: Boolean(m.dist?.attestations), publisher: m._npmUser?.name ?? null },
    ]),
  ),
});
const packument = (name) => {
  if (!packuments.has(name)) {
    const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`;
    packuments.set(name, getJson(url).then(slimPackument, () => null));
  }
  return packuments.get(name);
};

/**
 * Publish time, provenance and publisher for every introduced version, direct or
 * transitive. A failed lookup leaves nulls, which the gate escalates.
 * @param {{name: string, from: string|null, to: string}[]} changes - lock.changed
 * @param {Set<string>} direct - names of the packages the PR declares
 * @returns {Promise<object[]>} one registry fact per change
 */
async function registryFacts(changes, direct) {
  if (changes.length > REGISTRY_MAX_PACKAGES) {
    // Too many to verify: one unverifiable entry makes the cooldown rule escalate.
    return [{ name: `${changes.length} packages`, version: '(too many to verify)', direct: true, publishedAt: null }];
  }
  const facts = new Array(changes.length);
  let next = 0;
  const worker = async () => {
    while (next < changes.length) {
      const i = next++;
      const { name, from, to } = changes[i];
      const doc = await packument(name);
      const prev = from ? doc?.versions?.[from] : null;
      const cur = doc?.versions?.[to];
      facts[i] = {
        name,
        version: to,
        direct: direct.has(name),
        publishedAt: doc?.time[to] ?? null,
        prevAttested: Boolean(prev?.attested),
        attested: Boolean(cur?.attested),
        prevPublisher: prev?.publisher ?? null,
        publisher: cur?.publisher ?? null,
        repoUrl: doc?.repoUrl ?? null,
      };
    }
  };
  await Promise.all(Array.from({ length: REGISTRY_CONCURRENCY }, worker));
  return facts;
}

/** Advisory keys for a package.json + lockfile pair. Reads the lockfile only; runs no package code. */
function auditAdvisories(pkg, lock) {
  const dir = mkdtempSync(join(tmpdir(), 'deps-audit-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
  let out;
  try {
    out = execFileSync('npm', ['audit', '--package-lock-only', '--ignore-scripts', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: BUFFER,
    });
  } catch (err) {
    out = err.stdout; // npm audit exits non-zero whenever vulnerabilities exist
  }
  const report = JSON.parse(out);
  if (report.error) throw new Error(report.error.summary ?? 'npm audit failed');
  return advisoryKeys(report);
}

const gitCommit = (sha) => api(`repos/${REPO}/git/commits/${sha}`);
const commitMessage = (sha) => gitCommit(sha).message;
const checkRunsFor = (sha) =>
  latestCheckRuns(apiPaged(`repos/${REPO}/commits/${sha}/check-runs?per_page=100`, 'check_runs'));

/** GitHub Advisory Database malware entries affecting any of the `name@version` specs. */
function malwareAdvisories(specs) {
  const hits = [];
  for (let i = 0; i < specs.length; i += 100) {
    const affects = encodeURIComponent(specs.slice(i, i + 100).join(','));
    const found = api(`advisories?type=malware&ecosystem=npm&per_page=100&affects=${affects}`);
    for (const a of found.filter((x) => !x.withdrawn_at)) {
      hits.push(`${a.ghsa_id} (${a.vulnerabilities.map((v) => v.package.name).join(', ')})`);
    }
  }
  return hits;
}

/** Files most likely to hide a payload come first. */
function diffPriority(file) {
  if (file === 'package.json') return 0;
  if (/(^|\/)(pre|post)?install|^bin\//.test(file)) return 1;
  return file.includes('/') ? 3 : 2;
}

/** Capped diff of the published tarballs. Downloads only; runs no package code. */
function packageDiff(name, from, to, maxBytes = DIFF_MAX_BYTES) {
  const npmDiff = (maxBuffer, ...args) =>
    execFileSync('npm', ['diff', `--diff=${name}@${from}`, `--diff=${name}@${to}`, ...args], {
      cwd: tmpdir(),
      encoding: 'utf8',
      maxBuffer,
      timeout: DIFF_TIMEOUT_MS,
    });
  const files = npmDiff(BUFFER, '--diff-name-only').split('\n').filter(Boolean);
  const relevant = files.filter((f) => !DIFF_NOISE.test(f)).sort((a, b) => diffPriority(a) - diffPriority(b));
  const picked = relevant.slice(0, DIFF_MAX_FILES);
  let text = '';
  let overflow = false;
  if (picked.length) {
    try {
      text = npmDiff(maxBytes, '--', ...picked);
    } catch (err) {
      // Hit the byte cap or the time limit: keep what was produced, report it truncated.
      if (err.code !== 'ENOBUFS' && err.signal !== 'SIGTERM') throw err;
      text = String(err.stdout ?? '').slice(0, maxBytes);
      overflow = true;
    }
  }
  return {
    text,
    totalFiles: files.length,
    relevantFiles: relevant.length,
    includedFiles: picked.length,
    truncated: overflow || picked.length < relevant.length,
  };
}

function mainState(now) {
  const sha = api(`repos/${REPO}/git/ref/heads/main`).object.sha;
  const latest = (wf, event) =>
    api(`repos/${REPO}/actions/workflows/${wf}/runs?head_sha=${sha}&event=${event}&per_page=1`)
      .workflow_runs[0] ?? null;
  return { sha, ...classifyMain(latest('ci.yml', 'push'), latest('deploy.yml', 'workflow_run'), now) };
}

const dependabotPrs = () =>
  apiPaged(`repos/${REPO}/pulls?state=open&per_page=100`)
    .filter((p) => p.user.login === DEPENDABOT_LOGIN)
    .sort((a, b) => a.number - b.number);

const prComments = (number) => apiPaged(`repos/${REPO}/issues/${number}/comments?per_page=100`);

/** The agent's sticky record comment: only comments by our App are trusted. */
function findRecord(number, comments = prComments(number)) {
  const comment = comments.find((c) => fromApp(c, BOT) && c.body.includes(MARKER));
  return { comment, record: comment ? decodeRecord(comment.body) : null };
}

/** Fingerprint of everything that shapes an assessment; editing any of it re-assesses. */
const POLICY_HASH = (() => {
  const h = createHash('sha256');
  for (const f of ['policy.md', 'prompt.md', 'assessment.schema.json']) h.update(readFileSync(join(HERE, f)));
  return h.digest('hex').slice(0, 12);
})();

// ── Facts ────────────────────────────────────────────────────────────────────

/** Base-side files and advisories, shared by every PR built on the same base in one run. */
const baseCache = new Map();
function baseSide(sha) {
  if (!baseCache.has(sha)) {
    const pkg = rawFile('package.json', sha);
    const lock = rawFile('package-lock.json', sha);
    let advisories;
    try {
      advisories = new Set(auditAdvisories(pkg, lock));
    } catch (err) {
      advisories = err;
    }
    baseCache.set(sha, { pkg, lock, advisories });
  }
  return baseCache.get(sha);
}

async function collectFacts(number, main, now) {
  let pr = api(`repos/${REPO}/pulls/${number}`);
  if (pr.mergeable === null) {
    // GitHub computes mergeability lazily: the first read only starts the job.
    await new Promise((r) => setTimeout(r, 5000));
    pr = api(`repos/${REPO}/pulls/${number}`);
  }
  const files = apiPaged(`repos/${REPO}/pulls/${number}/files?per_page=100`).map((f) => f.filename);
  const commit = gitCommit(pr.head.sha);
  const declared = parseUpdatedDependencies(commit.message);
  const checks = checkRunsFor(pr.head.sha);
  const compare = api(`repos/${REPO}/compare/${pr.head.sha}...${main.sha}`);
  const fresh =
    compare.ahead_by === 0 || !(compare.files ?? []).some((f) => LOCK_FILES.has(f.filename));

  const facts = {
    author: pr.user.login,
    branch: pr.head.ref,
    files,
    updates: declared.map((u) => ({ ...u, from: null, to: null })),
    manifestScoped: false,
    checks,
    headCommittedAt: commit.committer?.date ?? null,
    lock: { added: [], newInstallScripts: [], changed: [] },
    registry: [],
    newAdvisories: [],
    malware: [],
    mergeable: pr.mergeable,
    fresh,
    main: main.state,
    now,
  };
  const meta = {
    number,
    title: pr.title,
    url: pr.html_url,
    headSha: pr.head.sha,
    labels: pr.labels.map((l) => l.name),
  };
  if (!pr.head.ref.startsWith(NPM_BRANCH_PREFIX) || !declared.length) return { meta, facts };

  // Compare against the PR's own base, so the diff is exactly what Dependabot changed;
  // drift from main is the `fresh` rule's job.
  const { pkg: basePkg, lock: baseLock, advisories: before } = baseSide(pr.base.sha);
  const headPkg = rawFile('package.json', pr.head.sha);
  const headLock = rawFile('package-lock.json', pr.head.sha);
  const version = (lock, name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;
  facts.updates = declared.map((u) => ({ ...u, from: version(baseLock, u.name), to: version(headLock, u.name) }));
  facts.manifestScoped = manifestChangeIsScoped(basePkg, headPkg, declared.map((u) => u.name));
  facts.lock = diffLockfiles(baseLock, headLock);
  try {
    facts.malware = malwareAdvisories(facts.lock.changed.map((c) => `${c.name}@${c.to}`));
  } catch {
    facts.malware = null; // feed unavailable: the gate waits rather than guessing
  }
  facts.registry = await registryFacts(facts.lock.changed, new Set(declared.map((u) => u.name)));
  try {
    if (before instanceof Error) throw before;
    facts.newAdvisories = auditAdvisories(headPkg, headLock).filter((k) => !before.has(k));
  } catch (err) {
    facts.newAdvisories = [`audit unavailable: ${err.message}`];
  }
  return { meta, facts };
}

// ── Mutations (act / command only) ───────────────────────────────────────────

function ensureLabels() {
  const defs = [
    [LABEL.escalated, 'd93f0b', 'deps-agent needs a human decision'],
    [LABEL.hold, 'fbca04', 'deps-agent will not act on this PR'],
    [LABEL.dashboard, '0e8a16', 'deps-agent dashboard issue'],
  ];
  const existing = new Set(apiPaged(`repos/${REPO}/labels?per_page=100`).map((l) => l.name));
  for (const [name, color, description] of defs) {
    if (!existing.has(name)) apiWrite('POST', `repos/${REPO}/labels`, { name, color, description });
  }
}

function setLabel(number, name, on, labels) {
  if (on && !labels.includes(name)) apiWrite('POST', `repos/${REPO}/issues/${number}/labels`, { labels: [name] });
  if (!on && labels.includes(name)) gh(['api', '-X', 'DELETE', `repos/${REPO}/issues/${number}/labels/${encodeURIComponent(name)}`]);
}

const comment = (number, body) => apiWrite('POST', `repos/${REPO}/issues/${number}/comments`, { body });

function saveRecord(number, existing, record) {
  const body = renderRecord(record, { mode: MODE, runUrl: RUN_URL });
  if (existing) apiWrite('PATCH', `repos/${REPO}/issues/comments/${existing.id}`, { body });
  else comment(number, body);
}

function merge(meta) {
  // --match-head-commit equivalent: GitHub refuses if the head moved since we evaluated it.
  apiWrite('PUT', `repos/${REPO}/pulls/${meta.number}/merge`, {
    merge_method: 'squash',
    sha: meta.headSha,
    commit_title: `${meta.title} (#${meta.number})`,
    commit_message: `Merged-by: deps-agent\nDecision-record: ${meta.url}`,
  });
}

/**
 * Evaluate one PR end to end and persist the result.
 * @param {number} number - PR number
 * @param {{main: {sha: string, state: string, detail?: string}, now: Date,
 *   assessment?: {key: string, assessment: object}, slotFree: boolean, by?: string,
 *   note?: string}} opts - run context; `assessment` is this run's fresh assessment, if any
 * @returns {Promise<{outcome: string, record: {outcome?: string, rules: object[]}, meta: object}>}
 */
async function evaluatePr(number, { main, now, assessment, slotFree, by = 'agent', note }) {
  const { meta, facts } = await collectFacts(number, main, now);
  const comments = prComments(number);
  const { comment: existing, record: prior } = findRecord(number, comments);
  const record = prior ?? { pr: number };
  // Assessments and owner overrides belong to the package versions, not the commit, so a
  // Dependabot rebase keeps them; every gate is still re-evaluated on the new commit.
  const key = assessmentKey({ updates: facts.updates, checks: facts.checks, policyHash: POLICY_HASH });
  if (assessment && assessment.key === key) {
    record.assessment = assessment.assessment;
    record.assessmentKey = key;
  }
  const current = record.assessmentKey === key ? record.assessment : null;
  const rules = evaluateRules({ ...facts, assessment: current });
  const versions = updatesKey(facts.updates);
  const override = approvedVersions(comments, BOT).has(versions);
  if (override && record.overrideSeen !== versions) {
    record.overrideSeen = versions;
    pushHistory(record, { at: now.toISOString(), sha: meta.headSha, outcome: 'override', by: OWNER || 'owner' });
  }
  let outcome = decide({ rules, mode: MODE, override, held: meta.labels.includes(LABEL.hold), slotFree });

  // Our `@dependabot rebase` may be ignored (Dependabot might not take commands from an
  // App): after REBASE_STUCK_HOURS on the same commit, hand it to the owner.
  const needsRebase = !facts.fresh || facts.mergeable === false;
  const stuck =
    outcome === 'wait' &&
    needsRebase &&
    record.rebaseSha === meta.headSha &&
    now.getTime() - new Date(record.rebaseAt ?? now).getTime() > REBASE_STUCK_HOURS * 3_600_000;
  // A young transitive version only ever makes the PR wait. If every Dependabot rebase pulls
  // in an even newer version of a fast-moving dependency, it would wait forever, visible
  // only on the dashboard. The clock lives in the record, so it survives rebases.
  const coolingDown = rules.find((r) => r.id === 'cooldown' && r.status === 'pending');
  if (!coolingDown) delete record.cooldownWaitSince;
  else record.cooldownWaitSince ??= now.toISOString();
  const coolingTooLong =
    outcome === 'wait' &&
    coolingDown &&
    now.getTime() - new Date(record.cooldownWaitSince).getTime() > COOLDOWN_WAIT_ESCALATE_DAYS * 86_400_000;
  let why = '';
  if (stuck) {
    outcome = 'escalate';
    why = `Dependabot has not rebased this PR ${REBASE_STUCK_HOURS} h after deps-agent asked. Comment \`@dependabot rebase\` yourself.`;
  } else if (coolingTooLong) {
    outcome = 'escalate';
    why = `This PR has waited ${COOLDOWN_WAIT_ESCALATE_DAYS} days for dependency versions to age (${coolingDown.detail}); a fast-moving dependency may keep resetting the clock. \`/deps merge\` to take it as is, or \`/deps hold\`.`;
  }

  if (outcome === 'merge') {
    try {
      merge(meta);
    } catch (err) {
      outcome = 'wait';
      note = `merge refused by GitHub: ${err.message.slice(0, 200)}`;
    }
  }

  Object.assign(record, { headSha: meta.headSha, outcome, rules, updatedAt: now.toISOString() });
  pushHistory(record, { at: now.toISOString(), sha: meta.headSha, outcome, by, ...(note ? { note } : {}) });

  // Ping once per reason: a rebase with the same versions and the same failing gates stays quiet.
  const failing = rules
    .filter((r) => r.status === 'fail')
    .map((r) => r.id)
    .join(',');
  const escalation = `${versions}|${failing}${stuck ? '|rebase-stuck' : ''}${coolingTooLong ? '|cooldown-wait' : ''}`;
  if (outcome === 'escalate' && record.escalatedKey !== escalation && OWNER) {
    comment(number, renderEscalation(record, OWNER, why));
    record.escalatedKey = escalation;
  }
  if (needsRebase && record.rebaseSha !== meta.headSha) {
    comment(number, '@dependabot rebase');
    record.rebaseSha = meta.headSha;
    record.rebaseAt = now.toISOString();
  }
  setLabel(number, LABEL.escalated, outcome === 'escalate', meta.labels);
  saveRecord(number, existing, record);
  return { outcome, record, meta };
}

let enhancementTitles = null; // fetched once per run, on first use
function openFeatureIssues(record, meta) {
  const features = (record.assessment?.adoptableFeatures ?? []).slice(0, MAX_FEATURE_ISSUES);
  if (!features.length) return;
  enhancementTitles ??= new Set(
    apiPaged(`repos/${REPO}/issues?state=all&labels=enhancement&per_page=100`).map((i) => i.title),
  );
  for (const f of features) {
    const title = `chore: evaluate ${neutralize(f.title, 80)} (${meta.title.replace(/^chore\(deps(-dev)?\): /, '')})`;
    if (enhancementTitles.has(title)) continue;
    enhancementTitles.add(title);
    apiWrite('POST', `repos/${REPO}/issues`, {
      title,
      labels: ['enhancement'],
      body: `Spotted by deps-agent on ${meta.url}.\n\n${neutralize(f.detail)}\n\n${neutralize(f.link ?? '', 300)}`,
    });
  }
}

/** Freeze handling: one issue per broken main SHA, a revert PR when our merge caused it. */
function handleMain(main) {
  const issues = apiPaged(`repos/${REPO}/issues?state=open&labels=${LABEL.escalated}&per_page=100`).filter(
    (i) => !i.pull_request && i.title.startsWith('deps-agent: main'),
  );
  if (main.state === 'healthy') {
    for (const i of issues) {
      comment(i.number, `main is healthy again (\`${main.sha.slice(0, 7)}\`). Closing.`);
      apiWrite('PATCH', `repos/${REPO}/issues/${i.number}`, { state: 'closed' });
    }
    return;
  }
  if (main.state !== 'broken') return;
  const short = main.sha.slice(0, 7);
  if (issues.some((i) => i.title.includes(short))) return;

  const message = commitMessage(main.sha);
  let revert = '';
  if (/^Merged-by: deps-agent$/m.test(message)) {
    const branch = `deps-agent/revert-${short}`;
    const user = api(`users/${encodeURIComponent(BOT)}`);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: BOT,
      GIT_COMMITTER_NAME: BOT,
      GIT_AUTHOR_EMAIL: `${user.id}+${BOT}@users.noreply.github.com`,
      GIT_COMMITTER_EMAIL: `${user.id}+${BOT}@users.noreply.github.com`,
    };
    const git = (...args) => execFileSync('git', args, { env, encoding: 'utf8' });
    git('fetch', '--depth=2', 'origin', main.sha); // the revert needs the parent tree
    git('checkout', '-B', branch, main.sha);
    git('revert', '--no-edit', main.sha);
    git('push', '--force', 'origin', branch);
    try {
      const pr = apiWrite('POST', `repos/${REPO}/pulls`, {
        title: `revert: ${message.split('\n')[0]}`,
        head: branch,
        base: 'main',
        body: `deps-agent: main \`${short}\` is broken (${main.detail}) after its own merge. Merge this once CI is green to restore the previous production state.`,
      });
      revert = `\n\nRevert PR ready: ${pr.html_url} (merge it once its CI is green).`;
    } catch (err) {
      // A previous run may have opened it before failing to file the issue.
      revert = `\n\nRevert branch \`${branch}\` pushed; opening its PR failed: ${err.message.slice(0, 200)}`;
    }
  }
  apiWrite('POST', `repos/${REPO}/issues`, {
    title: `deps-agent: main ${short} is broken`,
    labels: [LABEL.escalated],
    body: `@${OWNER} ${main.detail} on \`${main.sha}\`. deps-agent has frozen all merges until main is healthy.${revert}\n\nRun: ${RUN_URL}`,
  });
}

function updateDashboard(rows, main, now) {
  const body = renderDashboard(rows, main, { mode: MODE, runUrl: RUN_URL, at: now.toISOString() });
  const existing = apiPaged(`repos/${REPO}/issues?state=open&labels=${LABEL.dashboard}&per_page=10`).find(
    (i) => i.user.login === BOT,
  );
  if (existing) apiWrite('PATCH', `repos/${REPO}/issues/${existing.number}`, { body });
  else apiWrite('POST', `repos/${REPO}/issues`, { title: 'Dependency dashboard (deps-agent)', labels: [LABEL.dashboard], body });
}

// ── Subcommands ──────────────────────────────────────────────────────────────

/** GITHUB_OUTPUT writer with a random heredoc delimiter (values may be multi-line). */
function output(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const delim = `EOF_${randomUUID()}`;
  const line = `${name}<<${delim}\n${value}\n${delim}\n`;
  if (file) appendFileSync(file, line);
  else process.stdout.write(line);
}

const blockingSummary = (rules) =>
  rules
    .filter((r) => r.status !== 'pass')
    .map((r) => r.id)
    .join(', ');

const commands = {
  async plan() {
    const only = process.env.ONLY_PR ? Number(process.env.ONLY_PR) : null;
    const queue = [];
    for (const pr of dependabotPrs()) {
      if (only && pr.number !== only) continue;
      if (only) {
        queue.push(pr.number); // an explicit request always re-assesses
        continue;
      }
      // Assess once CI has finished (the assessment reads the CI result), and only when no
      // assessment exists for these package versions, this policy and this CI outcome.
      const checks = checkRunsFor(pr.head.sha);
      if (pendingChecks(checks).length) continue;
      const updates = parseUpdatedDependencies(commitMessage(pr.head.sha));
      const key = assessmentKey({ updates, checks, policyHash: POLICY_HASH });
      if (findRecord(pr.number).record?.assessmentKey !== key) queue.push(pr.number);
    }
    output('prs', JSON.stringify(queue.slice(0, MAX_ASSESS_PER_RUN)));
  },

  async facts({ pr }) {
    const now = new Date();
    process.stdout.write(JSON.stringify(await collectFacts(Number(pr), mainState(now), now), null, 2));
  },

  async 'package-diffs'({ facts, out }) {
    const { facts: f } = JSON.parse(readFileSync(facts, 'utf8'));
    mkdirSync(out, { recursive: true });
    const { direct, transitive } = diffTargets(f);
    const targets = [
      ...direct.map((u) => ({ ...u, direct: true, max: DIFF_MAX_BYTES })),
      ...transitive
        .slice(0, DIFF_MAX_TRANSITIVE)
        .map((c) => ({ ...c, direct: false, max: DIFF_MAX_BYTES_TRANSITIVE })),
    ];
    const index = [];
    for (const u of targets) {
      const entry = { name: u.name, from: u.from, to: u.to, direct: u.direct };
      try {
        const { text, ...stats } = packageDiff(u.name, u.from, u.to, u.max);
        entry.diffFile = join(out, `${u.name.replace(/[@/]/g, '_')}@${u.to}.diff`);
        writeFileSync(entry.diffFile, text);
        Object.assign(entry, stats);
      } catch (err) {
        entry.error = err.message.slice(0, 200);
      }
      index.push(entry);
    }
    const transitiveNotReviewed = Math.max(0, transitive.length - DIFF_MAX_TRANSITIVE);
    writeFileSync(join(out, 'index.json'), JSON.stringify({ diffs: index, transitiveNotReviewed }, null, 2));
  },

  async prompt({ pr, facts, diffs }) {
    const { meta, facts: f } = JSON.parse(readFileSync(facts, 'utf8'));
    const diffIndex = readFileSync(join(diffs, 'index.json'), 'utf8');
    const prompt = readFileSync(join(HERE, 'prompt.md'), 'utf8')
      .replaceAll('{{REPO}}', REPO)
      .replaceAll('{{PR}}', String(pr))
      .replaceAll('{{POLICY}}', readFileSync(join(HERE, 'policy.md'), 'utf8'))
      .replaceAll('{{FACTS}}', JSON.stringify({ title: meta.title, headSha: meta.headSha, ...f, now: undefined }, null, 2))
      .replaceAll('{{DIFFS}}', diffIndex);
    const schema = JSON.stringify(JSON.parse(readFileSync(join(HERE, 'assessment.schema.json'), 'utf8')));
    output('prompt', prompt);
    output(
      'claude_args',
      [
        `--model ${process.env.MODEL || 'claude-opus-5-5'}`,
        '--max-turns 40',
        // The job reads attacker-controlled text: file reads stay in the workspace (no
        // /proc/self/environ), web fetches stay on GitHub and npm, and no tool can reach
        // an arbitrary host (npm view --registry could). The path-scoped allow rules
        // already deny reads outside the workspace; the explicit denies are a backstop.
        // Never deny /home or ~: GitHub runners check out under /home/runner/work, and a
        // deny rule beats every allow rule, so the model would be blind to its own
        // checkout (verified with `claude -p`; covered by deps-agent-cli.test.ts).
        '--allowedTools "Read(./**),Grep(./**),Glob(./**),WebFetch(domain:github.com),WebFetch(domain:raw.githubusercontent.com),WebFetch(domain:www.npmjs.com),Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh pr checks:*),Bash(gh run view:*),Bash(gh release view:*)"',
        '--disallowedTools "Read(//proc/**),Read(//etc/**),Bash(npm:*),Bash(curl:*),Bash(wget:*)"',
        `--json-schema '${schema}'`,
      ].join('\n'),
    );
  },

  async 'save-assessment'({ pr, facts, out }) {
    const { meta, facts: f } = JSON.parse(readFileSync(facts, 'utf8'));
    const assessment = JSON.parse(process.env.ASSESSMENT || 'null');
    if (!assessment || !['merge', 'escalate'].includes(assessment.verdict)) {
      throw new Error(`PR #${pr}: invalid assessment output`);
    }
    const key = assessmentKey({ updates: f.updates, checks: f.checks, policyHash: POLICY_HASH });
    writeFileSync(out, JSON.stringify({ pr: Number(pr), headSha: meta.headSha, key, assessment }));
  },

  async act({ assessments }) {
    if (MODE === 'off') return;
    const now = new Date();
    ensureLabels();
    const main = mainState(now);
    handleMain(main);

    const byPr = new Map();
    if (assessments && existsSync(assessments)) {
      for (const f of readdirSync(assessments).filter((n) => n.endsWith('.json'))) {
        const a = JSON.parse(readFileSync(join(assessments, f), 'utf8'));
        byPr.set(a.pr, a);
      }
    }

    let slotFree = true;
    const rows = [];
    for (const pr of dependabotPrs()) {
      try {
        const { outcome, record, meta } = await evaluatePr(pr.number, {
          main,
          now,
          assessment: byPr.get(pr.number),
          slotFree,
        });
        if (outcome === 'merge') slotFree = false;
        if (byPr.has(pr.number) && ['merge', 'escalate'].includes(outcome)) openFeatureIssues(record, meta);
        rows.push({ number: pr.number, title: pr.title, outcome, blocking: blockingSummary(record.rules) });
      } catch (err) {
        // One PR's failure must not block the others.
        console.error(`PR #${pr.number}: ${err.stack}`);
        rows.push({ number: pr.number, title: pr.title, outcome: 'error', blocking: err.message.slice(0, 150) });
      }
    }
    updateDashboard(rows, main, now);
  },

  async command() {
    const number = Number(process.env.PR);
    const by = process.env.COMMENTER;
    if (by !== OWNER) return; // the workflow `if:` already checks; defense in depth
    const m = (process.env.COMMENT_BODY || '').trim().match(/^\/deps\s+(merge|hold|unhold|recheck)\b\s*([\s\S]*)$/);
    if (!m) {
      comment(number, 'Usage: `/deps merge` · `/deps hold <reason>` · `/deps unhold` · `/deps recheck`');
      return;
    }
    const [, verb, reason] = m;
    const pr = api(`repos/${REPO}/pulls/${number}`);
    if (pr.user.login !== DEPENDABOT_LOGIN) return;
    const labels = pr.labels.map((l) => l.name);
    // Commands only leave durable, append-only traces (an App comment, a label) and start
    // a run; the scheduled `act` job alone writes the record and merges. A command can
    // then never race `act`, and needs no shared concurrency group that could drop it.
    const dispatch = (...inputs) => gh(['workflow', 'run', 'deps-agent.yml', '--repo', REPO, ...inputs]);
    if (verb === 'merge') {
      comment(number, renderOverride(updatesKey(parseUpdatedDependencies(commitMessage(pr.head.sha))), by, reason));
      dispatch();
    } else if (verb === 'recheck') {
      comment(number, `Re-assessment requested by ${by}; a run has been started.`);
      dispatch('-f', `pr=${number}`); // pr=N bypasses the assessment cache in \`plan\`
    } else {
      setLabel(number, LABEL.hold, verb === 'hold', labels);
      setLabel(number, LABEL.escalated, false, labels);
      const note = reason.trim() ? `: ${neutralize(reason, 300)}` : '';
      comment(number, verb === 'hold' ? `On hold by ${by}${note}. deps-agent will leave this PR alone.` : `Hold lifted by ${by}.`);
      dispatch();
    }
  },
};

/** Test hook: each CI run is a fresh process, so the run caches only need clearing in tests. */
function clearRunCaches() {
  packuments.clear();
  baseCache.clear();
}

export { POLICY_HASH, clearRunCaches, commands, evaluatePr, handleMain };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      pr: { type: 'string' },
      facts: { type: 'string' },
      out: { type: 'string' },
      diffs: { type: 'string' },
      assessments: { type: 'string' },
    },
  });
  const run = commands[positionals[0]];
  if (!run) {
    console.error(`usage: cli.mjs <${Object.keys(commands).join('|')}>`);
    process.exit(2);
  }
  await run(values);
}
