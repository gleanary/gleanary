/**
 * A scripted world for the deps-agent run-sequence simulator: an in-memory GitHub (PRs,
 * comments, labels, issues, check runs, main with its CI and Deploy runs), npm (audit, diff)
 * and the npm registry, behind the same `gh`/`git`/`npm` calls and `fetch` the CLI makes.
 * Merges move main, rebases create new commits, and the clock is the test's: one `run()` is
 * one scheduled workflow run (plan, assess, act). See docs/deps/invariants.md.
 */
import { DEPENDABOT_COMMIT_EMAIL, REQUIRED_CHECKS } from '../../.github/deps-agent/gate.mjs';

export const REPO = 'o/r';
export const BOT = 'deps-agent[bot]';
export const OWNER = 'owner';
const REGISTRY = 'https://registry.npmjs.org/';

export interface Comment {
  id: number;
  body: string;
  user: { login: string; type: string };
  created_at: string;
}
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  completed_at?: string | null;
}
export interface WorkflowRun {
  status: string;
  conclusion: string | null;
  updated_at: string;
}
type Lock = { packages: Record<string, Record<string, unknown>> };
export interface Pr {
  number: number;
  title: string;
  branch: string;
  headSha: string;
  baseSha: string;
  rev: number;
  merged: boolean;
  mergeable: boolean;
  behindMain: boolean;
  labels: string[];
  comments: Comment[];
  message: string;
  committedAt: string;
  checks: CheckRun[];
  files: string[];
}
export interface Write {
  method: string;
  path: string;
  body: Record<string, unknown>;
}
export interface World {
  now: Date;
  mode: 'shadow' | 'merge';
  main: {
    sha: string;
    message: string;
    committedAt: string;
    ci: WorkflowRun[];
    deploy: WorkflowRun[];
  };
  prs: Pr[];
  /** package.json and package-lock.json by commit SHA */
  trees: Record<string, { pkg: Record<string, unknown>; lock: Lock }>;
  /** publish time by `name@version` (default: long ago) */
  publishedAt: Record<string, string>;
  registryDown: boolean;
  malwareDown: boolean;
  auditDown: boolean;
  diffsFail: boolean;
  recordSaveFails: boolean;
  /** GitHub's compare API has not caught up with a merge yet: other PRs still look fresh */
  compareLags: boolean;
  /** the assess job's output for a PR, or 'fail' when the job fails */
  assess: (pr: Pr) => Record<string, unknown> | 'fail';
  issues: {
    number: number;
    title: string;
    body: string;
    state: string;
    labels: string[];
    user: { login: string };
  }[];
  writes: Write[];
  git: string[][];
  dispatches: string[][];
  /** record saves the fake GitHub refused, by PR */
  refusedSaves: number[];
  nextId: number;
}

const LONG_AGO = '2026-01-01T00:00:00Z';
const iso = (d: Date) => d.toISOString();
const tgz = (name: string, v: string) => `${REGISTRY}${name}/-/${name.split('/').pop()}-${v}.tgz`;

/** A clean merge-ready assessment. */
export const mergeVerdict = () => ({
  verdict: 'merge',
  summary: 'routine bump',
  breakingChangesAffectingUs: [],
  securityFixes: [],
  adoptableFeatures: [],
  ciRead: '',
  injectionSuspected: false,
  codeReview: { coverage: 'full', suspicious: [] },
});
export const escalateVerdict = () => ({
  ...mergeVerdict(),
  verdict: 'escalate',
  escalation: { question: 'Take it?', recommendation: 'Hold', options: ['merge', 'hold'] },
});

const green = (now: Date): CheckRun[] =>
  REQUIRED_CHECKS.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    completed_at: iso(now),
  }));
const success = (now: Date): WorkflowRun[] => [
  { status: 'completed', conclusion: 'success', updated_at: iso(now) },
];

/** A world with a healthy main and no PRs. */
export function createWorld(now = new Date('2026-10-23T12:00:00Z')): World {
  return {
    now,
    mode: 'merge',
    main: {
      sha: 'main0',
      message: 'feat: something\n',
      committedAt: iso(now),
      ci: success(now),
      deploy: success(now),
    },
    prs: [],
    trees: {},
    publishedAt: {},
    registryDown: false,
    malwareDown: false,
    auditDown: false,
    diffsFail: false,
    recordSaveFails: false,
    compareLags: false,
    assess: () => mergeVerdict(),
    issues: [],
    writes: [],
    git: [],
    dispatches: [],
    refusedSaves: [],
    nextId: 1000,
  };
}

