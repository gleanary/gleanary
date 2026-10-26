// Decision records and comment rendering for the Dependabot agent.
//
// Each Dependabot PR carries ONE sticky comment by the agent's GitHub App: a
// human-readable decision record plus a base64 JSON payload the next run reads
// back. Only comments authored by the app are trusted (see cli.mjs), so a
// forged record in a public-repo comment is ignored.

export const MARKER = '<!-- deps-agent:record -->';
const DATA = /<!-- deps-agent:data ([A-Za-z0-9+/=]+) -->/;
// Owner overrides are separate, append-only App comments, never fields of the sticky
// record: `/deps merge` and the scheduled run can then never overwrite each other.
const OVERRIDE = /<!-- deps-agent:override ([A-Za-z0-9+/=]+) -->/;
// A `/deps recheck` request, also an append-only App comment: it survives even if the run
// it dispatched is cancelled while queued.
const RECHECK = '<!-- deps-agent:recheck -->';
// GitHub rejects comments over 65,536 characters; stay well below it.
const MAX_COMMENT = 60_000;
const HISTORY_LIMIT = 20;

const ICON = { pass: '✅', fail: '❌', pending: '⏳' };
const OUTCOME_LABEL = {
  merge: '🚀 merged',
  'would-merge': '👀 would merge (shadow mode)',
  queued: '⏭️ mergeable, queued behind another merge',
  wait: '⏳ waiting',
  escalate: '🙋 needs a human',
  held: '⏸️ on hold',
};

/**
 * Neutralize untrusted text (LLM output derived from changelogs) before it lands
 * in a comment: HTML escaped, no @-mentions, no markdown links or images, bounded length.
 * @param {unknown} text - text to embed
 * @param {number} [max] - maximum length
 * @returns {string} safe markdown text
 */
