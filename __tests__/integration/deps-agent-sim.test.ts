/**
 * Run-sequence simulator for deps-agent (docs/deps/invariants.md, ADR-011). Each scenario
 * scripts a world over several scheduled runs; after every run the run properties P1 to P6
 * are checked, whatever the scenario. A property the current code breaks is an `it.skip`
 * naming its TECH_DEBT.md entry; the refactor phase that fixes it turns it on.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffLockfiles, diffTargets } from '../../.github/deps-agent/gate.mjs';
import { decodeRecord } from '../../.github/deps-agent/record.mjs';
import {
  BOT,
  OWNER,
  REPO,
  createWorld,
  escalateVerdict,
  exec,
  mainGoesGreen,
  openPr,
  ownerComment,
  pushHead,
  rebaseWith,
  lockEntry,
  registryFetch,
  type Pr,
  type World,
} from './deps-agent-world';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

type Cli = typeof import('../../.github/deps-agent/cli.mjs');
let cli: Cli;
let world: World;
let scratch: string;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface PrRun {
  outcome: string | null;
  pings: string[];
  rebaseRequested: boolean;
}
interface RunLog {
  mode: string;
  merges: number;
  prs: Map<number, PrRun>;
  writes: World['writes'];
  git: string[][];
  refusedSaves: number[];
  missingFromReview: string[];
}
let history: RunLog[] = [];

const recordOf = (pr: Pr) =>
  decodeRecord(
    pr.comments.find((c) => c.user.login === BOT && c.body.includes('deps-agent:record'))?.body ??
      '',
  ) as {
    outcome?: string;
  } | null;
const isPing = (body: string) => body.startsWith(`@${OWNER} `);

/** Capture what a subcommand writes to stdout (`facts` prints its JSON). */
async function stdoutOf(run: () => Promise<void>): Promise<string> {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return out;
}

/** One scheduled workflow run: plan, assess every queued PR, act. Then check P1 to P6. */
async function run(): Promise<RunLog> {
  vi.setSystemTime(world.now);
  process.env.MODE = world.mode;
  cli.clearRunCaches();
  const writesBefore = world.writes.length;
  const gitBefore = world.git.length;
  const savesBefore = world.refusedSaves.length;
  const firstId = world.nextId; // ids only grow: anything from here on was posted by this run
  const dir = mkdtempSync(join(scratch, 'run-'));
  const missingFromReview: string[] = [];

  // plan
  const outFile = join(dir, 'github-output');
  writeFileSync(outFile, '');
  vi.stubEnv('GITHUB_OUTPUT', outFile);
  try {
    await cli.commands.plan();
  } finally {
    vi.unstubAllEnvs();
  }
  const queue = JSON.parse(readFileSync(outFile, 'utf8').split('\n')[1] ?? '[]') as number[];

  // assess (the matrix), with package-diffs as in the workflow
  const artifacts = join(dir, 'assessments');
  mkdirSync(artifacts);
  for (const n of queue) {
    try {
      await assessJob(n, dir, artifacts, missingFromReview);
    } catch (err) {
      // As in the workflow's matrix, a failed assess job only loses that PR's artifact. A
      // routing gap in the fake world is a test bug, never a simulated failure.
      if (String((err as Error).message).startsWith('world:')) throw err;
    }
  }

  // act
  await cli.commands.act({ assessments: artifacts });

  const writes = world.writes.slice(writesBefore);
  const prs = new Map<number, PrRun>();
  for (const pr of world.prs) {
    const posted = pr.comments.filter((c) => c.id >= firstId && c.user.login === BOT);
    prs.set(pr.number, {
      outcome: recordOf(pr)?.outcome ?? null,
      pings: posted.filter((c) => isPing(c.body)).map((c) => c.body),
      rebaseRequested: posted.some((c) => c.body === '@dependabot rebase'),
    });
  }
  const log: RunLog = {
    mode: world.mode,
    merges: writes.filter((w) => w.method === 'PUT' && w.path.endsWith('/merge')).length,
    prs,
    writes,
    git: world.git.slice(gitBefore),
    refusedSaves: world.refusedSaves.slice(savesBefore),
    missingFromReview,
  };
  checkRunProperties(log);
  history.push(log);
  return log;
}

