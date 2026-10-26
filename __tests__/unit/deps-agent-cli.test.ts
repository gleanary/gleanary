import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPENDABOT_COMMIT_EMAIL,
  REQUIRED_CHECKS,
  assessmentKey,
  lockFingerprint,
  verdictDetail,
  waiverKey,
} from '../../.github/deps-agent/gate.mjs';
import { decodeRecord, renderOverride } from '../../.github/deps-agent/record.mjs';

// The CLI shells out to `gh`, `git` and `npm`; every call goes through this fake GitHub,
// which keeps comments and issues in memory and records writes, git and dispatch calls.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

const REPO = 'o/r';
const BOT = 'deps-agent[bot]';
const NOW = new Date('2026-10-23T12:00:00Z');
const PR = 7;
const MESSAGE = [
  'chore(deps): bump zod from 4.4.3 to 4.6.7',
  '',
  '---',
  'updated-dependencies:',
  '- dependency-name: zod',
  '  dependency-version: 4.6.7',
  '  dependency-type: direct:production',
  '...',
].join('\n');

interface Comment {
  id: number;
  body: string;
  user: { login: string; type: string };
  created_at?: string;
}
interface FakeState {
  withMs: boolean;
  msPublishedAt: string;
  registryStatus: number;
  branch: string;
  gitPushFails: boolean;
  extraFiles: string[];
  compareCapped: boolean;
  deployConclusion: string;
  auditFails: boolean;
  recordSaveFails: boolean;
  npmCalls: number;
  npmDiffFiles: string[];
  npmDiffs: string[][];
  fetchCalls: number;
  headSha: string;
  mergeable: boolean;
  fresh: boolean;
  labels: string[];
  comments: Comment[];
  issues: { number: number; title: string; pull_request?: unknown }[];
  writes: { method: string; path: string; body: Record<string, unknown> }[];
  git: string[][];
  dispatches: string[][];
  mainMessage: string;
}

let state: FakeState;
let nextId = 1000;

const tarball = (name: string, v: string) =>
  `https://registry.npmjs.org/${name}/-/${name}-${v}.tgz`;
const lock = (zod: string, ms?: string) => ({
  packages: {
    '': { version: '0.1.0' },
    'node_modules/zod': { version: zod, resolved: tarball('zod', zod) },
    ...(ms ? { 'node_modules/ms': { version: ms, resolved: tarball('ms', ms) } } : {}),
  },
});
/** Fingerprint of what the fake head lockfile introduces (zod, plus ms when enabled). */
const headFingerprint = () =>
  lockFingerprint([
    { name: 'zod', to: '4.6.7' },
    ...(state.withMs ? [{ name: 'ms', to: '2.1.4' }] : []),
  ]);
const pkg = (zod: string) => ({ name: 'gleanary', dependencies: { zod: `^${zod}` } });

const fakePr = () => ({
  number: PR,
  title: 'chore(deps): bump zod from 4.4.3 to 4.6.7',
  html_url: `https://github.com/${REPO}/pull/${PR}`,
  user: { login: 'dependabot[bot]' },
  head: { sha: state.headSha, ref: state.branch },
  base: { sha: 'base1' },
  mergeable: state.mergeable,
  labels: state.labels.map((name) => ({ name })),
});

