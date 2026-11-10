import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import {
  ENRICH_MAX_TOKENS,
  ENRICH_MODE_DEFAULTS,
  ENRICH_PROMPT,
  ENRICH_TOOL,
  ENRICH_TOOL_NAME,
  buildEnrichRequestParams,
  buildEnrichUserMessage,
  computeEnrichBudgetChars,
  enrichTimeoutMs,
  enrichmentResultSchema,
  estimateInputTokens,
  filterEnrichTags,
  formatIndexText,
  formatSummaryMarkdown,
  prepareEnrichRequest,
  selectEnrichContent,
  truncateToBudget,
} from '@/lib/enrichment-core';
import { CHARS_PER_TOKEN, DEFAULT_ENRICH_MODEL, ENRICH_MODEL_IDS } from '@/lib/models';
import { SETTINGS_SCHEMA } from '@/lib/settings-schema';
import { articles } from '@/db/schema';
import { ENRICH_POLICY_SOURCE_TYPES, ENRICH_STATUSES } from '@/types';
import fixture from '../mocks/fixtures/claude-tool-response.json';

const ROOT = path.resolve(__dirname, '..', '..');

/** The validated `record_enrichment` input of the shared fixture. */
function fixturePayload(): Record<string, unknown> {
  const block = fixture.content[0] as { input: Record<string, unknown> };
  return structuredClone(block.input);
}

const baseSummary = {
  bottom_line: 'Unit tests catch regressions cheaply.',
  key_points: ['Pure functions first', 'Integration tests at the seams'],
};

describe('formatSummaryMarkdown', () => {
  it('renders the bottom line bold, the key points as a list, and omits empty optional fields', () => {
    const md = formatSummaryMarkdown(baseSummary, 'en');
    expect(md).toBe(
      '**Unit tests catch regressions cheaply.**\n\n- Pure functions first\n- Integration tests at the seams',
    );
    expect(md).not.toContain("What's new");
    expect(md).not.toContain('Caveats');
    expect(md).not.toContain('Read in full if');
  });

  it('gives each optional field its own paragraph with the exact English labels', () => {
    const md = formatSummaryMarkdown(
      { ...baseSummary, whats_new: 'New A', caveats: 'Limit B', read_in_full_if: 'Case C' },
      'en',
    );
    expect(md).toContain(
      "\n\n**What's new:** New A\n\n**Caveats:** Limit B\n\n**Read in full if:** Case C",
    );
    const html = marked.parse(md) as string;
    expect(html.match(/<p>/g)).toHaveLength(4); // bottom line + three optional paragraphs
  });

  it('uses the French labels with a no-break space before the colon', () => {
    const md = formatSummaryMarkdown(
      { ...baseSummary, whats_new: 'A', caveats: 'B', read_in_full_if: 'C' },
      'fr',
    );
    expect(md).toContain('**Ce qui est nouveau :** A');
    expect(md).toContain('**Limites :** B');
    expect(md).toContain('**À lire en entier si :** C');
  });

  it('falls back to English labels for any other language code', () => {
    const md = formatSummaryMarkdown({ ...baseSummary, caveats: 'B' }, 'de');
    expect(md).toContain('**Caveats:** B');
  });

  it('replaces newlines inside values with a space', () => {
    const md = formatSummaryMarkdown(
      { bottom_line: 'Line one\nline two', key_points: ['Point\n\nbroken', 'Other'] },
      'en',
    );
    expect(md).toBe('**Line one line two**\n\n- Point broken\n- Other');
  });

  it('escapes markdown in values so they render literally', () => {
    const md = formatSummaryMarkdown(
      {
        bottom_line: 'uses **x** and _y_ and `z`',
        key_points: [
          '# not a heading',
          '1. not a list',
          '2) not a list either',
          '- not nested',
          '[a](b)',
          '> quote',
          '~~not struck~~',
        ],
      },
      'en',
    );
    const html = marked.parse(md) as string;
    expect(html).not.toContain('<em>');
    expect(html).not.toContain('<code>');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<ol');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<blockquote');
    expect(html).not.toContain('<del>');
    expect(html).toContain('uses **x** and _y_ and `z`');
    expect(html).toContain('# not a heading');
    expect(html).toContain('1. not a list');
    expect(html).toContain('2) not a list either');
    expect(html).toContain('- not nested');
    expect(html).toContain('[a](b)');
    expect(html).toContain('~~not struck~~');
    expect((html.match(/<ul>/g) ?? []).length).toBe(1);
    expect(html.match(/<li>/g)).toHaveLength(7);
  });
});