export interface Bump {
  name: string;
  from: string;
  to: string;
  type?: string;
  /** lockfile entries added on the head side only (transitive changes), by key */
  extraHead?: Record<string, Record<string, unknown>>;
  /** lockfile entries on both sides, by key */
  shared?: Record<string, Record<string, unknown>>;
}

/** A lockfile entry for a registry package. */
export const lockEntry = (name: string, version: string) => ({
  version,
  resolved: tgz(name, version),
});

/** Open a Dependabot PR for one declared bump; CI on it is green. */
export function openPr(world: World, number: number, bump: Bump): Pr {
  const entry = (v: string) => lockEntry(bump.name, v);
  const base = `base-${number}`;
  world.trees[base] = {
    pkg: { name: 'app', dependencies: { [bump.name]: `^${bump.from}` } },
    lock: { packages: { '': {}, [`node_modules/${bump.name}`]: entry(bump.from), ...bump.shared } },
  };
  const pr: Pr = {
    number,
    title: `chore(deps): bump ${bump.name} from ${bump.from} to ${bump.to}`,
    branch: `dependabot/npm_and_yarn/${bump.name}-${bump.to}`,
    headSha: '',
    baseSha: base,
    rev: 0,
    merged: false,
    mergeable: true,
    behindMain: false,
    labels: [],
    comments: [],
    message: [
      `chore(deps): bump ${bump.name} from ${bump.from} to ${bump.to}`,
      '',
      '---',
      'updated-dependencies:',
      `- dependency-name: ${bump.name}`,
      `  dependency-version: ${bump.to}`,
      `  dependency-type: ${bump.type ?? 'direct:production'}`,
      '...',
    ].join('\n'),
    committedAt: iso(world.now),
    checks: green(world.now),
    files: ['package.json', 'package-lock.json'],
  };
  world.prs.push(pr);
  pushHead(world, pr, {
    pkg: { name: 'app', dependencies: { [bump.name]: `^${bump.to}` } },
    lock: {
      packages: {
        '': {},
        [`node_modules/${bump.name}`]: entry(bump.to),
        ...bump.shared,
        ...bump.extraHead,
      },
    },
  });
  return pr;
}

/** A new head commit on the PR (Dependabot rebased or recreated it), with CI green again. */
export function pushHead(world: World, pr: Pr, tree?: World['trees'][string]): void {
  const previous = world.trees[pr.headSha];
  pr.rev += 1;
  // Unique in the first 7 characters, like a real SHA (escalations show 7).
  pr.headSha = `${String(pr.rev).padStart(3, '0')}${String(pr.number).padStart(4, '0')}`;
  world.trees[pr.headSha] = tree ?? previous!;
  pr.committedAt = iso(world.now);
  pr.checks = green(world.now);
  pr.behindMain = false;
  pr.mergeable = true;
}

/** Dependabot pushes a new head whose lockfile also has these entries (a re-resolved rebase). */
export function rebaseWith(
  world: World,
  pr: Pr,
  entries: Record<string, Record<string, unknown>>,
): void {
  const tree = world.trees[pr.headSha]!;
  pushHead(world, pr, { ...tree, lock: { packages: { ...tree.lock.packages, ...entries } } });
}

/** main's CI and Deploy for its current head finish green. */
export function mainGoesGreen(world: World): void {
  world.main.ci = success(world.now);
  world.main.deploy = success(world.now);
}

/** Owner comment on a PR, as `/deps <verb>`: runs the CLI's `command` job. */
export function ownerComment(world: World, pr: Pr, body: string): Comment {
  const c = {
    id: world.nextId++,
    body,
    user: { login: OWNER, type: 'User' },
    created_at: iso(world.now),
  };
  pr.comments.push(c);
  return c;
}

const prBy = (world: World, n: number) => world.prs.find((p) => p.number === n);

function versionsOf(world: World, name: string): Set<string> {
  const vs = new Set<string>();
  for (const t of Object.values(world.trees)) {
    for (const [key, e] of Object.entries(t.lock.packages)) {
      const n =
        (e.name as string) ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (n === name && e.version) vs.add(e.version as string);
    }
  }
  return vs;
}

