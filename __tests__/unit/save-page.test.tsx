/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ParseArticleResult } from '@/lib/article-api';

const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ replace, push: vi.fn(), prefetch: vi.fn() }),
}));

const parseArticleByUrl = vi.fn<(url: string) => Promise<ParseArticleResult>>();
vi.mock('@/lib/article-api', () => ({
  parseArticleByUrl: (url: string) => parseArticleByUrl(url),
}));

import SavePage from '@/app/save/page';

describe('SavePage', () => {
  beforeEach(() => {
    replace.mockReset();
    parseArticleByUrl.mockReset();
    searchParams = new URLSearchParams();
  });

  afterEach(() => cleanup());

  it('opens the article after a shared URL is saved', async () => {
    searchParams = new URLSearchParams({ url: 'https://example.com/a' });
    parseArticleByUrl.mockResolvedValue({ ok: true, duplicate: false, article: { id: 42 } });

    render(<SavePage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/reader/42'));
    expect(parseArticleByUrl).toHaveBeenCalledWith('https://example.com/a');
    expect(screen.getByTestId('save-opening')).toBeTruthy();
    // Nothing on screen can interrupt the redirect
    expect(screen.queryByText('Save another')).toBeNull();
  });

  it('shows an error if opening the article throws', async () => {
    searchParams = new URLSearchParams({ url: 'https://example.com/nav-fail' });
    parseArticleByUrl.mockResolvedValue({ ok: true, duplicate: false, article: { id: 9 } });
    replace.mockImplementation(() => {
      throw new Error('navigation failed');
    });

    render(<SavePage />);

    await screen.findByText(/network error/i);
  });

  it('opens the existing article when the shared URL is already saved', async () => {
    searchParams = new URLSearchParams({ url: 'https://example.com/dup' });
    parseArticleByUrl.mockResolvedValue({ ok: false, duplicate: true, existingId: 7 });

    render(<SavePage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/reader/7'));
  });

  it('extracts the URL from shared text and saves it', async () => {
    searchParams = new URLSearchParams({
      title: 'Nice post',
      text: 'Nice post https://example.com/from-text',
    });
    parseArticleByUrl.mockResolvedValue({ ok: true, duplicate: false, article: { id: 3 } });

    render(<SavePage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/reader/3'));
    expect(parseArticleByUrl).toHaveBeenCalledWith('https://example.com/from-text');
  });

  it('does not navigate when a shared save fails', async () => {
    searchParams = new URLSearchParams({ url: 'https://example.com/broken' });
    parseArticleByUrl.mockResolvedValue({ ok: false, duplicate: false, error: 'Boom' });

    render(<SavePage />);

    await screen.findByText('Boom');
    expect(replace).not.toHaveBeenCalled();
  });

  it('stays on the page after a manual save', async () => {
    parseArticleByUrl.mockResolvedValue({ ok: true, duplicate: false, article: { id: 5 } });

    render(<SavePage />);
    fireEvent.change(screen.getByTestId('save-url-input'), {
      target: { value: 'https://example.com/manual' },
    });
    fireEvent.click(screen.getByTestId('save-submit-button'));

    await screen.findByText('Saved!');
    expect(screen.getByTestId('save-open-link')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('save-opening')).toBeNull();
  });
});
