import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { JSDOM } from 'jsdom';
import type { Chunk } from '@/lib/reformat-chunker';
import {
  WEB_FIXTURES,
  EMAIL_FIXTURES,
  baselinePath,
  computeSnapshot,
  type CorpusSnapshot,
} from '../mocks/fixtures/html-corpus/corpus';

/**
 * Parser parity: every corpus fixture's output must equal the baseline that
 * was recorded on the jsdom 29 implementation before the switch to linkedom.
 * Never re-record a baseline to make this pass; investigate the diff instead.
 */
function readBaseline(name: string): CorpusSnapshot {
  return JSON.parse(readFileSync(baselinePath(name), 'utf-8')) as CorpusSnapshot;
}

const canonicalDocument = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>').window
  .document;

/**
 * Canonical form of an HTML string, used on both sides of every HTML comparison.
 *
 * Every HTML output compared here is re-parsed by an HTML5 parser before it is
 * stored (DOMPurify on jsdom in `sanitizeArticleHtml`), so these serialisation
 * differences between jsdom and linkedom never reach the database:
 *  - jsdom inserts the implied `<tbody>`; linkedom (htmlparser2) does not, so
 *    whitespace-only text between `<table>` and the first row lands on the other
 *    side of the re-parsed `<tbody>`.
 *  - linkedom escapes only `"` in attribute values, so `&amp;` is written as `&`.
 *  - linkedom writes empty boolean attributes bare (`defer`, not `defer=""`).
 *  - linkedom's setAttribute prepends, so attributes Defuddle adds (e.g. the
 *    footnote back-links on wikipedia-style) come out in reverse order.
 *  - jsdom moves whitespace that follows `</body>` into the body; linkedom drops it.
 * Canonicalisation: HTML5 re-parse in body context (standards mode), attributes
 * sorted by name, whitespace around `<tbody>` and at the end dropped. Text,
 * tags, nesting and attribute values are still compared exactly.
 */
function canonicalHtml(html: string): string {
  const body = canonicalDocument.body;
  body.innerHTML = html;
  for (const el of Array.from(body.querySelectorAll('*'))) {
    const attrs = Array.from(el.attributes, (a) => [a.name, a.value] as const);
    for (const [name] of attrs) el.removeAttribute(name);
    for (const [name, value] of [...attrs].sort(([a], [b]) => a.localeCompare(b))) {
      el.setAttribute(name, value);
    }
  }
  return body.innerHTML.replace(/\s*<tbody>\s*/g, '<tbody>').trimEnd();
}

/**
 * legacy-table-layout only. Its malformed HTML 4 markup is where an HTML5 tree
 * builder and htmlparser2 genuinely build different trees; the text is identical.
 *  1. The HTML 4.01 Transitional doctype puts jsdom in quirks mode, where
 *     `<table>` does not close an open `<p>`, so the baseline nests the price
 *     table inside the preceding paragraph. linkedom closes the `<p>` first (the
 *     standards-mode tree). After the standards-mode re-parse in canonicalHtml,
 *     the baseline's stray `</p>` becomes an empty `<p></p>`: drop it.
 *  2. Unclosed `<P>`s inside `<FONT>` closed by `</FONT>`: HTML5's adoption-agency
 *     algorithm re-opens `<font>` inside the next paragraph, linkedom keeps one
 *     `<font>` around the paragraphs. Same rendered font; only the raw full-page
 *     postProcessHtml output shows it (the extracted article does not), so
 *     `<font>` tags are unwrapped for this fixture.
 *  Both move whitespace across tag boundaries, so this fixture is compared
 *  whitespace-insensitively: runs next to a tag are dropped, others collapse
 *  to one space. Words and their order are still compared exactly.
 */
function dropLegacyMarkupArtefacts(html: string): string {
  return html
    .replace(/<\/?font\b[^>]*>/g, '')
    .replace(/\s*(<[^>]*>)\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/<p><\/p>/g, '');
}

type Canon = (html: string) => string;

/** Chunk comparison on canonical html; charCount is derived from html length. */
function canonicalChunks(chunks: Chunk[] | undefined, canon: Canon) {
  return chunks?.map(({ index, html, isOversized }) => ({
    index,
    isOversized,
    html: canon(html),
  }));
}

function canonFor(name: string): Canon {
  return name === 'legacy-table-layout'
    ? (html) => dropLegacyMarkupArtefacts(canonicalHtml(html))
    : canonicalHtml;
}

describe('parser parity with jsdom 29 baselines', () => {
  describe.each(Object.keys(WEB_FIXTURES))('web page: %s', (name) => {
    it('matches the article-parser, chunker and post-processor baselines', async () => {
      const baseline = readBaseline(name);
      const actual = await computeSnapshot(name);
      const canon = canonFor(name);

      expect(actual.parsed).toBeDefined();
      const { contentHtml, ...metadata } = actual.parsed!;
      const { contentHtml: baselineContentHtml, ...baselineMetadata } = baseline.parsed!;
      expect(metadata).toEqual(baselineMetadata);
      expect(canon(contentHtml)).toEqual(canon(baselineContentHtml));
      expect(canonicalChunks(actual.chunks, canon)).toEqual(
        canonicalChunks(baseline.chunks, canon),
      );
      expect(canon(actual.postProcessed)).toEqual(canon(baseline.postProcessed));
    });
  });

  describe.each(EMAIL_FIXTURES)('newsletter email: %s', (name) => {
    it('matches the email-preprocessor and post-processor baselines', async () => {
      const baseline = readBaseline(name);
      const actual = await computeSnapshot(name);

      expect(canonicalHtml(actual.email!)).toEqual(canonicalHtml(baseline.email!));
      expect(canonicalHtml(actual.postProcessed)).toEqual(canonicalHtml(baseline.postProcessed));
    });
  });
});