function get(world: World, path: string): unknown {
  const [routePart, query = ''] = path.split('?');
  const route = routePart!;
  const params = new URLSearchParams(query);
  let m: RegExpMatchArray | null;
  if ((m = route.match(/pulls\/(\d+)$/))) return prObject(prBy(world, Number(m[1]))!);
  if (route.endsWith('/pulls')) return world.prs.filter((p) => !p.merged).map((p) => prObject(p));
  if ((m = route.match(/pulls\/(\d+)\/files$/)))
    return prBy(world, Number(m[1]))!.files.map((filename) => ({ filename }));
  if ((m = route.match(/git\/commits\/(.+)$/))) {
    const sha = m[1];
    if (sha === world.main.sha)
      return { message: world.main.message, committer: { date: world.main.committedAt } };
    const pr = world.prs.find((p) => p.headSha === sha)!;
    return {
      message: pr.message,
      committer: { date: pr.committedAt },
      author: { email: DEPENDABOT_COMMIT_EMAIL },
      verification: { verified: true },
    };
  }
  if ((m = route.match(/commits\/(.+)\/check-runs$/))) {
    const pr = world.prs.find((p) => p.headSha === m![1]);
    return { check_runs: (pr?.checks ?? []).map((c, i) => ({ id: i + 1, ...c })) };
  }
  if ((m = route.match(/compare\/(.+)\.\.\.(.+)$/))) {
    const pr = world.prs.find((p) => p.headSha === m![1])!;
    return pr.behindMain
      ? { ahead_by: 1, files: [{ filename: 'package-lock.json' }] }
      : { ahead_by: 0, files: [] };
  }
  if ((m = route.match(/contents\/(package(?:-lock)?\.json)$/))) {
    const tree = world.trees[params.get('ref')!]!;
    return m[1] === 'package.json' ? tree.pkg : tree.lock;
  }
  if (route === 'advisories') {
    if (world.malwareDown) throw new Error('gh: HTTP 502');
    return [];
  }
  if ((m = route.match(/issues\/(\d+)\/comments$/)))
    return prBy(world, Number(m[1]))?.comments ?? [];
  if (route.endsWith('/issues')) {
    const label = params.get('labels');
    return world.issues.filter(
      (i) =>
        (params.get('state') === 'all' || i.state === 'open') &&
        (!label || i.labels.includes(label)),
    );
  }
  if (route.startsWith('users/')) return { id: 99 };
  if (route.endsWith('/labels'))
    return ['deps:needs-human', 'deps:hold', 'deps:dashboard'].map((name) => ({ name }));
  if (route.endsWith('git/ref/heads/main')) return { object: { sha: world.main.sha } };
  if (route.endsWith('workflows/ci.yml/runs'))
    return { workflow_runs: [...world.main.ci].reverse() };
  if (route.endsWith('workflows/deploy.yml/runs'))
    return { workflow_runs: [...world.main.deploy].reverse() };
  throw new Error(`world: no GET route for ${path}`);
}

function prObject(pr: Pr) {
  return {
    number: pr.number,
    title: pr.title,
    html_url: `https://github.com/${REPO}/pull/${pr.number}`,
    user: { login: 'dependabot[bot]' },
    head: { sha: pr.headSha, ref: pr.branch },
    base: { sha: pr.baseSha },
    mergeable: pr.mergeable,
    labels: pr.labels.map((name) => ({ name })),
  };
}

/** The fake GitHub refuses record saves while `recordSaveFails` (a record over the size limit). */
function refuseRecordSave(world: World, pr: Pr | undefined, body: Record<string, unknown>): void {
  if (pr && world.recordSaveFails && String(body.body).includes('deps-agent:record')) {
    world.refusedSaves.push(pr.number);
    throw new Error('Validation Failed: body is too long (maximum is 65536 characters)');
  }
}