/** One assess matrix job, step by step as in deps-agent.yml. */
async function assessJob(n: number, dir: string, artifacts: string, missingFromReview: string[]) {
  const factsFile = join(dir, `facts-${n}.json`);
  writeFileSync(factsFile, await stdoutOf(() => cli.commands.facts({ pr: String(n) })));
  const diffs = join(dir, `diffs-${n}`);
  await cli.commands['package-diffs']({ facts: factsFile, out: diffs });
  missingFromReview.push(...unreviewedSpecs(factsFile, diffs));
  const promptOut = join(dir, `prompt-${n}`);
  writeFileSync(promptOut, '');
  vi.stubEnv('GITHUB_OUTPUT', promptOut);
  try {
    await cli.commands.prompt({ pr: String(n), facts: factsFile, diffs });
  } finally {
    vi.unstubAllEnvs();
  }
  const output = world.assess(world.prs.find((p) => p.number === n)!);
  if (output === 'fail') throw new Error('the model returned no valid assessment');
  vi.stubEnv('ASSESSMENT', JSON.stringify(output));
  try {
    await cli.commands['save-assessment']({
      pr: String(n),
      facts: factsFile,
      out: join(artifacts, `assessment-${n}.json`),
      diffs,
    });
  } finally {
    vi.unstubAllEnvs();
  }
}

/** P4 input: introduced versions that got neither a diff nor a place in the not-reviewed count. */
function unreviewedSpecs(factsFile: string, diffsDir: string): string[] {
  const { facts } = JSON.parse(readFileSync(factsFile, 'utf8'));
  const index = JSON.parse(readFileSync(join(diffsDir, 'index.json'), 'utf8'));
  const diffed = new Set(index.diffs.map((d: { name: string; to: string }) => `${d.name}@${d.to}`));
  const missing = facts.lock.changed
    .map((c: { name: string; to: string }) => `${c.name}@${c.to}`)
    .filter((s: string) => !diffed.has(s));
  return missing.length > index.transitiveNotReviewed ? missing : [];
}

/** P1, P2, P3, P4, P6: checked after every run of every scenario. */
function checkRunProperties(log: RunLog): void {
  // P1: at most one merge per run
  expect(log.merges, 'P1: at most one merge per run').toBeLessThanOrEqual(1);
  // P2: shadow mode changes no PR and not main. An allowlist, so a new kind of write is
  // caught too: only the record, pings, labels and issues (freeze, dashboard) are allowed.
  if (log.mode === 'shadow') {
    const allowed = (w: World['writes'][number]) =>
      (/issues\/(\d+\/)?comments(\/\d+)?$/.test(w.path) && w.body.body !== '@dependabot rebase') ||
      /\/labels(\/.+)?$/.test(w.path) ||
      /\/issues(\/\d+)?$/.test(w.path);
    expect(
      log.writes.filter((w) => !allowed(w)),
      'P2: shadow mode wrote to a PR or main',
    ).toEqual([]);
    expect(log.git, 'P2: no git push in shadow mode').toEqual([]);
  }
  for (const [number, now] of log.prs) {
    // P3: never the same ping twice in a row without the PR leaving `escalate` in between
    const previous = lastPing(number); // history does not hold this run yet
    for (const body of now.pings) {
      if (previous && previous.body === body && !previous.leftEscalateSince) {
        throw new Error(`P3: PR #${number} was pinged twice with the same message:\n${body}`);
      }
    }
    // P6: nothing is posted for a PR whose record could not be saved
    if (log.refusedSaves.includes(number)) {
      expect(
        now.pings.length + Number(now.rebaseRequested),
        `P6: PR #${number} posted after a failed save`,
      ).toBe(0);
    }
  }
  // P4: every introduced version is in the review targets (or counted as not reviewed)
  expect(log.missingFromReview, 'P4: introduced versions missing from the review').toEqual([]);
}

function lastPing(number: number): { body: string; leftEscalateSince: boolean } | null {
  let left = false;
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i]!.prs.get(number);
    if (!p) continue;
    if (p.pings.length) return { body: p.pings.at(-1)!, leftEscalateSince: left };
    if (p.outcome !== 'escalate') left = true;
  }
  return null;
}

