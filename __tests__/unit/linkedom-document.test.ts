import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseHtmlDocument, parseHtmlFragment } from '@/lib/linkedom-document';
import { parseArticleFromHtml } from '@/lib/article-parser';
import { preprocessEmailHtml } from '@/lib/email-preprocessor';
import { chunkHtml } from '@/lib/reformat-chunker';

const ARTICLE_URL = 'https://news.example.com/2026/10/long-read.html';

describe('parseHtmlDocument', () => {
  it('parses a full document and exposes head and body', () => {
    const doc = parseHtmlDocument(
      '<!DOCTYPE html><html><head><title>Hi</title></head><body><p>One</p></body></html>',
    );

    expect(doc.title).toBe('Hi');
    expect(doc.body.innerHTML).toBe('<p>One</p>');
  });

  it('polyfills styleSheets and getComputedStyle for Defuddle', () => {
    const doc = parseHtmlDocument('<html><head></head><body><p>x</p></body></html>');

    expect(Array.isArray(doc.styleSheets)).toBe(true);
    const view = doc.defaultView;
    expect(view).toBeTruthy();
    expect(typeof view!.getComputedStyle).toBe('function');
    expect(view!.getComputedStyle(doc.body).display).toBe('');
  });

  it('sets document.URL when a url is given', () => {
    const doc = parseHtmlDocument('<html><head></head><body></body></html>', ARTICLE_URL);

    expect(doc.URL).toBe(ARTICLE_URL);
  });

  it('lowercases HTML attribute names like an HTML5 parser, keeping source order', () => {
    const doc = parseHtmlDocument(
      '<HTML><HEAD><META NAME="author" CONTENT="Harold"></HEAD>' +
        '<BODY><A HREF="/x" TITLE="t" Class="c">x</A></BODY></HTML>',
    );

    expect(doc.querySelector('meta[name="author"]')?.getAttribute('content')).toBe('Harold');
    const link = doc.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/x');
    expect(Array.from(link.attributes, (a) => a.name)).toEqual(['href', 'title', 'class']);
  });

  it('leaves SVG attribute case alone', () => {
    const doc = parseHtmlDocument(
      '<html><body><svg viewBox="0 0 10 10"><path d="M0 0"/></svg></body></html>',
    );

    expect(doc.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 10 10');
  });

  it('merges text split at entities into a single text node', () => {
    const doc = parseHtmlDocument('<html><body><p>By Harold &mdash; March 2003</p></body></html>');

    const p = doc.querySelector('p')!;
    expect(p.childNodes).toHaveLength(1);
    expect(p.textContent).toBe('By Harold — March 2003');
  });

  it('parses the empty-document fallback without throwing', () => {
    const doc = parseHtmlDocument('<html><head></head><body></body></html>');

    expect(doc.body).toBeTruthy();
    expect(doc.body.innerHTML).toBe('');
  });

  it('synthesises a body for a document whose <body> tag is omitted', () => {
    const doc = parseHtmlDocument(
      '<!DOCTYPE html><html><head><title>T</title></head><article><p>x</p></article>tail</html>',
    );

    expect(doc.title).toBe('T');
    expect(doc.body.innerHTML).toBe('<article><p>x</p></article>tail');
    expect(doc.head.querySelector('title')).toBeTruthy();
  });
});

describe('parseHtmlFragment', () => {
  it('returns a populated body for a fragment lacking <html>/<body>', () => {
    const doc = parseHtmlFragment('<p>First</p><ul><li>a</li></ul><p>Last</p>');

    expect(doc.body).toBeTruthy();
    expect(Array.from(doc.body.children).map((el) => el.tagName.toLowerCase())).toEqual([
      'p',
      'ul',
      'p',
    ]);
  });

  it('keeps a bare text fragment as body text with no element children', () => {
    const doc = parseHtmlFragment('  just text with no tags  ');

    expect(doc.body.children).toHaveLength(0);
    expect(doc.body.textContent).toContain('just text with no tags');
  });
});

describe('linkedom consumers', () => {
  it('parseArticleFromHtml handles whitespace-only input via the empty-document fallback', async () => {
    const parsed = await parseArticleFromHtml('   \n  ', ARTICLE_URL);

    expect(parsed.title).toBe(ARTICLE_URL);
    expect(parsed.wordCount).toBe(0);
  });

  it('parseArticleFromHtml resolves relative links and images against the article url', async () => {
    const html = `<!DOCTYPE html><html><head><title>Long read</title></head><body><article>
      <h1>Long read</h1>
      <p>This paragraph is long enough to be the main content and links to <a href="/2026/09/earlier.html">an earlier piece</a> and <a href="appendix.html">the appendix</a>.</p>
      <p>A second paragraph keeps the extractor confident about the article body and its structure.</p>
      <img src="../images/chart.png" alt="A chart of results" width="600" height="400">
      <p>A closing paragraph that wraps up the article with a few more words of real prose.</p>
    </article></body></html>`;

    const parsed = await parseArticleFromHtml(html, ARTICLE_URL);

    expect(parsed.contentHtml).toContain('href="https://news.example.com/2026/09/earlier.html"');
    expect(parsed.contentHtml).toContain('href="https://news.example.com/2026/10/appendix.html"');
    expect(parsed.contentHtml).toContain('src="https://news.example.com/2026/images/chart.png"');
  });

  it('preprocessEmailHtml removes spacers and tracking pixels from MSO-stripped, tbody-less tables', () => {
    const html = `<html><body>
<!--[if mso]><table width="600"><tr><td><![endif]-->
<table width="600" cellpadding="0" cellspacing="0">
<tr><td height="20">&nbsp;</td></tr>
<tr><td><p>Real newsletter paragraph with content.</p></td></tr>
<tr><td></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
<img src="https://u1.ct.sendgrid.net/wf/open?upn=abc" width="1" height="1" alt="">
</body></html>`;

    const out = preprocessEmailHtml(html);

    expect(out).toContain('Real newsletter paragraph with content.');
    expect(out).not.toContain('[if mso]');
    expect(out).not.toContain('sendgrid');
    expect(out).not.toContain('height="20"');
    expect(out).not.toMatch(/<td>\s*<\/td>/);
  });

  it('chunkHtml splits an oversized <table> into sub-chunks re-wrapped in the parent tag', () => {
    const rows = Array.from(
      { length: 20 },
      (_, i) => `<tr><td>row ${i} ${'cell text '.repeat(10)}</td></tr>`,
    ).join('');
    const chunks = chunkHtml(`<table class="data">${rows}</table>`, 800);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.html.startsWith('<table class="data">')).toBe(true);
      expect(chunk.html.endsWith('</table>')).toBe(true);
    }
  });

  it('chunkHtml splits an oversized <ul> into sub-chunks re-wrapped in the parent tag', () => {
    const items = Array.from({ length: 20 }, (_, i) => `<li>item ${i} ${'words '.repeat(15)}</li>`);
    const chunks = chunkHtml(`<ul>${items.join('')}</ul>`, 800);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.html).toMatch(/^<ul>[\s\S]*<\/ul>$/);
    }
  });

  it('chunkHtml returns [] for empty, whitespace-only and bare-text input', () => {
    expect(chunkHtml('')).toEqual([]);
    expect(chunkHtml('  \n\t ')).toEqual([]);
    expect(chunkHtml('  just text with no tags  ')).toEqual([]);
  });
});

describe('jsdom scope guard', () => {
  const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8');

  it('keeps reanchor-highlights on jsdom (Range/TreeWalker APIs)', () => {
    expect(read('src/app/api/articles/[id]/reanchor-highlights/route.ts')).toMatch(/from 'jsdom'/);
  });

  it.each([
    'src/lib/article-parser.ts',
    'src/lib/html-post-processor.ts',
    'src/lib/email-preprocessor.ts',
    'src/lib/reformat-chunker.ts',
  ])('%s no longer imports jsdom', (file) => {
    expect(read(file)).not.toMatch(/from 'jsdom'/);
  });
});