function write(world: World, method: string, path: string, body: Record<string, unknown>): unknown {
  let m: RegExpMatchArray | null;
  if ((m = path.match(/issues\/(\d+)\/comments$/)) && method === 'POST') {
    const pr = prBy(world, Number(m[1]));
    refuseRecordSave(world, pr, body);
    world.writes.push({ method, path, body });
    const c = {
      id: world.nextId++,
      body: String(body.body),
      user: { login: BOT, type: 'Bot' },
      created_at: iso(world.now),
    };
    if (pr) pr.comments.push(c);
    return c;
  }
  if ((m = path.match(/issues\/comments\/(\d+)$/)) && method === 'PATCH') {
    const id = Number(m[1]);
    const pr = world.prs.find((p) => p.comments.some((x) => x.id === id));
    const c = pr?.comments.find((x) => x.id === id);
    refuseRecordSave(world, pr, body);
    world.writes.push({ method, path, body });
    if (c) c.body = String(body.body);
    return c ?? {};
  }
  world.writes.push({ method, path, body });
  if ((m = path.match(/pulls\/(\d+)\/merge$/))) {
    const pr = prBy(world, Number(m[1]))!;
    if (body.sha !== pr.headSha)
      throw new Error('gh: Head branch was modified. Review and try the merge again. (HTTP 409)');
    pr.merged = true;
    world.main = {
      sha: `main-${pr.number}`,
      message: `${body.commit_title}\n\n${body.commit_message}\n`,
      committedAt: iso(world.now),
      ci: [],
      deploy: [],
    };
    // Every merge touches the lockfile: the other open PRs are now behind main.
    if (!world.compareLags)
      for (const other of world.prs) if (!other.merged) other.behindMain = true;
    return { merged: true };
  }
  if ((m = path.match(/issues\/(\d+)\/labels$/)) && method === 'POST') {
    const pr = prBy(world, Number(m[1]));
    for (const l of body.labels as string[]) if (pr && !pr.labels.includes(l)) pr.labels.push(l);
    return {};
  }
  if ((m = path.match(/issues\/(\d+)\/labels\/(.+)$/)) && method === 'DELETE') {
    const pr = prBy(world, Number(m[1]));
    if (pr) pr.labels = pr.labels.filter((l) => l !== decodeURIComponent(m![2]!));
    return {};
  }
  if (path.endsWith('/issues') && method === 'POST') {
    const number = world.nextId++;
    world.issues.push({
      number,
      title: String(body.title),
      body: String(body.body),
      state: 'open',
      labels: (body.labels as string[]) ?? [],
      user: { login: BOT },
    });
    return { number };
  }
  if ((m = path.match(/issues\/(\d+)$/)) && method === 'PATCH') {
    const issue = world.issues.find((i) => i.number === Number(m![1]));
    if (issue) Object.assign(issue, body);
    return {};
  }
  if (path.endsWith('/pulls') && method === 'POST')
    return { html_url: `https://github.com/${REPO}/pull/900` };
  return {};
}

/** The `execFileSync` the CLI sees. */
export function exec(world: World, cmd: string, args: string[], opts?: { input?: string }): string {
  const arg = (i: number) => args[i] ?? '';
  if (cmd === 'npm') {
    if (args[0] === 'pack') return '';
    if (args[0] === 'diff') {
      if (world.diffsFail) throw new Error('npm diff: ETIMEDOUT');
      return args.includes('--diff-name-only')
        ? 'index.js\n'
        : 'diff --git a/index.js b/index.js\n';
    }
    if (world.auditDown)
      throw Object.assign(new Error('npm audit: ETIMEDOUT'), {
        stdout: '{"error":{"summary":"network"}}',
      });
    return JSON.stringify({ vulnerabilities: {} });
  }
  if (cmd === 'git') {
    world.git.push(args);
    return '';
  }
  if (args[0] === 'workflow') {
    world.dispatches.push(args);
    return '';
  }
  if (args.includes('--paginate')) return JSON.stringify([get(world, arg(args.length - 1))]);
  if (args[1] === '-H') return JSON.stringify(get(world, arg(3)));
  if (args[1] === '-X')
    return JSON.stringify(write(world, arg(2), arg(3), JSON.parse(opts?.input || '{}')));
  return JSON.stringify(get(world, arg(1)));
}

/** The `fetch` the CLI sees: the npm registry, answering from the world's lockfiles. */
export async function registryFetch(world: World, url: string): Promise<Response> {
  if (world.registryDown) return new Response('{}', { status: 503 });
  const name = decodeURIComponent(String(url).slice(REGISTRY.length));
  const versions = [...versionsOf(world, name)];
  if (!versions.length) return new Response('{}', { status: 404 });
  const doc = {
    time: Object.fromEntries(
      versions.map((v) => [v, world.publishedAt[`${name}@${v}`] ?? LONG_AGO]),
    ),
    versions: Object.fromEntries(
      versions.map((v) => [v, { _npmUser: { name: 'maintainer' }, dist: {} }]),
    ),
    repository: { url: `git+https://github.com/example/${name}.git` },
  };
  return new Response(JSON.stringify(doc), { status: 200 });
}