function get(path: string): unknown {
  const routes: [RegExp, () => unknown][] = [
    [new RegExp(`^repos/${REPO}/pulls/${PR}$`), () => fakePr()],
    [new RegExp(`^repos/${REPO}/pulls\\?state=open`), () => [fakePr()]],
    [
      /\/pulls\/\d+\/files/,
      () => [
        { filename: 'package.json' },
        { filename: 'package-lock.json' },
        ...state.extraFiles.map((filename) => ({ filename })),
      ],
    ],
    [
      /\/git\/commits\/main1$/,
      () => ({ message: state.mainMessage, committer: { date: '2026-10-23T11:00:00Z' } }),
    ],
    [
      /\/git\/commits\//,
      () => ({
        message: MESSAGE,
        committer: { date: '2026-10-23T11:00:00Z' },
        author: { email: DEPENDABOT_COMMIT_EMAIL },
        verification: { verified: true },
      }),
    ],
    [
      /\/check-runs/,
      () => ({
        check_runs: REQUIRED_CHECKS.map((name, i) => ({
          id: i + 1,
          name,
          status: 'completed',
          conclusion: 'success',
        })),
      }),
    ],
    [
      /\/compare\//,
      () =>
        state.compareCapped
          ? {
              ahead_by: 400,
              files: Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.ts` })),
            }
          : state.fresh
            ? { ahead_by: 0, files: [] }
            : { ahead_by: 1, files: [{ filename: 'package-lock.json' }] },
    ],
    [/contents\/package\.json\?ref=base1/, () => pkg('4.4.3')],
    [
      /contents\/package-lock\.json\?ref=base1/,
      () => lock('4.4.3', state.withMs ? '2.1.3' : undefined),
    ],
    [/contents\/package\.json\?ref=/, () => pkg('4.6.7')],
    [/contents\/package-lock\.json\?ref=/, () => lock('4.6.7', state.withMs ? '2.1.4' : undefined)],
    [/^advisories\?/, () => []],
    [new RegExp(`issues/${PR}/comments`), () => state.comments],
    [/issues\?state=open&labels=deps:needs-human/, () => state.issues],
    [/^users\//, () => ({ id: 99 })],
    // what a full `act` run reads besides the PR itself
    [
      /\/labels\?per_page/,
      () => [{ name: 'deps:needs-human' }, { name: 'deps:hold' }, { name: 'deps:dashboard' }],
    ],
    [/\/git\/ref\/heads\/main$/, () => ({ object: { sha: 'main1' } })],
    [
      /workflows\/ci\.yml\/runs/,
      () => ({
        workflow_runs: [
          { status: 'completed', conclusion: 'success', updated_at: '2026-10-23T11:00:00Z' },
        ],
      }),
    ],
    [
      /workflows\/deploy\.yml\/runs/,
      () => ({ workflow_runs: [{ status: 'completed', conclusion: state.deployConclusion }] }),
    ],
    [/issues\?state=open&labels=deps:dashboard/, () => []],
  ];
  const route = routes.find(([re]) => re.test(path));
  if (!route) throw new Error(`fake gh: no GET route for ${path}`);
  return route[1]();
}

function write(method: string, path: string, body: Record<string, unknown>): unknown {
  if (state.recordSaveFails && String(body.body ?? '').includes('deps-agent:record')) {
    throw new Error('Validation Failed: body is too long (maximum is 65536 characters)');
  }
  state.writes.push({ method, path, body });
  if (method === 'POST' && path.endsWith(`issues/${PR}/comments`)) {
    const c = {
      id: nextId++,
      body: String(body.body),
      user: { login: BOT, type: 'Bot' },
      created_at: new Date().toISOString(),
    };
    state.comments.push(c);
    return c;
  }
  if (method === 'PATCH' && path.includes('issues/comments/')) {
    const c = state.comments.find((x) => path.endsWith(`/${x.id}`));
    if (c) c.body = String(body.body);
    return c ?? {};
  }
  if (method === 'POST' && path.endsWith('/pulls'))
    return { html_url: `https://github.com/${REPO}/pull/99` };
  if (method === 'POST' && path.endsWith('/issues')) return { number: 50 };
  return {};
}

function fakeExec(cmd: string, args: string[], opts?: { input?: string }): string {
  const arg = (i: number) => args[i] ?? '';
  if (cmd === 'npm') {
    state.npmCalls++;
    if (args[0] === 'diff') {
      if (args.includes('--diff-name-only')) return state.npmDiffFiles.join('\n');
      state.npmDiffs.push(args);
      return 'diff --git a/x b/x\n';
    }
    if (state.auditFails)
      throw Object.assign(new Error('npm audit: ETIMEDOUT'), {
        stdout: '{"error":{"summary":"network"}}',
      });
    return JSON.stringify({ vulnerabilities: {} }); // npm audit
  }
  if (cmd === 'git') {
    state.git.push(args);
    if (state.gitPushFails && args[0] === 'push')
      throw new Error('remote: Permission to push denied');
    return '';
  }
  if (args[0] === 'workflow') {
    state.dispatches.push(args);
    return '';
  }
  if (args.includes('--paginate')) return JSON.stringify([get(arg(args.length - 1))]);
  if (args[1] === '-H') return JSON.stringify(get(arg(3)));
  if (args[1] === '-X')
    return JSON.stringify(write(arg(2), arg(3), JSON.parse(opts?.input || '{}')));
  return JSON.stringify(get(arg(1)));
}

const packument = {
  time: { '4.4.3': '2026-09-01T00:00:00Z', '4.6.7': '2026-10-01T00:00:00Z' },
  versions: {
    '4.4.3': { _npmUser: { name: 'colinhacks' }, dist: { attestations: {} } },
    '4.6.7': { _npmUser: { name: 'colinhacks' }, dist: { attestations: {} } },
  },
  repository: { url: 'git+https://github.com/colinhacks/zod.git' },
};

type Cli = typeof import('../../.github/deps-agent/cli.mjs');
let cli: Cli;
const healthy = { sha: 'main1', state: 'healthy', detail: 'ok' };

const pings = () => state.comments.filter((c) => c.body.startsWith('@owner'));
const merges = () => state.writes.filter((w) => w.method === 'PUT' && w.path.endsWith('/merge'));
const record = () =>
  decodeRecord(state.comments.find((c) => c.body.includes('deps-agent:record'))?.body ?? '') as {
    outcome?: string;
  } | null;
/** The override `/deps merge` records after an escalation on the verdict. */
const verdictOverride = () => {
  const detail = verdictDetail(assessed('escalate').assessment);
  return {
    versions: 'zod@4.6.7',
    lock: headFingerprint(),
    waive: [{ id: 'verdict', key: waiverKey({ detail }), detail }],
    by: 'owner',
  };
};
const assessed = (verdict: 'merge' | 'escalate') => ({
  key: assessmentKey({
    updates: [{ name: 'zod', version: '4.6.7' }],
    checks: REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    policyHash: cli.POLICY_HASH,
    lockFingerprint: headFingerprint(),
  }),
  assessment: {
    verdict,
    summary: 'test',
    codeReview: { coverage: 'full', suspicious: [] as { file: string; finding: string }[] },
    ...(verdict === 'escalate'
      ? { escalation: { question: 'Take it?', recommendation: 'Hold', options: ['merge', 'hold'] } }
      : {}),
  },
});

/** PR numbers `plan` would send to the assess matrix (read back from GITHUB_OUTPUT). */
const planned = async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-plan-'));
  const file = join(dir, 'out');
  writeFileSync(file, '');
  vi.stubEnv('GITHUB_OUTPUT', file);
  try {
    await cli.commands.plan();
    return JSON.parse(readFileSync(file, 'utf8').split('\n')[1] ?? '[]') as number[];
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
};

beforeAll(async () => {
  Object.assign(process.env, {
    GITHUB_REPOSITORY: REPO,
    MODE: 'merge',
    OWNER_LOGIN: 'owner',
    APP_SLUG: 'deps-agent',
    RUN_URL: 'https://example.test/run',
  });
  vi.mocked(execFileSync).mockImplementation(fakeExec as unknown as typeof execFileSync);
  // Stub after the global MSW setup patches fetch; the registry is the only fetch target.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      state.fetchCalls++;
      if (state.registryStatus !== 200) return new Response('{}', { status: state.registryStatus });
      const doc = String(url).endsWith('/ms')
        ? {
            time: { '2.1.3': '2026-01-01T00:00:00Z', '2.1.4': state.msPublishedAt },
            versions: { '2.1.3': { dist: {} }, '2.1.4': { dist: {} } },
          }
        : packument;
      return new Response(JSON.stringify(doc), { status: 200 });
    }),
  );
  cli = await import('../../.github/deps-agent/cli.mjs');
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  cli?.clearRunCaches();
  state = {
    withMs: false,
    msPublishedAt: '2026-10-01T00:00:00Z',
    registryStatus: 200,
    branch: 'dependabot/npm_and_yarn/zod-4.6.7',
    gitPushFails: false,
    extraFiles: [],
    compareCapped: false,
    deployConclusion: 'success',
    auditFails: false,
    recordSaveFails: false,
    npmCalls: 0,
    npmDiffFiles: [],
    npmDiffs: [],
    fetchCalls: 0,
    headSha: 'head1',
    mergeable: true,
    fresh: true,
    labels: [],
    comments: [],
    issues: [],
    writes: [],
    git: [],
    dispatches: [],
    mainMessage: 'feat: something\n',
  };
});

