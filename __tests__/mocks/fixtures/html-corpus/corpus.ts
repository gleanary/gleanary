/**
 * Raw-HTML parity corpus for the server-side parser paths (article-parser,
 * html-post-processor, email-preprocessor, reformat-chunker).
 *
 * The JSON files in `baselines/` were recorded once against the jsdom 29
 * implementation, before the parser paths moved to linkedom. They are the
 * reference output and must not be re-recorded to make a diff go away: a
 * parity failure means the parser changed behaviour and needs investigating.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseArticleFromHtml } from '@/lib/article-parser';
import { postProcessHtml } from '@/lib/html-post-processor';
import { preprocessEmailHtml } from '@/lib/email-preprocessor';
import { chunkHtml, type Chunk } from '@/lib/reformat-chunker';

/** Small chunk target so every web fixture exercises multi-chunk splitting. */
export const CORPUS_CHUNK_TARGET = 800;

/** Web-page fixtures and the URL each one is parsed against. */
export const WEB_FIXTURES: Record<string, string> = {
  'legacy-table-layout': 'http://harold.example.org/essays/small-presses.html',
  'modern-blog': 'https://blog.driftwood.dev/posts/sync-engine-rewrite',
  'code-blocks': 'https://tidybytes.example.com/posts/expression-parser',
  'wikipedia-style': 'https://en.wikipedia.org/wiki/Lighthouse_of_Alexandria',
};

/** Newsletter email fixtures (processed by preprocessEmailHtml, no URL). */
export const EMAIL_FIXTURES: readonly string[] = ['newsletter-1', 'newsletter-2', 'newsletter-3'];

/** The article-parser fields compared for parity. */
export interface ParsedArticleSnapshot {
  title: string;
  author: string | null;
  siteName: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
  contentHtml: string;
  excerpt: string | null;
  wordCount: number;
}

/** Recorded output for one fixture. Fields absent for a fixture kind are omitted. */
export interface CorpusSnapshot {
  parsed?: ParsedArticleSnapshot;
  chunks?: Chunk[];
  email?: string;
  postProcessed: string;
}

/**
 * Reads a corpus fixture's raw HTML.
 * @param name - Fixture name without extension
 * @returns The fixture HTML
 */
export function readFixture(name: string): string {
  return readFileSync(join(__dirname, `${name}.html`), 'utf-8');
}

/**
 * Path of a fixture's committed baseline JSON.
 * @param name - Fixture name without extension
 * @returns Absolute path to the baseline file
 */
export function baselinePath(name: string): string {
  return join(__dirname, 'baselines', `${name}.json`);
}

/**
 * Runs every parser path that applies to a fixture and returns the outputs.
 * @param name - Fixture name without extension
 * @returns The snapshot to compare against the baseline
 */
export async function computeSnapshot(name: string): Promise<CorpusSnapshot> {
  const html = readFixture(name);
  const url = WEB_FIXTURES[name];

  if (url === undefined) {
    return { email: preprocessEmailHtml(html), postProcessed: postProcessHtml(html) };
  }

  const article = await parseArticleFromHtml(html, url);
  const parsed: ParsedArticleSnapshot = {
    title: article.title,
    author: article.author,
    siteName: article.siteName,
    imageUrl: article.imageUrl,
    publishedAt: article.publishedAt,
    contentHtml: article.contentHtml,
    excerpt: article.excerpt,
    wordCount: article.wordCount,
  };
  return {
    parsed,
    chunks: chunkHtml(article.contentHtml, CORPUS_CHUNK_TARGET),
    postProcessed: postProcessHtml(html),
  };
}