describe('selectEnrichContent', () => {
  it('prefers content_markdown and falls through blank markdown to content_text', () => {
    expect(selectEnrichContent({ contentMarkdown: ' # md ', contentText: 'text' })).toBe('# md');
    expect(selectEnrichContent({ contentMarkdown: '', contentText: ' text ' })).toBe('text');
    expect(selectEnrichContent({ contentMarkdown: '  \n', contentText: 'text' })).toBe('text');
    expect(selectEnrichContent({ contentMarkdown: '', contentText: '' })).toBeNull();
    expect(selectEnrichContent({ contentMarkdown: null, contentText: null })).toBeNull();
  });
});

describe('input budget and truncation', () => {
  it('budgets half the context window, capped by the setting, in chars', () => {
    expect(computeEnrichBudgetChars(200_000, 150_000)).toBe(100_000 * CHARS_PER_TOKEN);
    expect(computeEnrichBudgetChars(1_000_000, 150_000)).toBe(150_000 * CHARS_PER_TOKEN);
    expect(computeEnrichBudgetChars(1_000_000, 10_000)).toBe(10_000 * CHARS_PER_TOKEN);
  });

  it('leaves content within budget untouched with full coverage', () => {
    const r = truncateToBudget('short text', 100);
    expect(r).toEqual({ text: 'short text', truncated: false, coveragePct: null });
  });

  it('cuts at the last paragraph break in the final 20% of the budget', () => {
    const para = 'a'.repeat(85);
    const content = `${para}\n\n${'b'.repeat(200)}`;
    const r = truncateToBudget(content, 100);
    expect(r.text).toBe(para);
    expect(r.truncated).toBe(true);
    expect(r.coveragePct).toBe(Math.round((85 / content.length) * 100));
  });

  it('falls back to a line break, then whitespace, then a hard cut', () => {
    const line = `${'a'.repeat(90)}\n${'b'.repeat(200)}`;
    expect(truncateToBudget(line, 100).text).toBe('a'.repeat(90));

    const words = `${'a'.repeat(88)} ${'b'.repeat(200)}`;
    expect(truncateToBudget(words, 100).text).toBe('a'.repeat(88));

    const early = `${'a'.repeat(10)}\n\n${'b'.repeat(300)}`; // break before 80%: ignored
    expect(truncateToBudget(early, 100).text).toHaveLength(100);
  });

  it('keeps about the whole budget for a single 1 MB paragraph', () => {
    const r = truncateToBudget('x'.repeat(1_000_000), 40_000);
    expect(r.text.length).toBe(40_000);
    expect(r.truncated).toBe(true);
    expect(r.coveragePct).toBe(4);
  });

  it('clamps the coverage percentage to 1–99 when truncated', () => {
    const tiny = truncateToBudget('x'.repeat(1_000_000), 100);
    expect(tiny.coveragePct).toBe(1);
    const nearly = truncateToBudget(`${'a'.repeat(999)}\nb`, 1000); // 99.8% kept
    expect(nearly.truncated).toBe(true);
    expect(nearly.coveragePct).toBe(99);
  });
});

describe('buildEnrichUserMessage', () => {
  const base = {
    title: 'T',
    author: null,
    siteName: null,
    sourceType: 'rss_feed' as const,
    language: 'en',
    vocabulary: new Map([['testing', 'Testing']]),
    content: 'Body',
    coveragePct: null,
  };

  it('writes the exact coverage line for full and truncated content', () => {
    expect(buildEnrichUserMessage(base)).toContain('\nCoverage: full\n');
    expect(buildEnrichUserMessage({ ...base, coveragePct: 60 })).toContain(
      '\nCoverage: first ~60% of the document (truncated)\n',
    );
  });

  it('writes the language line with the name for en and fr, and the bare code otherwise', () => {
    expect(buildEnrichUserMessage(base)).toContain('\nSummary language: English (en)\n');
    expect(buildEnrichUserMessage({ ...base, language: 'fr' })).toContain(
      '\nSummary language: French (fr)\n',
    );
    expect(buildEnrichUserMessage({ ...base, language: 'de' })).toContain(
      '\nSummary language: de\n',
    );
  });

  it('includes title, unknown author and site, source type, the stored tag spellings and the content', () => {
    const msg = buildEnrichUserMessage(base);
    expect(msg).toContain('Title: T\n');
    expect(msg).toContain('Author: unknown\n');
    expect(msg).toContain('Site: unknown\n');
    expect(msg).toContain('Source type: rss_feed\n');
    expect(msg).toContain('Existing tags (prefer these when they fit): ["Testing"]');
    expect(msg.endsWith('Article content:\nBody')).toBe(true);
  });
});