describe('evaluatePr', () => {
  it('merges a clean PR, pinned to the evaluated commit, and records it', async () => {
    const { outcome } = await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('merge'),
      slot: { free: true },
    });
    expect(outcome).toBe('merge');
    expect(merges()).toHaveLength(1);
    expect(merges()[0]?.body.sha).toBe('head1');
    expect(record()?.outcome).toBe('merge');
  });

  it('pings the owner once per reason: a rebase with the same versions stays quiet', async () => {
    await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('escalate'),
      slot: { free: true },
    });
    expect(pings()).toHaveLength(1);
    state.headSha = 'head2'; // Dependabot rebased: new commit, same versions
    const { outcome } = await cli.evaluatePr(PR, { main: healthy, now: NOW, slot: { free: true } });
    expect(outcome).toBe('escalate'); // the cached assessment still applies after the rebase
    expect(pings()).toHaveLength(1);
  });

  it('applies an override written by the App, and survives a rebase', async () => {
    state.comments.push({
      id: 1,
      body: renderOverride(verdictOverride(), ''),
      user: { login: BOT, type: 'Bot' },
    });
    await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('escalate'),
      slot: { free: true },
    });
    expect(merges()).toHaveLength(1);
  });

  it('ignores an override marker pasted by anyone else', async () => {
    state.comments.push({
      id: 1,
      body: renderOverride(verdictOverride(), ''),
      user: { login: 'mallory', type: 'User' },
    });
    const { outcome } = await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('escalate'),
      slot: { free: true },
    });
    expect(outcome).toBe('escalate');
    expect(merges()).toHaveLength(0);
  });

  it('drops an override once a rebase changes the lockfile, and says why', async () => {
    state.comments.push({
      id: 1,
      body: renderOverride(verdictOverride(), ''),
      user: { login: BOT, type: 'Bot' },
    });
    state.withMs = true; // the rebase re-resolved the lockfile: ms is now introduced too
    const { outcome } = await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('escalate'),
      slot: { free: true },
    });
    expect(outcome).toBe('escalate');
    expect(merges()).toHaveLength(0);
    expect(pings()[0]?.body).toContain('covered a different lockfile');
  });

  it('asks Dependabot to rebase once, then escalates if nothing happened after 24 h', async () => {
    state.fresh = false;
    await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('merge'),
      slot: { free: true },
    });
    const rebaseRequests = () => state.comments.filter((c) => c.body === '@dependabot rebase');
    expect(rebaseRequests()).toHaveLength(1);
    expect(pings()).toHaveLength(0);

    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    const { outcome } = await cli.evaluatePr(PR, {
      main: healthy,
      now: later,
      slot: { free: true },
    });
    expect(outcome).toBe('escalate');
    expect(rebaseRequests()).toHaveLength(1);
    expect(pings()[0]?.body).toContain('has not rebased');
  });
});