/** Advance the clock. */
const later = (ms: number) => {
  world.now = new Date(world.now.getTime() + ms);
};
const pingsOf = (pr: Pr) => history.flatMap((h) => h.prs.get(pr.number)?.pings ?? []);
const rebasesOf = (pr: Pr) => history.filter((h) => h.prs.get(pr.number)?.rebaseRequested).length;

/** The `/deps <verb>` command job, as the workflow runs it for an owner comment. */
async function command(pr: Pr, body: string): Promise<void> {
  ownerComment(world, pr, body);
  vi.setSystemTime(world.now);
  vi.stubEnv('PR', String(pr.number));
  vi.stubEnv('COMMENTER', OWNER);
  vi.stubEnv('COMMENT_BODY', body);
  try {
    await cli.commands.command();
  } finally {
    vi.unstubAllEnvs();
  }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  Object.assign(process.env, {
    GITHUB_REPOSITORY: REPO,
    MODE: 'merge',
    OWNER_LOGIN: OWNER,
    APP_SLUG: 'deps-agent',
    RUN_URL: 'https://example.test/run',
  });
  vi.mocked(execFileSync).mockImplementation(((
    cmd: string,
    args: string[],
    opts?: { input?: string },
  ) => exec(world, cmd, args, opts)) as unknown as typeof execFileSync);
  // Stub after the global MSW setup patches fetch; the registry is the only fetch target.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => registryFetch(world, url)),
  );
  cli = await import('../../.github/deps-agent/cli.mjs');
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  world = createWorld();
  history = [];
  scratch = mkdtempSync(join(tmpdir(), 'deps-sim-'));
  return () => rmSync(scratch, { recursive: true, force: true });
});

const zod = { name: 'zod', from: '4.4.3', to: '4.6.7' };
const pino = { name: 'pino', from: '10.3.1', to: '10.4.0' };

describe('merging', () => {
  it('merges a clean PR in one run', async () => {
    const pr = openPr(world, 7, zod);
    await run();
    expect(pr.merged).toBe(true);
  });

  it('merges two clean PRs one at a time, each after main is healthy again', async () => {
    const a = openPr(world, 7, zod);
    const b = openPr(world, 8, pino);
    await run();
    expect([a.merged, b.merged]).toEqual([true, false]);
    later(HOUR); // main's CI and Deploy for the merge still running
    await run();
    expect(b.merged).toBe(false);
    mainGoesGreen(world);
    later(HOUR);
    await run(); // b is behind main: deps-agent asks Dependabot to rebase it
    expect(rebasesOf(b)).toBe(1);
    pushHead(world, b);
    later(HOUR);
    await run();
    expect(b.merged).toBe(true);
  });

  it('merges at most one PR per run, even when GitHub still shows the next one as fresh', async () => {
    world.compareLags = true;
    const a = openPr(world, 7, zod);
    const b = openPr(world, 8, pino);
    await run(); // P1 is checked inside run()
    expect([a.merged, b.merged]).toEqual([true, false]);
  });

  it('changes nothing in shadow mode', async () => {
    world.mode = 'shadow';
    const clean = openPr(world, 7, zod);
    const behind = openPr(world, 8, pino);
    behind.behindMain = true;
    await run(); // P2 is checked inside run()
    later(DAY);
    await run();
    expect([clean.merged, behind.merged]).toEqual([false, false]);
    expect([recordOf(clean)?.outcome, recordOf(behind)?.outcome]).toEqual(['would-merge', 'wait']);
  });
});

describe('escalation', () => {
  it('pings once, and not again when Dependabot rebases with the same versions', async () => {
    world.assess = () => escalateVerdict();
    const pr = openPr(world, 7, zod);
    await run();
    expect(pingsOf(pr)).toHaveLength(1);
    pushHead(world, pr);
    later(HOUR);
    await run();
    later(HOUR);
    await run();
    expect(pingsOf(pr)).toHaveLength(1);
  });

  it('does not ask Dependabot to rebase an escalated PR', async () => {
    world.assess = () => escalateVerdict();
    const pr = openPr(world, 7, zod);
    pr.behindMain = true;
    await run();
    later(DAY);
    await run();
    expect(rebasesOf(pr)).toBe(0);
  });

  it('merges after /deps merge, but asks again once a rebase changes the lockfile', async () => {
    world.assess = () => escalateVerdict();
    const pr = openPr(world, 7, zod);
    await run();
    // A rebase re-resolves the lockfile: a new transitive version the owner never saw.
    rebaseWith(world, pr, { 'node_modules/ms': lockEntry('ms', '2.1.4') });
    await command(pr, '/deps merge');
    later(HOUR);
    await run();
    expect(pr.merged).toBe(false); // the override was refused: the PR changed since the record
    later(HOUR);
    await run(); // the record now shows the new state
    await command(pr, '/deps merge');
    later(HOUR);
    await run();
    expect(pr.merged).toBe(true);
  });
});

