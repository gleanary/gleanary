/** @vitest-environment jsdom */
import { useState } from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ArticleProvider, useArticle } from '@/components/reader/article-context';
import { GenerateAction } from '@/components/context-panel/generate-action';
import type { Article } from '@/types';

// The widget fetches relative URLs, which MSW cannot intercept in Node: stub fetch.
const fetchMock = vi.fn<typeof fetch>();
beforeAll(() => vi.stubGlobal('fetch', fetchMock));
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

// Typo-safe partial fixture (see reading-progress-bar.test.tsx)
function makeArticle(fields: Partial<Article>): Article {
  return fields as Article;
}

const ARTICLE_ID = 100;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Makes the next fetch hang until `resolve` is called with a response. */
function deferFetch() {
  let resolve!: (res: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  return {
    resolve: async (res: Response) => {
      await act(async () => {
        resolve(res);
      });
    },
  };
}

/** Shows the article state held by the provider (what the panel sections render from). */
function ArticleProbe() {
  const { article } = useArticle();
  return (
    <output data-testid="probe">
      {JSON.stringify({ id: article.id, aiSummary: article.aiSummary, aiTags: article.aiTags })}
    </output>
  );
}

/** Counts renders of a `useArticle()` consumer that does not read Generate state. */
let articleConsumerRenders = 0;
function ArticleRenderCounter() {
  useArticle();
  articleConsumerRenders++;
  return null;
}

function Harness({
  kind,
  articleId,
  aiAvailable = true,
}: {
  kind: 'summary' | 'tags';
  articleId: number;
  aiAvailable?: boolean;
}) {
  const [shown, setShown] = useState(true);
  return (
    <ArticleProvider initialArticle={makeArticle({ id: articleId, aiSummary: null, aiTags: null })}>
      <button onClick={() => setShown((s) => !s)}>toggle widget</button>
      {shown && <GenerateAction kind={kind} aiAvailable={aiAvailable} />}
      <ArticleProbe />
      <ArticleRenderCounter />
    </ArticleProvider>
  );
}

function renderAction(kind: 'summary' | 'tags' = 'summary', aiAvailable = true) {
  const { unmount } = render(
    <Harness kind={kind} articleId={ARTICLE_ID} aiAvailable={aiAvailable} />,
  );
  return unmount;
}

function probe(): { id: number; aiSummary: string | null; aiTags: string | null } {
  return JSON.parse(screen.getByTestId('probe').textContent ?? '{}');
}

const generateButton = () => screen.getByRole('button', { name: 'Generate' });
const pendingButton = () => screen.getByRole('button', { name: 'Generating…' });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('GenerateAction', () => {
  it('idle: shows a hint and an enabled Generate button, without fetching', () => {
    renderAction();
    expect((generateButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/no summary yet/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pending: disables the button with a spinner label and sends one request', () => {
    renderAction();
    deferFetch();

    fireEvent.click(generateButton());

    expect((pendingButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pendingButton());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/summarize');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ articleId: ARTICLE_ID });
  });

  it('success: applies the summary through the article context', async () => {
    renderAction();
    const request = deferFetch();

    fireEvent.click(generateButton());
    await request.resolve(jsonResponse(200, { summary: 'A short summary.', cached: false }));

    expect(probe().aiSummary).toBe('A short summary.');
  });

  it('success (tags): posts to the tag route and stores the tags as JSON', async () => {
    renderAction('tags');
    const request = deferFetch();

    fireEvent.click(generateButton());
    await request.resolve(jsonResponse(200, { tags: ['ai', 'Databases'] }));

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/ai/tag');
    expect(probe()).toEqual({ id: ARTICLE_ID, aiSummary: null, aiTags: '["ai","Databases"]' });
  });

  it('error: shows the API message inline with a Retry button that retries', async () => {
    renderAction();
    const failed = deferFetch();

    fireEvent.click(generateButton());
    await failed.resolve(jsonResponse(422, { error: 'Article has no content to analyze' }));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Article has no content to analyze');
    expect(alert.className).toContain('text-destructive');
    expect(probe().aiSummary).toBeNull();

    const retry = deferFetch();
    click('Retry');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    await retry.resolve(jsonResponse(200, { summary: 'Second time lucky.', cached: false }));

    expect(probe().aiSummary).toBe('Second time lucky.');
  });

  it('error: shows a message when the request itself fails', async () => {
    renderAction();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await act(async () => {
      fireEvent.click(generateButton());
    });

    expect(screen.getByRole('alert').textContent).toContain('Failed to fetch');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('error: an empty tag suggestion is reported instead of silently resetting', async () => {
    renderAction('tags');
    const request = deferFetch();

    fireEvent.click(generateButton());
    await request.resolve(jsonResponse(200, { tags: [] }));

    expect(screen.getByRole('alert').textContent).toContain('No tags were suggested');
    expect(probe().aiTags).toBeNull();
  });

  it('error: an empty summary is reported instead of silently resetting', async () => {
    renderAction();
    const request = deferFetch();

    fireEvent.click(generateButton());
    await request.resolve(jsonResponse(200, { summary: '', cached: false }));

    expect(screen.getByRole('alert').textContent).toContain('No summary was generated');
    expect(probe().aiSummary).toBeNull();
  });

  it('error: an unexpected tag response shape is rejected, not stored', async () => {
    renderAction('tags');
    const request = deferFetch();

    fireEvent.click(generateButton());
    await request.resolve(
      jsonResponse(200, { tags: [{ id: 1, name: 'x', color: '#abc' }], created: [] }),
    );

    expect(screen.getByRole('alert').textContent).toContain('Unexpected response from server');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(probe().aiTags).toBeNull();
  });

  it('error: an unexpected summary response shape is rejected, not stored', async () => {
    renderAction();
    const request = deferFetch();

    fireEvent.click(generateButton());
    await request.resolve(jsonResponse(200, { summary: 42, cached: true }));

    expect(screen.getByRole('alert').textContent).toContain('Unexpected response from server');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(probe().aiSummary).toBeNull();
  });

  it('error: a null body on a 200 is an unexpected response', async () => {
    renderAction();
    const request = deferFetch();

    fireEvent.click(generateButton());
    await request.resolve(jsonResponse(200, null));

    expect(screen.getByRole('alert').textContent).toContain('Unexpected response from server');
    expect(probe().aiSummary).toBeNull();
  });

  it('unavailable: links to Settings and shows no button', () => {
    renderAction('summary', false);

    const link = screen.getByRole('link', { name: /add an anthropic api key in settings/i });
    expect(link.getAttribute('href')).toBe('/settings');
    expect(screen.queryByRole('button', { name: 'Generate' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies the result even if the widget unmounted while the request was running', async () => {
    renderAction();
    const request = deferFetch();

    fireEvent.click(generateButton());
    click('toggle widget');
    expect(screen.queryByRole('button', { name: 'Generating…' })).toBeNull();
    await request.resolve(jsonResponse(200, { summary: 'Outlived the widget.', cached: false }));

    expect(probe().aiSummary).toBe('Outlived the widget.');
  });

  it('a remounted widget shows the request still running and does not send another', async () => {
    renderAction();
    const request = deferFetch();

    fireEvent.click(generateButton());
    click('toggle widget');
    click('toggle widget');

    expect((pendingButton() as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await request.resolve(jsonResponse(200, { summary: 'Remounted.', cached: false }));
    expect(probe().aiSummary).toBe('Remounted.');
  });

  it('a result that settles after the provider unmounted is a no-op', async () => {
    const unmount = renderAction();
    const request = deferFetch();

    fireEvent.click(generateButton());
    expect(pendingButton()).toBeTruthy();
    // Navigating to another article remounts the reader page, and with it the provider
    unmount();
    await request.resolve(jsonResponse(200, { summary: 'For the old article.', cached: false }));

    // The next visit starts from the server's article and an idle request
    render(<Harness kind="summary" articleId={ARTICLE_ID} />);
    expect(probe()).toEqual({ id: ARTICLE_ID, aiSummary: null, aiTags: null });
    expect(generateButton().hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a pending request does not re-render useArticle() consumers', async () => {
    renderAction();
    const request = deferFetch();
    const before = articleConsumerRenders;

    fireEvent.click(generateButton());

    expect(pendingButton()).toBeTruthy();
    expect(articleConsumerRenders).toBe(before);
    await request.resolve(jsonResponse(200, { summary: 'Landed.', cached: false }));
    // The result changes the article, so article consumers render once more
    expect(articleConsumerRenders).toBe(before + 1);
    expect(probe().aiSummary).toBe('Landed.');
  });
});