describe('handleMain', () => {
  it('opens a revert PR and an issue when its own merge broke main', () => {
    state.mainMessage = 'chore(deps): bump zod (#7)\n\nMerged-by: deps-agent\n';
    cli.handleMain({ sha: 'main1', state: 'broken', detail: 'Deploy: failure' });
    expect(state.git.map((a) => a[0])).toEqual(['fetch', 'checkout', 'revert', 'push']);
    expect(state.git[2]).toEqual(['revert', '--no-edit', 'main1']);
    const issue = state.writes.find((w) => w.method === 'POST' && w.path.endsWith('/issues'));
    expect(issue?.body.title).toBe('deps-agent: main main1 is broken');
    expect(String(issue?.body.body)).toContain('Revert PR ready: https://github.com/o/r/pull/99');
  });

  it('freezes without reverting when a human commit broke main', () => {
    cli.handleMain({ sha: 'main1', state: 'broken', detail: 'CI on main: failure' });
    expect(state.git).toEqual([]);
    const issue = state.writes.find((w) => w.method === 'POST' && w.path.endsWith('/issues'));
    expect(String(issue?.body.body)).not.toContain('Revert');
  });

  it('files the issue once per broken commit', () => {
    state.issues = [{ number: 50, title: 'deps-agent: main main1 is broken' }];
    cli.handleMain({ sha: 'main1', state: 'broken', detail: 'Deploy: failure' });
    expect(state.writes).toEqual([]);
  });

  it('closes the freeze issue once main is healthy again', () => {
    state.issues = [{ number: 50, title: 'deps-agent: main old1234 is broken' }];
    cli.handleMain(healthy);
    expect(state.writes.some((w) => w.method === 'PATCH' && w.body.state === 'closed')).toBe(true);
  });
});

describe('plan', () => {
  /** PR numbers `plan` would send to the assess matrix. */

  it('agrees with act on the cache key: an assessed PR is not queued again', async () => {
    expect(await planned()).toEqual([PR]); // no record yet
    await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('merge'),
      slot: { free: false },
    });
    expect(await planned()).toEqual([]);
    state.headSha = 'head2'; // a rebase that leaves the lockfile alone reuses the assessment
    expect(await planned()).toEqual([]);
    // A rebase that re-resolves the lockfile (always a new commit) needs a fresh one.
    state.withMs = true;
    state.headSha = 'head3';
    expect(await planned()).toEqual([PR]);
  });
});

describe('npm registry failures', () => {
  const evaluate = () =>
    cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('merge'),
      slot: { free: true },
    });

  it('waits through a registry outage instead of pinging the owner', async () => {
    state.registryStatus = 503;
    const { outcome } = await evaluate();
    expect(outcome).toBe('wait');
    expect(pings()).toHaveLength(0);
  });

  it('escalates when npm answers 404 (the package is not on the registry)', async () => {
    state.registryStatus = 404;
    const { outcome } = await evaluate();
    expect(outcome).toBe('escalate');
  });

  it('pings the owner once an outage on this PR has lasted 48 hours', async () => {
    state.registryStatus = 503;
    expect((await evaluate()).outcome).toBe('wait');
    cli.clearRunCaches(); // a later run is a fresh process
    const later = new Date(NOW.getTime() + 49 * 3_600_000);
    const { outcome } = await cli.evaluatePr(PR, {
      main: healthy,
      now: later,
      slot: { free: true },
    });
    expect(outcome).toBe('escalate');
    expect(pings()).toHaveLength(1);
    expect(pings()[0]?.body).toContain('npm registry');
  });
});

describe('ping deduplication', () => {
  const escalate = (main = healthy) =>
    cli.evaluatePr(PR, { main, now: NOW, assessment: assessed('escalate'), slot: { free: true } });

  it('does not ping again when only transient state changes (main busy, branch behind)', async () => {
    await escalate();
    expect(pings()).toHaveLength(1);
    state.fresh = false; // another PR merged: this one is behind until Dependabot rebases
    await escalate();
    state.fresh = true;
    await escalate();
    await escalate({ sha: 'main1', state: 'pending', detail: 'CI on main is running' });
    expect(pings()).toHaveLength(1);
  });
});