export function neutralize(text, max = 1500) {
  const s = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b')
    // No live links or images (tracking pixels) from changelog text in the App's comments.
    .replace(/[[\]()]/g, '\\$&');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** neutralize() for a markdown table cell: also keeps `|` and newlines from breaking the row. */
const cell = (text, max) => neutralize(text, max).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Read the JSON payload back from a record comment body.
 * @param {string} body - comment body
 * @returns {object|null} the record, or null when absent or corrupt
 */
export function decodeRecord(body) {
  const m = body.match(DATA);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * The one trust rule for agent state on a public repo: only comments written by our App
 * count (anyone can paste a record or override marker into their own comment).
 * @param {{user: {login: string, type: string}}} c - an issue comment
 * @param {string} bot - the App's bot login
 * @returns {boolean} whether the App wrote it
 */
export function fromApp(c, bot) {
  return c.user.login === bot && c.user.type === 'Bot';
}

/**
 * An owner override approves one evaluated state, not a package name: the declared
 * versions, the exact set of introduced lockfile versions, and the soft rules that were
 * failing when the owner looked. Anything that changes after that (a rebase that pulls new
 * transitive versions, a soft rule that starts failing) is not covered.
 * Each waived rule keeps its waiverKey (a hash of the full failure detail, gate.mjs), plus a
 * clipped detail for display: the same rule failing for another reason later (e.g. a
 * re-assessment flagging different code) is not covered.
 * @typedef {{versions: string, lock: string, waive: {id: string, key: string, detail: string}[], by: string}} Override
 */

/**
 * Render the comment that records an owner's `/deps merge` override.
 * @param {Override} override - what was approved
 * @param {string} reason - optional text after the command
 * @returns {string} comment body
 */
export function renderOverride(override, reason) {
  const encoded = Buffer.from(JSON.stringify(override)).toString('base64');
  const waived = override.waive.length
    ? override.waive.map((w) => `\`${w.id}\` (${neutralize(w.detail, 120)})`).join(', ')
    : 'none';
  return [
    `Override recorded by ${neutralize(override.by, 60)} for \`${neutralize(override.versions, 300)}\`, waiving: ${waived}.`,
    'It covers this exact lockfile and these exact failures: if a rebase brings in different dependency versions, another gate starts failing, or a waived gate fails for a different reason, deps-agent asks again. Hard gates always apply. A run has been started to act on it.',
    reason.trim() ? `\n> ${neutralize(reason, 300)}` : '',
    `<!-- deps-agent:override ${encoded} -->`,
  ].join('\n');
}

/**
 * Overrides from comments written by our App only (an override marker pasted by anyone
 * else is ignored), oldest first.
 * @param {{body: string, user: {login: string, type: string}}[]} comments - PR comments
 * @param {string} bot - the App's bot login
 * @returns {Override[]} recorded overrides
 */
export function overridesFrom(comments, bot) {
  const overrides = [];
  for (const c of comments) {
    if (!fromApp(c, bot)) continue;
    const m = c.body.match(OVERRIDE);
    if (!m) continue;
    try {
      const o = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
      const waiveOk = Array.isArray(o.waive) && o.waive.every((w) => typeof w?.id === 'string' && typeof w?.key === 'string');
      if (typeof o.versions === 'string' && typeof o.lock === 'string' && waiveOk) overrides.push(o);
    } catch {
      // corrupt marker: ignore
    }
  }
  return overrides;
}

/**
 * Bound an assessment before it is stored, guided by assessment.schema.json: every string
 * is clipped to its `x-maxLength`, every list to its `x-maxItems`, and keys the schema does
 * not define are dropped. The schema is the single source of the assessment's shape and
 * limits; the model's output is untrusted and unbounded, and the record must fit a comment.
 * @param {unknown} value - assessment (or part of it)
 * @param {object} schema - the matching (sub)schema
 * @returns {unknown} the clamped value
 */
export function clampAssessment(value, schema) {
  if (!schema) return value;
  if (typeof value === 'string') return schema['x-maxLength'] ? value.slice(0, schema['x-maxLength']) : value;
  if (Array.isArray(value)) {
    return value.slice(0, schema['x-maxItems'] ?? value.length).map((v) => clampAssessment(v, schema.items));
  }
  if (value && typeof value === 'object') {
    const props = schema.properties ?? {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k in props)
        .map(([k, v]) => [k, clampAssessment(v, props[k])]),
    );
  }
  return value;
}

/**
 * Render the comment that records a `/deps recheck` request.
 * @param {string} by - owner login
 * @returns {string} comment body
 */
export function renderRecheck(by) {
  return `Re-assessment requested by ${neutralize(by, 60)}; a run has been started.\n${RECHECK}`;
}

/**
 * When the latest `/deps recheck` was requested (App comments only), or '' if never.
 * @param {{body: string, created_at?: string, user: {login: string, type: string}}[]} comments
 * @param {string} bot - the App's bot login
 * @returns {string} ISO timestamp, comparable as a string
 */
export function latestRecheckAt(comments, bot) {
  return comments
    .filter((c) => fromApp(c, bot) && c.body.includes(RECHECK))
    .map((c) => c.created_at ?? '')
    .reduce((a, b) => (b > a ? b : a), '');
}

/**
 * Append a history entry when the outcome, SHA or decider changed.
 * @param {object} record - record to mutate
 * @param {{at: string, sha: string, outcome: string, by: string, note?: string}} entry
 * @returns {object} the same record
 */
export function pushHistory(record, entry) {
  const history = record.history ?? [];
  const last = history[history.length - 1];
  if (!last || last.sha !== entry.sha || last.outcome !== entry.outcome || last.by !== entry.by) {
    history.push(entry);
  }
  record.history = history.slice(-HISTORY_LIMIT);
  return record;
}

/**
 * Render the sticky decision-record comment.
 * @param {object} record - persisted record (headSha, outcome, rules, assessment, history)
 * @param {{mode: string, runUrl: string}} ctx - run context
 * @returns {string} comment body
 */
export function renderRecord(record, ctx) {
  // Progressively smaller versions until the comment fits. Only display detail is lost:
  // trimmed rule details in the payload can at worst stop a waiver matching (re-escalate).
  for (const trimmed of fitSteps(record)) {
    const body = renderRecordBody(trimmed, ctx);
    if (body.length <= MAX_COMMENT) return body;
  }
  throw new Error(`decision record for PR #${record.pr} does not fit in a comment`);
}

function* fitSteps(record) {
  // The assessment is already bounded when stored (clampAssessment); what can still grow is
  // the history (notes) and rule details (e.g. long version lists).
  yield record;
  const r = {
    ...record,
    history: (record.history ?? []).slice(-5).map((h) => ({ ...h, ...(h.note ? { note: String(h.note).slice(0, 200) } : {}) })),
  };
  yield r;
  yield { ...r, rules: (record.rules ?? []).map((x) => ({ ...x, detail: String(x.detail).slice(0, 300) })) };
}

function renderRecordBody(record, ctx) {
  const a = record.assessmentStale ? null : record.assessment;
  const lines = [
    MARKER,
    `### deps-agent decision: ${OUTCOME_LABEL[record.outcome] ?? record.outcome}`,
    '',
    `Head \`${record.headSha.slice(0, 7)}\` · mode \`${ctx.mode}\` · [last run](${ctx.runUrl}) · updated ${record.updatedAt}`,
    '',
    '| Gate | Kind | Result | Detail |',
    '| --- | --- | --- | --- |',
    ...record.rules.map(
      (r) => `| ${r.id} | ${r.kind} | ${ICON[r.status]} | ${cell(r.detail, 300)} |`,
    ),
  ];
  if (a) {
    lines.push('', `**Assessment** (\`${a.verdict}\`): ${neutralize(a.summary)}`);
    for (const b of a.breakingChangesAffectingUs ?? []) {
      lines.push(`- ⚠️ ${neutralize(b.change, 300)} → ${neutralize(b.usage, 300)}`);
    }
    if (a.ciRead) lines.push(`- CI: ${neutralize(a.ciRead, 500)}`);
    if (a.injectionSuspected) lines.push('- 🚩 changelog/PR text looked like instructions to the agent');
  } else if (record.assessmentStale) {
    lines.push('', '**Assessment:** outdated (the PR changed since it was made); a fresh one is pending.');
  }
  lines.push(
    '',
    '<details><summary>Decision history</summary>',
    '',
    ...(record.history ?? []).map(
      (h) => `- ${h.at} \`${h.sha.slice(0, 7)}\` ${h.outcome} by ${h.by}${h.note ? `: ${neutralize(h.note, 200)}` : ''}`,
    ),
    '',
    '</details>',
    '',
    `<!-- deps-agent:data ${Buffer.from(JSON.stringify(record)).toString('base64')} -->`,
  );
  return lines.join('\n');
}

/**
 * Render the one-off escalation comment (a new comment, because GitHub only
 * notifies @-mentions on creation, not on edits of the sticky record).
 * @param {object} record - the record being escalated
 * @param {string} owner - login to mention
 * @param {string} [note] - extra reason shown first (e.g. a rebase that never happened)
 * @returns {string} comment body
 */
export function renderEscalation(record, owner, note = '') {
  const failing = record.rules.filter((r) => r.status === 'fail');
  const hard = failing.filter((r) => r.kind === 'hard');
  const a = record.assessment;
  const lines = [
    `@${owner} deps-agent needs a decision on \`${record.headSha.slice(0, 7)}\`.`,
    ...(note ? ['', `**Why now:** ${neutralize(note, 500)}`] : []),
    // A time-based escalation (stuck rebase, long cooldown wait) can come with no failing gate.
    ...(failing.length
      ? ['', '**Blocking gates:**', ...failing.map((r) => `- ${r.id} (${r.kind}): ${neutralize(r.detail, 300)}`)]
      : []),
  ];
  if (a?.escalation) {
    lines.push(
      '',
      `**Question:** ${neutralize(a.escalation.question, 500)}`,
      `**Recommendation:** ${neutralize(a.escalation.recommendation, 500)}`,
      ...(a.escalation.options ?? []).map((o) => `- ${neutralize(o, 200)}`),
    );
  }
  lines.push(
    '',
    hard.length
      ? '`/deps merge` cannot override hard gates; fix the cause or close the PR.'
      : 'Reply `/deps merge` to waive the failing soft gates for this exact lockfile (a rebase that changes it asks again),',
    '`/deps hold <reason>` to park it, `/deps recheck` to re-assess, or `@dependabot ignore this major version`.',
    'Guide: [reading an escalation](../blob/main/docs/deps/README.md#reading-an-escalation).',
  );
  return lines.join('\n');
}

/**
 * Render the dashboard issue body.
 * @param {{number: number, title: string, outcome: string, blocking: string}[]} rows
 * @param {{state: string, detail: string, sha: string}} main - main state
 * @param {{mode: string, runUrl: string, at: string}} ctx - run context
 * @returns {string} issue body
 */
export function renderDashboard(rows, main, ctx) {
  return [
    `Maintained by deps-agent. Mode \`${ctx.mode}\` · main \`${main.sha.slice(0, 7)}\` is **${main.state}** (${main.detail}) · [last run](${ctx.runUrl}) · ${ctx.at}`,
    '',
    'How this works: [`docs/deps/README.md`](../blob/main/docs/deps/README.md) · skipped versions: [`dependabot.yml`](../blob/main/.github/dependabot.yml) · rules: [`policy.md`](../blob/main/.github/deps-agent/policy.md).',
    '',
    '| PR | Update | Outcome | Blocking |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| #${r.number} | ${cell(r.title, 120)} | ${OUTCOME_LABEL[r.outcome] ?? r.outcome} | ${cell(r.blocking, 200) || '-'} |`,
    ),
  ].join('\n');
}
