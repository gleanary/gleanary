import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DefuddleClass from 'defuddle';

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { logger } from '@/lib/logger';
import { parseArticleFromHtml, getDefuddleParseErrors } from '@/lib/article-parser';
import { parseHtmlDocument } from '@/lib/linkedom-document';

const URL = 'https://blog.example.com/posts/forced-error';

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>A clean article</title></head><body>
<article><h1>A clean article</h1>
<p>This paragraph has enough words to be treated as the main content of the page by the extractor.</p>
<p>A second paragraph keeps the extractor confident that this is a real article body worth keeping.</p>
</article></body></html>`;

/** Defuddle's internal parse step; private in its typings, stable across 0.19.x. */
type DefuddleInternals = { _parseWithRetries: () => unknown };

/** Forces every Defuddle extraction to throw inside its internal try/catch. */
function forceDefuddleError(): void {
  vi.spyOn(
    DefuddleClass.prototype as unknown as DefuddleInternals,
    '_parseWithRetries',
  ).mockImplementation(() => {
    throw new Error('forced extraction failure');
  });
}

function parseErrorWarnCalls(): unknown[][] {
  return vi
    .mocked(logger.warn)
    .mock.calls.filter(
      ([obj]) => (obj as { event?: string } | undefined)?.event === 'defuddle_parse_errors',
    );
}

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
  // Defuddle reports extraction errors through console.error; keep test output clean.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getDefuddleParseErrors', () => {
  it('reads the errors a real Defuddle instance recorded during a failed parse', async () => {
    // Pins the private `_parseErrors` field name: a Defuddle rename fails here.
    forceDefuddleError();
    const defuddle = new DefuddleClass(parseHtmlDocument(ARTICLE_HTML, URL), { url: URL });

    await defuddle.parseAsync();

    expect(getDefuddleParseErrors(defuddle)).toEqual(['Error: forced extraction failure']);
  });

  it('returns [] for a real Defuddle instance after a clean parse', async () => {
    const defuddle = new DefuddleClass(parseHtmlDocument(ARTICLE_HTML, URL), { url: URL });

    await defuddle.parseAsync();

    expect(getDefuddleParseErrors(defuddle)).toEqual([]);
  });

  it('returns [] when _parseErrors is absent', () => {
    expect(getDefuddleParseErrors({})).toEqual([]);
    expect(getDefuddleParseErrors(null)).toEqual([]);
    expect(getDefuddleParseErrors(undefined)).toEqual([]);
  });

  it('returns [] when _parseErrors is not a Set', () => {
    expect(getDefuddleParseErrors({ _parseErrors: ['Error: not a set'] })).toEqual([]);
    expect(getDefuddleParseErrors({ _parseErrors: 'Error: a string' })).toEqual([]);
  });
});

describe('parseArticleFromHtml: Defuddle parse-error logging', () => {
  it('logs exactly one defuddle_parse_errors warning with the url when extraction fails', async () => {
    forceDefuddleError();

    await parseArticleFromHtml(ARTICLE_HTML, URL);

    const calls = parseErrorWarnCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({
      event: 'defuddle_parse_errors',
      url: URL,
      errors: ['Error: forced extraction failure'],
    });
  });

  it('logs no defuddle_parse_errors warning for a clean parse', async () => {
    await parseArticleFromHtml(ARTICLE_HTML, URL);

    expect(parseErrorWarnCalls()).toHaveLength(0);
  });
});