describe('cooldown wait', () => {
  it('escalates once a PR has waited 14 days on young transitive versions', async () => {
    state.withMs = true;
    state.msPublishedAt = '2026-10-22T12:00:00Z'; // a day before NOW: still cooling down
    const first = await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('merge'),
      slot: { free: true },
    });
    expect(first.outcome).toBe('wait');
    expect(pings()).toHaveLength(0);

    // 15 days later, a rebase has pulled in an even newer ms: the PR is still cooling down.
    const later = new Date(NOW.getTime() + 15 * 86_400_000);
    state.msPublishedAt = new Date(later.getTime() - 86_400_000).toISOString();
    cli.clearRunCaches(); // a later run is a fresh process
    const { outcome } = await cli.evaluatePr(PR, {
      main: healthy,
      now: later,
      slot: { free: true },
    });
    expect(outcome).toBe('escalate');
    expect(pings()[0]?.body).toContain('waited 14 days');

    // The suggested `/deps merge` must actually work: it waives the overdue cooldown.
    Object.assign(process.env, { PR: String(PR), COMMENTER: 'owner', COMMENT_BODY: '/deps merge' });
    await cli.commands.command();
    expect(state.comments.some((c) => c.body.includes('deps-agent:override'))).toBe(true);
    cli.clearRunCaches();
    const after = await cli.evaluatePr(PR, { main: healthy, now: later, slot: { free: true } });
    expect(after.outcome).toBe('merge');
  });
});

