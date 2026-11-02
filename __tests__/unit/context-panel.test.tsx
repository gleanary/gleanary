/** @vitest-environment jsdom */
import { createContext, useContext } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AppShell } from '@/components/layout/app-shell';
import { ContextPanelPortal } from '@/components/layout/context-panel';
import { ContextPanelTrigger } from '@/components/layout/context-panel-trigger';
import type { SidebarData } from '@/components/layout/sidebar';
import type { ContextPanelTab } from '@/types';

// The real Sidebar needs router/search params and server data; a stub that drives the
// real sidebar store through useSidebar() is enough to exercise mutual exclusion.
vi.mock('@/components/layout/sidebar', async () => {
  const { useSidebar } = await import('@/components/layout/sidebar-context');
  function StubSidebar() {
    const { isOpen, open, toggle } = useSidebar();
    return (
      <div data-testid="sidebar" data-open={String(isOpen)}>
        <button onClick={open}>open sidebar</button>
        <button onClick={toggle}>toggle sidebar</button>
      </div>
    );
  }
  return { SIDEBAR_WIDTH: 280, Sidebar: StubSidebar };
});
vi.mock('@/components/search/search-palette', () => ({ SearchPalette: () => null }));

// Controllable matchMedia('(min-width: 768px)') (jsdom has none).
let isDesktop = true;
const mediaListeners = new Set<() => void>();
function setDesktop(value: boolean) {
  isDesktop = value;
  act(() => mediaListeners.forEach((cb) => cb()));
}

// Stands in for ArticleProvider: provided above the portal but below the shell.
const ProbeContext = createContext('outside');
function ProbeReader() {
  return <span data-testid="probe">{useContext(ProbeContext)}</span>;
}

const TABS: ContextPanelTab[] = [
  {
    id: 'details',
    label: 'Details',
    sections: [{ id: 'about', label: 'About', content: <ProbeReader /> }],
  },
];

function Page({ withPanel = true, withTrigger = true }) {
  return (
    <main>
      {withTrigger && <ContextPanelTrigger />}
      <button>outside</button>
      {withPanel && (
        <ProbeContext.Provider value="article-1">
          <ContextPanelPortal title="Details" tabs={TABS} />
        </ProbeContext.Provider>
      )}
    </main>
  );
}

function renderShell(props: { withPanel?: boolean; withTrigger?: boolean } = {}) {
  const result = render(
    <AppShell sidebarData={{} as SidebarData}>
      <Page {...props} />
    </AppShell>,
  );
  return {
    rerender: (next: { withPanel?: boolean; withTrigger?: boolean }) =>
      result.rerender(
        <AppShell sidebarData={{} as SidebarData}>
          <Page {...next} />
        </AppShell>,
      ),
  };
}

const panel = () => screen.getByTestId('context-panel');
const trigger = () => screen.getByRole('button', { name: 'Toggle details panel' });
const queryTrigger = () => screen.queryByRole('button', { name: 'Toggle details panel' });
const closeButton = () => within(panel()).getByRole('button', { name: 'Close details panel' });
const wrapper = () => screen.getByTestId('content-wrapper');
const sidebarOpen = () => screen.getByTestId('sidebar').getAttribute('data-open') === 'true';
const isPanelOpen = () => !panel().hasAttribute('inert') && !panel().hidden;

/** Mouse click (detail 1); a keyboard activation of a button dispatches detail 0. */
function mouseClick(el: Element) {
  fireEvent.click(el, { detail: 1 });
}

function pressPanelShortcut(target: Element | Window = window) {
  return fireEvent.keyDown(target, { key: '|', code: 'Backslash', metaKey: true, shiftKey: true });
}

beforeEach(() => {
  localStorage.clear();
  isDesktop = true;
  mediaListeners.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return isDesktop;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, cb: () => void) => mediaListeners.add(cb),
      removeEventListener: (_type: string, cb: () => void) => mediaListeners.delete(cb),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
});