describe('request params', () => {
  it('sends disabled thinking, the forced tool choice and the 4096 ceiling for every enrichment model', () => {
    for (const model of ENRICH_MODEL_IDS) {
      const params = buildEnrichRequestParams({ model, userMessage: 'hello' });
      expect(params.model).toBe(model);
      expect(params.thinking).toEqual({ type: 'disabled' });
      expect(params.tool_choice).toEqual({ type: 'tool', name: ENRICH_TOOL_NAME });
      expect(params.tools).toEqual([ENRICH_TOOL]);
      expect(params.max_tokens).toBe(ENRICH_MAX_TOKENS);
      expect(params.system).toBe(ENRICH_PROMPT);
      expect(params.messages).toEqual([{ role: 'user', content: 'hello' }]);
    }
    expect(ENRICH_MAX_TOKENS).toBe(4096);
  });

  it('estimates input tokens from the final message and scales the timeout, capped at 300 s', () => {
    expect(estimateInputTokens('x'.repeat(401))).toBe(101);
    expect(enrichTimeoutMs(0)).toBe(60_000);
    expect(enrichTimeoutMs(10_000)).toBe(75_000);
    expect(enrichTimeoutMs(1_000_000)).toBe(300_000);
  });

  it('prepareEnrichRequest truncates to the model budget and reports coverage in the message', () => {
    const prepared = prepareEnrichRequest(
      { title: 'Long', author: 'A', siteName: 'S' },
      {
        sourceType: 'upload',
        model: DEFAULT_ENRICH_MODEL,
        language: 'en',
        vocabulary: new Map(),
        content: `${'a'.repeat(39_000)}\n\n${'b'.repeat(100_000)}`,
        maxInputTokens: 10_000,
      },
    );
    expect(prepared.truncated).toBe(true);
    expect(prepared.coveragePct).toBe(28);
    expect(prepared.params.messages[0]!.content).toContain('Coverage: first ~28% of the document');
    expect(prepared.params.messages[0]!.content).not.toContain('bbbb');
    expect(prepared.estimatedInputTokens).toBeLessThan(10_200);
    expect(prepared.timeoutMs).toBe(
      Math.min(Math.ceil(60_000 + prepared.estimatedInputTokens * 1.5), 300_000),
    );
  });
});