describe('ninth review', () => {
  const rebaseRequests = () => state.comments.filter((c) => c.body === '@dependabot rebase');

  it('keeps the merge slot used when something fails after a successful merge', async () => {
    const slot = { free: true };
    state.recordSaveFails = true; // the merge succeeds, then saving the record throws
    await expect(
      cli.evaluatePr(PR, { main: healthy, now: NOW, assessment: assessed('merge'), slot }),
    ).rejects.toThrow();
    expect(merges()).toHaveLength(1);
    expect(slot.free).toBe(false); // a second PR in the same run must not merge
  });

  it('does not let a held evaluation reset the commit /deps merge checks against', async () => {
    await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('escalate'),
      slot: { free: true },
    });
    state.labels = ['deps:hold'];
    state.headSha = 'head2'; // Dependabot pushed while the PR was held
    await cli.evaluatePr(PR, { main: healthy, now: NOW, slot: { free: true } });
    state.labels = [];
    Object.assign(process.env, { PR: String(PR), COMMENTER: 'owner', COMMENT_BODY: '/deps merge' });
    await cli.commands.command();
    expect(state.comments.some((c) => c.body.includes('deps-agent:override'))).toBe(false);
    expect(state.comments.at(-1)?.body).toContain('changed since deps-agent last evaluated it');
  });

  it('treats a main change past the compare API file cap as not fresh', async () => {
    state.compareCapped = true;
    vi.stubEnv('MODE', 'merge');
    try {
      await cli.evaluatePr(PR, {
        main: healthy,
        now: NOW,
        assessment: assessed('merge'),
        slot: { free: true },
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(merges()).toHaveLength(0);
    expect(rebaseRequests()).toHaveLength(1);
  });

  it('dates an assessment by when it was made, so an older one cannot satisfy a recheck', async () => {
    const t0 = new Date(Date.now() - 60_000);
    await cli.evaluatePr(PR, {
      main: healthy,
      now: t0,
      assessment: assessed('merge'),
      slot: { free: false },
    });
    Object.assign(process.env, {
      PR: String(PR),
      COMMENTER: 'owner',
      COMMENT_BODY: '/deps recheck',
    });
    await cli.commands.command();
    // This run carries an assessment made BEFORE the recheck (e.g. a queued older run).
    const stale = { ...assessed('merge'), assessedAt: t0.toISOString() };
    await cli.evaluatePr(PR, {
      main: healthy,
      now: new Date(),
      assessment: stale,
      slot: { free: false },
    });
    expect(await planned()).toEqual([PR]);
  });

  it('builds the prompt literally, whatever $ patterns the inputs contain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deps-prompt-'));
    const facts = join(dir, 'facts.json');
    writeFileSync(
      facts,
      JSON.stringify({
        meta: { title: "costs $& and $' and $$", headSha: 'h' },
        facts: { updates: [] },
      }),
    );
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ diffs: [], transitiveNotReviewed: 0 }));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    vi.stubEnv('GITHUB_OUTPUT', out);
    try {
      await cli.commands.prompt({ pr: '7', facts, diffs: dir });
      expect(readFileSync(out, 'utf8')).toContain("costs $& and $' and $$");
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('eighth review', () => {
  it('does not queue a held PR for assessment', async () => {
    state.labels = ['deps:hold'];
    expect(await planned()).toEqual([]);
  });

  it('does not queue PRs whose outcome is escalation regardless of the review', async () => {
    state.branch = 'dependabot/github_actions/actions-abc'; // the github-actions group PR
    expect(await planned()).toEqual([]);
  });

  it('does not re-assess a commit that already failed a hard rule no review can change', async () => {
    state.extraFiles = ['src/proxy.ts']; // `files` (hard): the PR touches more than the lockfile
    await cli.evaluatePr(PR, { main: healthy, now: NOW, slot: { free: false } });
    expect(await planned()).toEqual([]);
  });

  it('keeps evaluating PRs when handling a broken main fails', async () => {
    // main broken by a deps-agent merge, and the revert push is rejected
    state.deployConclusion = 'failure';
    state.mainMessage = 'chore(deps): bump zod (#7)\n\nMerged-by: deps-agent\n';
    state.gitPushFails = true;
    vi.stubEnv('MODE', 'merge');
    try {
      await cli.commands.act({ assessments: undefined });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(state.comments.some((c) => c.body.includes('deps-agent:record'))).toBe(true); // PR evaluated
    expect(
      state.writes.some(
        (w) =>
          w.method === 'POST' &&
          w.path.endsWith('/issues') &&
          String(w.body.title).includes('Dependency dashboard'),
      ),
    ).toBe(true);
  });

  it('keeps the outage clock running through a single successful answer', async () => {
    const at = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
    const run = async (h: number) => {
      cli.clearRunCaches();
      return cli.evaluatePr(PR, {
        main: healthy,
        now: at(h),
        assessment: assessed('merge'),
        slot: { free: false },
      });
    };
    state.registryStatus = 503;
    await run(0);
    state.registryStatus = 200; // answers once...
    await run(20);
    state.registryStatus = 503; // ...then fails again
    const { outcome } = await run(49);
    expect(outcome).toBe('escalate');
    expect(pings()).toHaveLength(1);
  });

  it('escapes apostrophes in the schema passed on the command line', () => {
    const arg = cli.schemaArg({ description: "the model's answer" });
    expect(arg.startsWith("'") && arg.endsWith("'")).toBe(true);
    const inner = arg.slice(1, -1);
    expect(inner).not.toContain("'");
    expect(JSON.parse(inner)).toEqual({ description: "the model's answer" });
  });
});

describe('seventh review', () => {
  const evaluate = (over: Record<string, unknown> = {}) =>
    cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('escalate'),
      slot: { free: true },
      ...over,
    });
  const rebaseRequests = () => state.comments.filter((c) => c.body === '@dependabot rebase');
  const recordBody = () =>
    state.comments.find((c) => c.body.includes('deps-agent:record'))?.body ?? '';

  it('posts no ping or rebase request when the record cannot be saved, so nothing repeats', async () => {
    state.recordSaveFails = true;
    state.fresh = false;
    await expect(evaluate()).rejects.toThrow(/too long/);
    await expect(evaluate()).rejects.toThrow(/too long/);
    expect(pings()).toHaveLength(0);
    expect(rebaseRequests()).toHaveLength(0);
  });

  it('clamps oversized assessment fields before they reach the record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deps-clamp-'));
    const facts = join(dir, 'facts.json');
    const out = join(dir, 'assessment.json');
    writeFileSync(
      facts,
      JSON.stringify({
        meta: { headSha: 'h' },
        facts: { updates: [], checks: [], lock: { changed: [] } },
      }),
    );
    const huge = 'x'.repeat(200_000);
    vi.stubEnv(
      'ASSESSMENT',
      JSON.stringify({
        verdict: 'escalate',
        summary: huge,
        breakingChangesAffectingUs: Array.from({ length: 500 }, () => ({
          change: huge,
          usage: huge,
        })),
        securityFixes: [],
        adoptableFeatures: [],
        ciRead: huge,
        injectionSuspected: false,
        codeReview: { coverage: 'full', suspicious: [{ file: huge, finding: huge }] },
      }),
    );
    try {
      await cli.commands['save-assessment']({ pr: '7', facts, out });
      expect(readFileSync(out, 'utf8').length).toBeLessThan(40_000);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not ask Dependabot to rebase a held PR, nor in shadow mode', async () => {
    state.fresh = false;
    state.labels = ['deps:hold'];
    await evaluate();
    expect(rebaseRequests()).toHaveLength(0);
    state.labels = [];
    vi.stubEnv('MODE', 'shadow');
    try {
      await evaluate();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(rebaseRequests()).toHaveLength(0);
  });

  it('waits when npm audit itself fails, and pings once that has lasted 48 hours', async () => {
    state.auditFails = true;
    const first = await evaluate({ assessment: assessed('merge') });
    expect(first.outcome).toBe('wait');
    expect(pings()).toHaveLength(0);
    cli.clearRunCaches();
    const later = new Date(NOW.getTime() + 49 * 3_600_000);
    const { outcome } = await cli.evaluatePr(PR, {
      main: healthy,
      now: later,
      slot: { free: true },
    });
    expect(outcome).toBe('escalate');
    expect(pings()[0]?.body).toContain('audit');
  });

  it('keeps a /deps recheck request until a fresh assessment is stored', async () => {
    const t0 = new Date(Date.now() - 60_000);
    await cli.evaluatePr(PR, {
      main: healthy,
      now: t0,
      assessment: assessed('merge'),
      slot: { free: false },
    });
    expect(await planned()).toEqual([]); // assessed, nothing to do
    Object.assign(process.env, {
      PR: String(PR),
      COMMENTER: 'owner',
      COMMENT_BODY: '/deps recheck',
    });
    await cli.commands.command();
    // The dispatched run's act was cancelled: the next scheduled plan still re-assesses.
    expect(await planned()).toEqual([PR]);
    await cli.evaluatePr(PR, {
      main: healthy,
      now: new Date(),
      assessment: assessed('merge'),
      slot: { free: false },
    });
    expect(await planned()).toEqual([]);
  });

  it('marks an assessment as outdated once the PR state no longer matches it', async () => {
    await evaluate({ assessment: assessed('merge'), slot: { free: false } });
    expect(recordBody()).toContain('**Assessment**');
    state.withMs = true; // a rebase re-resolved the lockfile
    state.headSha = 'head2';
    cli.clearRunCaches();
    await cli.evaluatePr(PR, { main: healthy, now: NOW, slot: { free: false } });
    expect(recordBody()).not.toContain('**Assessment**');
    expect(recordBody()).toContain('outdated');
  });

  it('records a held PR without collecting registry or audit facts', async () => {
    state.labels = ['deps:hold'];
    const { outcome } = await evaluate();
    expect(outcome).toBe('held');
    expect(state.npmCalls).toBe(0);
    expect(state.fetchCalls).toBe(0);
  });
});