describe('ContextPanel open state', () => {
  it('starts closed and toggles open and closed from the trigger', () => {
    renderShell();
    expect(isPanelOpen()).toBe(false);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-controls')).toBe('context-panel');

    mouseClick(trigger());
    expect(isPanelOpen()).toBe(true);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(wrapper().style.marginRight).toBe('320px');

    mouseClick(trigger());
    expect(isPanelOpen()).toBe(false);
    expect(wrapper().style.marginRight).toBe('');
  });

  it('closes from the X button', () => {
    renderShell();
    mouseClick(trigger());
    mouseClick(closeButton());
    expect(isPanelOpen()).toBe(false);
  });

  it('shows the registered title in the panel header', () => {
    renderShell();
    expect(within(panel()).getByRole('heading', { name: 'Details' })).toBeTruthy();
  });
});

describe('ContextPanel mutual exclusion with the sidebar', () => {
  it('opening the panel closes the sidebar and persists sidebar-open=false', () => {
    localStorage.setItem('sidebar-open', 'true');
    renderShell();
    expect(sidebarOpen()).toBe(true);

    mouseClick(trigger());
    expect(isPanelOpen()).toBe(true);
    expect(sidebarOpen()).toBe(false);
    expect(localStorage.getItem('sidebar-open')).toBe('false');
    expect(wrapper().style.marginLeft).toBe('');
  });

  it.each(['open sidebar', 'toggle sidebar'])(
    'opening the sidebar (%s) closes the panel',
    (name) => {
      renderShell();
      mouseClick(trigger());
      expect(isPanelOpen()).toBe(true);

      mouseClick(screen.getByRole('button', { name }));
      expect(sidebarOpen()).toBe(true);
      expect(isPanelOpen()).toBe(false);
      expect(wrapper().style.marginRight).toBe('');
    },
  );

  it('closing the panel does not reopen the sidebar', () => {
    localStorage.setItem('sidebar-open', 'true');
    renderShell();
    mouseClick(trigger());
    mouseClick(trigger());
    expect(isPanelOpen()).toBe(false);
    expect(sidebarOpen()).toBe(false);
  });
});

describe('ContextPanel keyboard shortcut', () => {
  it('Cmd+Shift+\\ (code Backslash) toggles the panel and not the sidebar', () => {
    renderShell();
    expect(pressPanelShortcut()).toBe(false);
    expect(isPanelOpen()).toBe(true);
    expect(sidebarOpen()).toBe(false);

    pressPanelShortcut();
    expect(isPanelOpen()).toBe(false);
    expect(sidebarOpen()).toBe(false);
  });

  it('Ctrl+Shift+\\ toggles the panel too', () => {
    renderShell();
    fireEvent.keyDown(window, { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true });
    expect(isPanelOpen()).toBe(true);
  });

  it('Cmd+\\ swaps the open panel for the sidebar', () => {
    renderShell();
    pressPanelShortcut();
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', metaKey: true });
    expect(sidebarOpen()).toBe(true);
    expect(isPanelOpen()).toBe(false);
  });

  it('does nothing when the page has no panel content', () => {
    renderShell({ withPanel: false });
    expect(pressPanelShortcut()).toBe(true);
    expect(wrapper().style.marginRight).toBe('');
  });
});