describe('waiting', () => {
  it('waits out a registry outage, then pings once after 48 h', async () => {
    const pr = openPr(world, 7, zod);
    world.registryDown = true;
    for (let i = 0; i < 4; i++) {
      await run();
      later(12 * HOUR);
    }
    expect(pingsOf(pr)).toHaveLength(0);
    for (let i = 0; i < 3; i++) {
      await run();
      later(12 * HOUR);
    }
    expect(pingsOf(pr)).toHaveLength(1);
  });

  it('waits for a young dependency version to age, then merges', async () => {
    const pr = openPr(world, 7, {
      ...zod,
      extraHead: { 'node_modules/ms': lockEntry('ms', '2.1.4') },
    });
    world.publishedAt['ms@2.1.4'] = world.now.toISOString();
    await run();
    expect(recordOf(pr)?.outcome).toBe('wait');
    later(8 * DAY);
    await run();
    expect(pr.merged).toBe(true);
  });

  it('escalates a PR Dependabot never rebases, 24 h after asking', async () => {
    const pr = openPr(world, 7, zod);
    pr.behindMain = true;
    await run();
    expect(rebasesOf(pr)).toBe(1);
    later(25 * HOUR);
    await run();
    expect(pingsOf(pr)).toHaveLength(1);
    expect(pingsOf(pr)[0]).toContain('has not rebased');
  });

  it('waits on a cancelled CI run on main instead of reverting the merge', async () => {
    const a = openPr(world, 7, zod);
    await run();
    expect(a.merged).toBe(true);
    world.main.ci = [
      { status: 'completed', conclusion: 'cancelled', updated_at: world.now.toISOString() },
    ];
    later(HOUR);
    await run();
    expect(world.git).toEqual([]); // no revert branch
    expect(world.issues.filter((i) => i.title.startsWith('deps-agent: main'))).toEqual([]);
  });

  it('posts nothing when the record cannot be saved', async () => {
    world.assess = () => escalateVerdict();
    world.recordSaveFails = true;
    const pr = openPr(world, 7, zod);
    await run();
    later(HOUR);
    await run();
    expect(world.refusedSaves.length).toBeGreaterThan(0);
    expect(pingsOf(pr)).toHaveLength(0);
  });
});

/**
 * P5: a PR left in an unchanged world merges or escalates within 15 days. Each case freezes
 * the world in one blocking state and runs once a day.
 */
describe('P5: no endless wait', () => {
  const settles = async (pr: Pr) => {
    for (let day = 0; day <= 15; day++) {
      await run();
      if (pr.merged || recordOf(pr)?.outcome === 'escalate') return;
      later(DAY);
    }
    throw new Error(`P5: PR #${pr.number} still "${recordOf(pr)?.outcome}" after 15 days`);
  };

  it('a PR behind main that Dependabot never rebases', async () => {
    const pr = openPr(world, 7, zod);
    pr.behindMain = true;
    await settles(pr);
  });

  it('an npm registry that stays down', async () => {
    const pr = openPr(world, 7, zod);
    world.registryDown = true;
    await settles(pr);
  });

  it('a cancelled check nobody re-runs', async () => {
    const pr = openPr(world, 7, zod);
    pr.checks[0] = { ...pr.checks[0]!, conclusion: 'cancelled' };
    await settles(pr);
  });

  // TECH_DEBT.md: "a failed assess job ... never escalate". Phase 3 (waits.mjs) turns it on.
  it.skip('an assess job that always fails', async () => {
    world.assess = () => 'fail';
    const pr = openPr(world, 7, zod);
    await settles(pr);
  });

  // TECH_DEBT.md: "a required check stuck in progress waits forever". Phase 3 turns it on.
  it.skip('a required check stuck in progress', async () => {
    const pr = openPr(world, 7, zod);
    pr.checks[0] = { ...pr.checks[0]!, status: 'in_progress', conclusion: null };
    await settles(pr);
  });
});