describe('assessment tool flags', () => {
  // GitHub-hosted runners check out under /home/runner/work and set HOME=/home/runner.
  // A deny rule beats every allow rule, so no deny may match the checkout.
  const WORKSPACE_FILE = '/home/runner/work/gleanary/gleanary/src/lib/sanitize.ts';
  const denies = (rules: string[], path: string) =>
    rules.some((rule) => {
      const m = rule.match(/^Read\((.+)\)$/);
      if (!m?.[1]) return false;
      const pattern = m[1]
        .replace(/^~\//, '//home/runner/')
        .replace(/^\/\//, '/')
        .replace(/\*\*$/, '');
      return path.startsWith(pattern);
    });

  it('never denies reads inside the runner checkout, and still denies /proc and /etc', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deps-flags-'));
    const facts = join(dir, 'facts.json');
    writeFileSync(
      facts,
      JSON.stringify({ meta: { title: 't', headSha: 'h' }, facts: { updates: [] } }),
    );
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ diffs: [], transitiveNotReviewed: 0 }));
    // Step outputs go to $GITHUB_OUTPUT, as in the real workflow. (Capturing stdout
    // instead only worked locally: Actions sets GITHUB_OUTPUT for every job.)
    const outputFile = join(dir, 'github-output');
    writeFileSync(outputFile, '');
    vi.stubEnv('GITHUB_OUTPUT', outputFile);
    let out = '';
    try {
      await cli.commands.prompt({ pr: '7', facts, diffs: dir });
      out = readFileSync(outputFile, 'utf8');
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
    const args = out.slice(out.indexOf('claude_args<<'));
    const list = (flag: string) =>
      (args.match(new RegExp(`--${flag} "([^"]*)"`))?.[1] ?? '').split(',').filter(Boolean);
    const disallowed = list('disallowedTools');
    expect(disallowed.length).toBeGreaterThan(0);
    expect(denies(disallowed, WORKSPACE_FILE)).toBe(false);
    expect(
      denies(disallowed, '/home/runner/work/gleanary/gleanary/.deps-agent-diffs/zod@4.6.7.diff'),
    ).toBe(false);
    expect(denies(disallowed, '/proc/self/environ')).toBe(true);
    expect(denies(disallowed, '/etc/passwd')).toBe(true);
    expect(list('allowedTools')).toContain('Read(./**)');
  });
});

