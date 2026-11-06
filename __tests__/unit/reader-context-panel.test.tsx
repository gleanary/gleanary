/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ArticleProvider, useArticle } from '@/components/reader/article-context';
import { ReaderContextPanel } from '@/components/reader/reader-context-panel';
import type { Article } from '@/types';

// Render the tabs in place instead of portaling them into the app shell's slot: the
// shell is covered by context-panel.test.tsx, this file covers the reader composition.
vi.mock('@/components/layout/context-panel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/layout/context-panel')>();
  return {
    ...actual,
    ContextPanelPortal: ({
      tabs,
    }: {
      tabs: Parameters<typeof actual.ContextPanelTabs>[0]['tabs'];
    }) => <actual.ContextPanelTabs tabs={tabs} />,
  };
});

// Generate fetches a relative URL, which MSW cannot intercept in Node: stub fetch.
const fetchMock = vi.fn<typeof fetch>();
beforeAll(() => vi.stubGlobal('fetch', fetchMock));
afterAll(() => vi.unstubAllGlobals());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

// Typo-safe partial fixture (see reading-progress-bar.test.tsx)
function makeArticle(fields: Partial<Article>): Article {
  return {
    id: 1,
    author: 'Jane Doe',
    siteName: 'Example Blog',
    sourceId: 1,
    publishedAt: '2024-01-15T12:00:00Z',
    savedAt: '2024-02-20 12:00:00',
    readAt: null,
    wordCount: 1190,
    pageCount: null,
    aiSummary: null,
    aiTags: null,
    ...fields,
  } as Article;
}

function renderPanel(
  fields: Partial<Article> = {},
  {
    sourceName = null,
    aiAvailable = true,
  }: { sourceName?: string | null; aiAvailable?: boolean } = {},
) {
  render(
    <ArticleProvider initialArticle={makeArticle(fields)}>
      <ReaderContextPanel sourceName={sourceName} aiAvailable={aiAvailable} />
    </ArticleProvider>,
  );
}

/** Value of the About field labelled `label`, or null when the row is not rendered. */
function field(label: string): string | null {
  const row = screen
    .queryAllByTestId('panel-field')
    .find((el) => within(el).getByRole('term').textContent === label);
  return row ? (within(row).getByRole('definition').textContent ?? '') : null;
}

function section(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: label });
  return heading.closest('section')!;
}

describe('ReaderContextPanel', () => {
  it('shows the About fields of a web article', () => {
    renderPanel();

    expect(field('Author')).toBe('Jane Doe');
    expect(field('Site')).toBe('Example Blog');
    expect(field('Published')).toBe('January 15, 2024');
    expect(field('Saved')).toBe('February 20, 2024');
    expect(field('Length')).toBe('1,190 words · 5 min read');
  });

  it('skips Read until the article is read', () => {
    renderPanel();

    expect(field('Read')).toBeNull();
  });

  it('shows Source for every article, web saves included', () => {
    renderPanel({}, { sourceName: 'Web saves' });

    expect(field('Source')).toBe('Web saves');
  });

  it('shows Source when the article has one, and Read once it is stamped', () => {
    renderPanel({ sourceId: 7, readAt: '2024-03-01 09:00:00' }, { sourceName: 'Morning Brew' });

    expect(field('Source')).toBe('Morning Brew');
    expect(field('Read')).toBe('March 1, 2024');
  });

  it('dashes missing metadata', () => {
    renderPanel({ author: null, siteName: '', publishedAt: null, wordCount: null });

    expect(field('Author')).toBe('—');
    expect(field('Site')).toBe('—');
    expect(field('Published')).toBe('—');
    expect(field('Length')).toBe('—');
  });

  it('shows the page count as the length of a PDF', () => {
    renderPanel({ pageCount: 42, wordCount: 9000 });

    expect(field('Length')).toBe('42 pages');
  });

  it('shows the summary and the tags when they exist', () => {
    renderPanel({ aiSummary: 'A short summary.', aiTags: '["ai","Databases"]' });

    expect(within(section('Summary')).getByTestId('panel-text-block').textContent).toBe(
      'A short summary.',
    );
    const tags = within(section('Tags')).getAllByRole('listitem');
    expect(tags.map((t) => t.textContent)).toEqual(['ai', 'Databases']);
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull();
  });

  it('offers Generate for an empty summary and for malformed tags', () => {
    renderPanel({ aiSummary: null, aiTags: 'not json' });

    expect(within(section('Summary')).getByRole('button', { name: 'Generate' })).toBeTruthy();
    expect(within(section('Tags')).getByRole('button', { name: 'Generate' })).toBeTruthy();
  });

  it('shows the Settings hint instead of Generate when AI is unavailable', () => {
    renderPanel({}, { aiAvailable: false });

    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull();
    expect(screen.getAllByRole('link', { name: /add an anthropic api key/i })).toHaveLength(2);
  });

  it('Generate tags stores the tags as JSON in the article context and lists them', async () => {
    const tags = ['machine learning', 'Databases'];
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ tags }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    function AiTagsProbe() {
      return <output data-testid="ai-tags">{useArticle().article.aiTags}</output>;
    }
    render(
      <ArticleProvider initialArticle={makeArticle({ id: 900, aiTags: null })}>
        <ReaderContextPanel sourceName={null} aiAvailable />
        <AiTagsProbe />
      </ArticleProvider>,
    );

    await act(async () => {
      fireEvent.click(within(section('Tags')).getByRole('button', { name: 'Generate' }));
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/ai/tag', expect.anything());
    expect(screen.getByTestId('ai-tags').textContent).toBe(JSON.stringify(tags));
    const items = within(section('Tags')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(tags);
    expect(within(section('Tags')).queryByRole('button', { name: 'Generate' })).toBeNull();
  });

  it('a failed Generate shows its error for the current visit only', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'AI provider failed' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const panel = (
      <ArticleProvider initialArticle={makeArticle({ id: 901 })}>
        <ReaderContextPanel sourceName={null} aiAvailable />
      </ArticleProvider>
    );
    const { unmount } = render(panel);
    await act(async () => {
      fireEvent.click(within(section('Summary')).getByRole('button', { name: 'Generate' }));
    });
    expect(within(section('Summary')).getByRole('alert').textContent).toBe('AI provider failed');

    // Leaving the article and coming back starts idle
    unmount();
    render(panel);
    expect(within(section('Summary')).queryByRole('alert')).toBeNull();
    expect(within(section('Summary')).getByRole('button', { name: 'Generate' })).toBeTruthy();
  });
});