describe('known gaps (skipped until their phase)', () => {
  // TECH_DEBT.md: "escalatedKey is never cleared". Phase 4 (identity) turns it on.
  it.skip('pings again when a failure comes back after the PR recovered', async () => {
    const pr = openPr(world, 7, zod);
    pr.checks[0] = { ...pr.checks[0]!, conclusion: 'failure' };
    await run();
    expect(pingsOf(pr)).toHaveLength(1);
    pr.checks[0] = { ...pr.checks[0]!, conclusion: 'success' };
    world.mode = 'shadow'; // recovered: would merge, nothing else changes
    later(HOUR);
    await run();
    pr.checks[0] = { ...pr.checks[0]!, conclusion: 'failure' };
    later(HOUR);
    await run();
    expect(pingsOf(pr)).toHaveLength(2);
  });

  // TECH_DEBT.md: "a declared update with no previous version at its key". Phase 2 turns it on.
  it.skip('reviews a declared package that was only nested before (P4)', async () => {
    const pr = openPr(world, 7, zod);
    // main had zod only nested; the PR hoists the new version
    world.trees[pr.baseSha]!.lock.packages = {
      '': {},
      'node_modules/x/node_modules/zod': lockEntry('zod', '4.4.3'),
    };
    await run(); // P4 fails inside run(): zod@4.6.7 is neither diffed nor counted
  });

  // TECH_DEBT.md: "an outage pending on the run where the aging versions mature leaves
  // cooldownWaitSince set". Phase 3 turns it on.
  it.skip('does not count a later young version as overdue after an outage', async () => {
    const pr = openPr(world, 7, {
      ...zod,
      extraHead: { 'node_modules/ms': lockEntry('ms', '2.1.4') },
    });
    world.publishedAt['ms@2.1.4'] = world.now.toISOString();
    await run(); // waiting for ms to age
    later(8 * DAY);
    world.registryDown = true;
    await run(); // ms has aged, but the registry is down on this run
    world.registryDown = false;
    // a rebase brings a new young version 13 days into the wait
    later(5 * DAY);
    rebaseWith(world, pr, { 'node_modules/debug': lockEntry('debug', '4.4.9') });
    world.publishedAt['debug@4.4.9'] = world.now.toISOString();
    later(2 * DAY); // 2 days old: it should wait, not be overdue
    await run();
    expect(recordOf(pr)?.outcome).toBe('wait');
  });
});

/** P8: every lockfile pair from past Dependabot PRs yields its reviewed change set. */
describe('P8: lockfile corpus', () => {
  const dir = join(__dirname, '../mocks/fixtures/deps-lockfiles');
  const fixtures = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const cases = fixtures.map((x) => [x.pr, x]);

  it.each(cases)('PR #%i yields its expected change set', (_n, x) => {
    const lock = diffLockfiles(x.base, x.head);
    expect({
      introduced: lock.changed.map(
        (c: { name: string; from: string | null; to: string; installScript: boolean }) =>
          `${c.name} ${c.from ?? 'new'}→${c.to}${c.installScript ? ' [install script]' : ''}`,
      ),
      added: lock.added,
      newInstallScripts: lock.newInstallScripts,
      foreignSources: lock.foreignSources,
    }).toEqual(x.expected);
  });

  it.each(cases)('PR #%i offers every introduced version for review (P4)', (_n, x) => {
    const version = (lock: { packages: Record<string, { version?: string }> }, name: string) =>
      lock.packages[`node_modules/${name}`]?.version ?? null;
    const updates = x.declared.map((u: { name: string }) => ({
      ...u,
      from: version(x.base, u.name),
      to: version(x.head, u.name),
    }));
    const lock = diffLockfiles(x.base, x.head);
    const { direct, transitive } = diffTargets({ updates, lock });
    const offered = new Set(
      [...direct, ...transitive].map(
        (t: { name: string; to: string | null }) => `${t.name}@${t.to}`,
      ),
    );
    expect(
      lock.changed
        .map((c: { name: string; to: string }) => `${c.name}@${c.to}`)
        .filter((s: string) => !offered.has(s)),
    ).toEqual([]);
  });
});
