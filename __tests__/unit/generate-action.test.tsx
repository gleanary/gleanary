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

// In-flight requests are tracked per article and kind for the whole page session, so
// every test uses its own article id.
let nextArticleId = 100;

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

/** Makes the provider hold another article, as navigating to it would. */
function SwitchArticle({ toId }: { toId: number }) {
  const { updateArticle } = useArticle();
  return (
    <button onClick={() => updateArticle({ id: toId, aiSummary: null })}>switch article</button>
  );
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
      <SwitchArticle toId={articleId + 10_000} />
    </ArticleProvider>
  );
}

function renderAction(kind: 'summary' | 'tags' = 'summary', aiAvailable = true) {
  const articleId = nextArticleId++;
  render(<Harness kind={kind} articleId={articleId} aiAvailable={aiAvailable} />);
  return articleId;
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
    const articleId = renderAction();
    deferFetch();

    fireEvent.click(generateButton());

    expect((pendingButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pendingButton());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/summarize');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ articleId });
  });

  it('success: applies the summary through the article context', async () => {
    renderAction();
    const request = deferFetch();

    fireEvent.click(generateButton());
    await request.resolve(jsonResponse(200, { summary: 'A short summary.', cached: false }));

    expect(probe().aiSummary).toBe('A short summary.');
  });

  it('success (tags): posts to the tag route and stores the tags as JSON', async () => {
    const articleId = renderAction('tags');
    const request = deferFetch();

    fireEvent.click(generateButton());
    await request.resolve(jsonResponse(200, { tags: ['ai', 'Databases'] }));

    expect(fetchMock.mock.calls[0]![0]).toBe('/api/ai/tag');
    expect(probe()).toEqual({ id: articleId, aiSummary: null, aiTags: '["ai","Databases"]' });
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

  it('does not write a late result into another article', async () => {
    const articleId = renderAction();
    const request = deferFetch();

    fireEvent.click(generateButton());
    expect(pendingButton()).toBeTruthy();
    click('switch article');
    // The new article's status is idle right away, not the old article's pending
    expect(generateButton().hasAttribute('disabled')).toBe(false);
    await request.resolve(jsonResponse(200, { summary: 'For the old article.', cached: false }));

    expect(probe()).toEqual({ id: articleId + 10_000, aiSummary: null, aiTags: null });
    expect(generateButton().hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
