/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { KnowledgeHealthPanel } from '@/components/chat/knowledge-health-panel';

const STORAGE_KEY = 'lint-panel-open';

const toggleButton = () => screen.getByRole('button', { name: /Knowledge Health/ });
const isOpen = () => toggleButton().getAttribute('aria-expanded') === 'true';

describe('KnowledgeHealthPanel localStorage persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('renders open after mount when lint-panel-open is "true"', () => {
    window.localStorage.setItem(STORAGE_KEY, 'true');

    render(<KnowledgeHealthPanel />);

    expect(isOpen()).toBe(true);
    expect(screen.getByText('Find Connections')).toBeTruthy();
  });

  it('renders closed when lint-panel-open is absent', () => {
    render(<KnowledgeHealthPanel />);

    expect(isOpen()).toBe(false);
    expect(screen.queryByText('Find Connections')).toBeNull();
  });

  it('renders closed when lint-panel-open holds anything other than "true"', () => {
    window.localStorage.setItem(STORAGE_KEY, 'false');

    render(<KnowledgeHealthPanel />);

    expect(isOpen()).toBe(false);
  });

  it('writes "true" then "false" as the panel is toggled', () => {
    render(<KnowledgeHealthPanel />);

    fireEvent.click(toggleButton());
    expect(isOpen()).toBe(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true');

    fireEvent.click(toggleButton());
    expect(isOpen()).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('server-renders closed even when the stored value is "true"', () => {
    window.localStorage.setItem(STORAGE_KEY, 'true');

    const html = renderToString(<KnowledgeHealthPanel />);

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Find Connections');
  });

  it('hydrates closed, then applies the stored value without a hydration mismatch', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'true');
    const container = document.createElement('div');
    container.innerHTML = renderToString(<KnowledgeHealthPanel />);
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverableErrors: unknown[] = [];

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <KnowledgeHealthPanel />, {
        onRecoverableError: (err) => recoverableErrors.push(err),
      });
    });

    expect(isOpen()).toBe(true);
    expect(recoverableErrors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();

    act(() => root?.unmount());
    container.remove();
  });

  it('falls back to closed without crashing when localStorage throws, and still toggles', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    render(<KnowledgeHealthPanel />);
    expect(isOpen()).toBe(false);

    fireEvent.click(toggleButton());
    expect(isOpen()).toBe(true);

    // Once storage works again, the next toggle persists normally (and resets any fallback).
    vi.restoreAllMocks();
    fireEvent.click(toggleButton());
    expect(isOpen()).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false');
  });
});