describe('enrichmentResultSchema', () => {
  it('accepts the fixture payload', () => {
    expect(enrichmentResultSchema.safeParse(fixturePayload()).success).toBe(true);
  });

  it('treats null optional fields as absent', () => {
    const p = fixturePayload();
    Object.assign(p.summary as Record<string, unknown>, { whats_new: null, caveats: null });
    Object.assign(p.index as Record<string, unknown>, {
      arguments_for: null,
      related_concepts: null,
    });
    const r = enrichmentResultSchema.safeParse(p);
    expect(r.success).toBe(true);
    expect(r.data!.summary.whats_new).toBeUndefined();
    expect(r.data!.index.arguments_for).toEqual([]);
  });

  it('unwraps a payload the model JSON-encoded inside the summary string', () => {
    const whole = fixturePayload();
    const r = enrichmentResultSchema.safeParse({ summary: JSON.stringify(whole) });
    expect(r.success).toBe(true);
    expect(r.data).toEqual(enrichmentResultSchema.parse(whole));

    const summaryOnly = { ...whole, summary: JSON.stringify(whole.summary) };
    expect(enrichmentResultSchema.safeParse(summaryOnly).data).toEqual(
      enrichmentResultSchema.parse(whole),
    );
  });

  it('still fails when the summary string is not JSON or not an object', () => {
    const p = fixturePayload();
    expect(enrichmentResultSchema.safeParse({ ...p, summary: 'just prose' }).success).toBe(false);
    expect(enrichmentResultSchema.safeParse({ ...p, summary: '"quoted"' }).success).toBe(false);
    expect(enrichmentResultSchema.safeParse({ ...p, summary: '[1, 2]' }).success).toBe(false);
  });

  it.each([
    ['summary', (p: Record<string, unknown>) => delete p.summary],
    [
      'bottom_line',
      (p: Record<string, unknown>) => delete (p.summary as Record<string, unknown>).bottom_line,
    ],
    [
      'key_points',
      (p: Record<string, unknown>) => delete (p.summary as Record<string, unknown>).key_points,
    ],
    ['tags', (p: Record<string, unknown>) => delete p.tags],
    ['index', (p: Record<string, unknown>) => delete p.index],
    ['topics', (p: Record<string, unknown>) => delete (p.index as Record<string, unknown>).topics],
    [
      'entities',
      (p: Record<string, unknown>) => delete (p.index as Record<string, unknown>).entities,
    ],
  ])('fails when %s is missing', (_name, mutate) => {
    const p = fixturePayload();
    mutate(p);
    expect(enrichmentResultSchema.safeParse(p).success).toBe(false);
  });

  it('fails on a wrong type', () => {
    const p = fixturePayload();
    (p.summary as Record<string, unknown>).key_points = 'not an array';
    expect(enrichmentResultSchema.safeParse(p).success).toBe(false);
    const q = fixturePayload();
    q.tags = [1, 2];
    expect(enrichmentResultSchema.safeParse(q).success).toBe(false);
  });

  it('fails on an empty bottom line after trimming', () => {
    const p = fixturePayload();
    (p.summary as Record<string, unknown>).bottom_line = '   ';
    expect(enrichmentResultSchema.safeParse(p).success).toBe(false);
  });

  it('accepts empty topics and entities arrays', () => {
    const p = fixturePayload();
    (p.index as Record<string, unknown>).topics = [];
    (p.index as Record<string, unknown>).entities = [];
    const r = enrichmentResultSchema.safeParse(p);
    expect(r.success).toBe(true);
    expect(r.data!.index.topics).toEqual([]);
  });

  it('fails with zero key points after dropping empty items, accepts one', () => {
    const p = fixturePayload();
    (p.summary as Record<string, unknown>).key_points = ['', '  '];
    expect(enrichmentResultSchema.safeParse(p).success).toBe(false);
    (p.summary as Record<string, unknown>).key_points = ['', 'one'];
    const r = enrichmentResultSchema.safeParse(p);
    expect(r.success).toBe(true);
    expect(r.data!.summary.key_points).toEqual(['one']);
  });

  it('keeps the first 7 of 8 key points', () => {
    const p = fixturePayload();
    (p.summary as Record<string, unknown>).key_points = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const r = enrichmentResultSchema.safeParse(p);
    expect(r.data!.summary.key_points).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('treats empty optional strings as absent and trims the rest', () => {
    const p = fixturePayload();
    Object.assign(p.summary as Record<string, unknown>, {
      whats_new: '  ',
      caveats: '',
      read_in_full_if: '  keep me ',
    });
    const r = enrichmentResultSchema.safeParse(p);
    expect(r.data!.summary.whats_new).toBeUndefined();
    expect(r.data!.summary.caveats).toBeUndefined();
    expect(r.data!.summary.read_in_full_if).toBe('keep me');
  });

  it('drops empty array items in tags and index lists', () => {
    const p = fixturePayload();
    p.tags = ['testing', '', '  '];
    (p.index as Record<string, unknown>).arguments_for = ['', 'x'];
    const r = enrichmentResultSchema.safeParse(p);
    expect(r.data!.tags).toEqual(['testing']);
    expect(r.data!.index.arguments_for).toEqual(['x']);
  });
});

describe('filterEnrichTags', () => {
  const vocabulary = new Map([
    ['testing', 'testing'],
    ['machine learning', 'Machine Learning'],
  ]);

  it('keeps the first 5 of 6 valid tags after dedup', () => {
    expect(filterEnrichTags(['a', 'A', 'b', 'c', 'd', 'e', 'f'], vocabulary)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it('drops an invalid new tag before clamping, keeping tags 1, 3, 4, 5, 6', () => {
    expect(filterEnrichTags(['t1', 'Bad Tag!', 't3', 't4', 't5', 't6'], vocabulary)).toEqual([
      't1',
      't3',
      't4',
      't5',
      't6',
    ]);
  });

  it('drops new tags that are not kebab-case after normalization or exceed 50 characters', () => {
    expect(
      filterEnrichTags(
        ['-leading', ' UPPER ', 'under_score', 'two words', 'x'.repeat(51), 'ok-tag9', 'é-accent'],
        vocabulary,
      ),
    ).toEqual(['upper', 'ok-tag9']);
  });

  it('keeps the stored spelling of an existing non-kebab vocabulary tag', () => {
    expect(filterEnrichTags(['machine learning', ' Machine Learning '], vocabulary)).toEqual([
      'Machine Learning',
    ]);
  });

  it('returns an empty list when every suggestion is dropped', () => {
    expect(filterEnrichTags(['Not Valid', 'also bad!'], vocabulary)).toEqual([]);
  });
});

describe('formatIndexText', () => {
  it('always emits the five headers in order, one line each', () => {
    const text = formatIndexText({ topics: ['a'], entities: [] });
    expect(text).toBe(
      'TOPICS: a\nENTITIES: \nARGUMENTS FOR: \nARGUMENTS AGAINST: \nRELATED CONCEPTS: ',
    );
  });

  it('joins items with ", ", replaces inner newlines and turns inner commas into ";"', () => {
    const text = formatIndexText({
      topics: ['multi\nline', 'Smith, John'],
      entities: ['x'],
      arguments_for: ['f'],
      arguments_against: ['g'],
      related_concepts: ['h'],
    });
    expect(text.split('\n')[0]).toBe('TOPICS: multi line, Smith; John');
    expect(text).toContain(
      '\nENTITIES: x\nARGUMENTS FOR: f\nARGUMENTS AGAINST: g\nRELATED CONCEPTS: h',
    );
  });
});

describe('registry parity', () => {
  it('ENRICH_STATUSES equals the enrich_status enum of the schema', () => {
    expect([...ENRICH_STATUSES]).toEqual(articles.enrichStatus.enumValues);
  });

  it('SETTINGS_SCHEMA takes the enrich_mode defaults from ENRICH_MODE_DEFAULTS', () => {
    for (const type of ENRICH_POLICY_SOURCE_TYPES) {
      expect(SETTINGS_SCHEMA[`enrich_mode_${type}`].defaultValue).toBe(ENRICH_MODE_DEFAULTS[type]);
    }
    expect(ENRICH_MODE_DEFAULTS.rss_feed).toBe('lazy');
    expect(ENRICH_MODE_DEFAULTS.web_save).toBe('auto');
    expect(SETTINGS_SCHEMA.enrich_default_model.defaultValue).toBe(DEFAULT_ENRICH_MODEL);
  });

  it('the tool schema requires summary, tags and index with the documented required subfields', () => {
    expect(ENRICH_TOOL.name).toBe('record_enrichment');
    expect(ENRICH_TOOL.input_schema.required).toEqual(['summary', 'tags', 'index']);
    const props = ENRICH_TOOL.input_schema.properties as Record<string, { required?: string[] }>;
    expect(props.summary!.required).toEqual(['bottom_line', 'key_points']);
    expect(props.index!.required).toEqual(['topics', 'entities']);
  });
});

describe('module boundaries', () => {
  it('enrichment-core.ts imports only from its allowlist', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/lib/enrichment-core.ts'), 'utf-8');
    const specifiers = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(['zod', '@/lib/models', '@/lib/errors', '@/types'], `import ${spec}`).toContain(spec);
    }
    expect(source).not.toMatch(/^import ['"]server-only['"]/m);
  });

  it('src/types/index.ts has only type-only imports', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/types/index.ts'), 'utf-8');
    const imports = source.match(/^import\b.*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line, line).toMatch(/^import type\b/);
  });
});