describe('ContextPanel content registration (portal)', () => {
  it('renders the sections into the shell slot with the page context available', () => {
    renderShell();
    const about = within(panel()).getByText('About');
    expect(about).toBeTruthy();
    expect(within(panel()).getByTestId('probe').textContent).toBe('article-1');
    // No tab bar for a single tab
    expect(within(panel()).queryByRole('tablist')).toBeNull();
  });

  it('renders a tab bar only when there is more than one tab', () => {
    const tabs: ContextPanelTab[] = [
      { id: 'a', label: 'First', sections: [{ id: 's1', label: 'One', content: 'one' }] },
      { id: 'b', label: 'Second', sections: [{ id: 's2', label: 'Two', content: 'two' }] },
    ];
    render(
      <AppShell sidebarData={{} as SidebarData}>
        <ContextPanelPortal title="Details" tabs={tabs} />
      </AppShell>,
    );
    const tablist = within(panel()).getByRole('tablist');
    expect(within(tablist).getAllByRole('tab')).toHaveLength(2);
    expect(within(panel()).getByText('one')).toBeTruthy();
    expect(within(panel()).queryByText('two')).toBeNull();
    fireEvent.click(within(tablist).getByRole('tab', { name: 'Second' }));
    expect(within(panel()).getByText('two')).toBeTruthy();
  });

  it('hides the trigger and panel without content, and drops the margin even if open', () => {
    const { rerender } = renderShell();
    mouseClick(trigger());
    expect(wrapper().style.marginRight).toBe('320px');

    rerender({ withPanel: false });
    expect(queryTrigger()).toBeNull();
    expect(panel().hidden).toBe(true);
    expect(wrapper().style.marginRight).toBe('');
    expect(screen.queryByTestId('probe')).toBeNull();
  });

  it('hides the trigger when the page never registers content', () => {
    renderShell({ withPanel: false });
    expect(queryTrigger()).toBeNull();
    expect(panel().hidden).toBe(true);
  });
});

describe('ContextPanel presentation', () => {
  it('closes when the viewport crosses to mobile and stays closed back on desktop', () => {
    renderShell();
    mouseClick(trigger());
    expect(isPanelOpen()).toBe(true);

    setDesktop(false);
    expect(queryTrigger()).toBeNull();
    expect(panel().hidden).toBe(true);
    expect(wrapper().style.marginRight).toBe('');

    setDesktop(true);
    expect(isPanelOpen()).toBe(false);
  });

  it('ignores the shortcut on mobile in this session', () => {
    isDesktop = false;
    renderShell();
    pressPanelShortcut();
    expect(wrapper().style.marginRight).toBe('');
  });
});

describe('ContextPanel Escape', () => {
  it('closes the panel, prevents default and focuses the trigger when focus is inside', () => {
    renderShell();
    mouseClick(trigger());
    closeButton().focus();

    expect(fireEvent.keyDown(document.activeElement!, { key: 'Escape' })).toBe(false);
    expect(isPanelOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it('does nothing when focus is outside the panel', () => {
    renderShell();
    mouseClick(trigger());
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();

    expect(fireEvent.keyDown(outside, { key: 'Escape' })).toBe(true);
    expect(isPanelOpen()).toBe(true);
    expect(document.activeElement).toBe(outside);
  });
});

describe('ContextPanel focus', () => {
  it('returns focus to the trigger when closed via the X button', () => {
    renderShell();
    mouseClick(trigger());
    closeButton().focus();
    fireEvent.click(closeButton(), { detail: 0 });
    expect(document.activeElement).toBe(trigger());
  });

  it('returns focus to the trigger when closed via the shortcut with focus inside', () => {
    renderShell();
    mouseClick(trigger());
    closeButton().focus();
    pressPanelShortcut(closeButton());
    expect(isPanelOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it('returns focus to <main> when there is no trigger', () => {
    renderShell({ withTrigger: false });
    pressPanelShortcut();
    closeButton().focus();
    mouseClick(closeButton());
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  it('opening via the shortcut does not move focus', () => {
    renderShell();
    const outside = screen.getByRole('button', { name: 'outside' });
    outside.focus();
    pressPanelShortcut(outside);
    expect(isPanelOpen()).toBe(true);
    expect(document.activeElement).toBe(outside);
  });

  it('a keyboard activation of the trigger focuses the close button', () => {
    renderShell();
    trigger().focus();
    fireEvent.click(trigger(), { detail: 0 });
    expect(isPanelOpen()).toBe(true);
    expect(document.activeElement).toBe(closeButton());
  });

  it('a mouse click on the trigger does not move focus into the panel', () => {
    renderShell();
    trigger().focus();
    mouseClick(trigger());
    expect(isPanelOpen()).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });
});