describe('command', () => {
  const run = (body: string, commenter = 'owner') => {
    Object.assign(process.env, { PR: String(PR), COMMENTER: commenter, COMMENT_BODY: body });
    return cli.commands.command();
  };

  const evaluated = () =>
    cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: assessed('escalate'),
      slot: { free: true },
    });
  const overrideComments = () =>
    state.comments.filter((c) => c.body.includes('deps-agent:override'));

  it('approves exactly the last evaluated state, starts a run, and never merges itself', async () => {
    await evaluated(); // escalates on the verdict
    const writesBefore = state.writes.length;
    await run('/deps merge looks fine');
    expect(overrideComments()).toHaveLength(1);
    expect(overrideComments()[0]?.body).toContain('`verdict`');
    expect(state.dispatches).toHaveLength(1);
    expect(merges()).toHaveLength(0);
    // The command only appended the override comment: the record is left to `act`.
    expect(state.writes.slice(writesBefore).every((w) => w.method === 'POST')).toBe(true);
  });

  it('pings again when a waived rule fails for a new reason', async () => {
    const withFinding = (finding: string) => {
      const a = assessed('escalate');
      a.assessment.codeReview = { coverage: 'full', suspicious: [{ file: 'index.js', finding }] };
      return a;
    };
    await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: withFinding('finding A'),
      slot: { free: true },
    });
    expect(pings()).toHaveLength(1);
    await run('/deps merge'); // waives codeReview (finding A) and verdict
    expect(overrideComments()).toHaveLength(1);
    // /deps recheck: same lockfile, the review now reports finding B.
    const { outcome } = await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: withFinding('finding B'),
      slot: { free: true },
    });
    expect(outcome).toBe('escalate');
    expect(pings()).toHaveLength(2);
  });

  it('does not waive what was still pending: a later suspicious review escalates', async () => {
    // First evaluation before the review: verdict and codeReview are pending, nothing fails.
    await cli.evaluatePr(PR, { main: healthy, now: NOW, slot: { free: true } });
    await run('/deps merge');
    expect(overrideComments()).toHaveLength(0);
    expect(state.comments.at(-1)?.body).toContain('Nothing is failing yet');

    // Then the assessment arrives on the same lockfile and flags suspicious code.
    const flagged = assessed('escalate');
    flagged.assessment.codeReview = {
      coverage: 'full',
      suspicious: [{ file: 'install.js', finding: 'downloads and runs a remote script' }],
    };
    const { outcome } = await cli.evaluatePr(PR, {
      main: healthy,
      now: NOW,
      assessment: flagged,
      slot: { free: true },
    });
    expect(outcome).toBe('escalate');
    expect(merges()).toHaveLength(0);
  });

  it('refuses to approve when the PR moved since the last evaluation', async () => {
    await evaluated();
    state.headSha = 'head2'; // Dependabot pushed a newer version after the escalation
    await run('/deps merge');
    expect(overrideComments()).toHaveLength(0);
    expect(state.comments.at(-1)?.body).toContain('changed since deps-agent last evaluated it');
    expect(state.dispatches).toHaveLength(1);
  });

  it('ignores commands from anyone but the owner', async () => {
    await run('/deps merge', 'mallory');
    expect(state.writes).toEqual([]);
    expect(state.dispatches).toEqual([]);
  });
});

describe('tenth review: published-code review', () => {
  const withDir = async (run: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'deps-diffs-'));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const writeFacts = (dir: string) => {
    const facts = join(dir, 'facts.json');
    writeFileSync(
      facts,
      JSON.stringify({
        meta: { headSha: 'h' },
        facts: {
          updates: [{ name: 'zod', type: 'direct:production', from: '4.4.3', to: '4.6.7' }],
          checks: [],
          lock: { changed: [{ name: 'zod', from: '4.4.3', to: '4.6.7', installScript: false }] },
        },
      }),
    );
    return facts;
  };

  it('shows code under test/docs folders, and lists binaries it cannot review', async () => {
    state.npmDiffFiles = ['lib/tests/x.js', 'README.md', 'prebuilt/zod.node', 'index.js'];
    await withDir(async (dir) => {
      const out = join(dir, 'diffs');
      await cli.commands['package-diffs']({ facts: writeFacts(dir), out });
      expect(state.npmDiffs[0]).toEqual(expect.arrayContaining(['lib/tests/x.js', 'index.js']));
      expect(state.npmDiffs[0]).not.toContain('README.md');
      const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
      expect(index.diffs[0].unreviewable).toEqual(['prebuilt/zod.node']);
    });
  });

  it('records the code review as partial when files could not be reviewed', async () => {
    await withDir(async (dir) => {
      const diffs = join(dir, 'diffs');
      const out = join(dir, 'assessment.json');
      mkdirSync(diffs);
      const index = {
        diffs: [{ name: 'zod', unreviewable: ['prebuilt/zod.node'] }],
        transitiveNotReviewed: 0,
      };
      writeFileSync(join(diffs, 'index.json'), JSON.stringify(index));
      vi.stubEnv(
        'ASSESSMENT',
        JSON.stringify({ verdict: 'merge', codeReview: { coverage: 'full', suspicious: [] } }),
      );
      try {
        await cli.commands['save-assessment']({ pr: '7', facts: writeFacts(dir), out, diffs });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(JSON.parse(readFileSync(out, 'utf8')).assessment.codeReview.coverage).toBe('partial');
    });
  });
});
