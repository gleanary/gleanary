'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  CONTEXT_PANEL_WIDTH,
  useContextPanel,
  useContextPanelContent,
} from './context-panel-context';
import type { ContextPanelTab } from '@/types';

/** Moves focus to `<main>` (made programmatically focusable if it is not already). */
function focusMain(): void {
  const main = document.querySelector<HTMLElement>('main');
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.tabIndex = -1;
  main.focus({ preventScroll: true });
}

/**
 * The context panel shell, rendered once by `AppShell`: a desktop push side sheet with a
 * header (registered title + close button) and a body slot that pages portal their tabs
 * into (see {@link ContextPanelPortal}). It stays mounted so the slot is stable; while
 * closed it is off-screen and `inert`, and it is hidden on pages without content and
 * below `md` (the mobile sheet comes in a later session).
 * @returns The panel `<aside>`
 */
export function ContextPanel() {
  const {
    isVisible: isShown,
    close,
    contentTitle,
    isAvailable,
    setSlotEl,
    focusRequestRef,
    triggerRef,
  } = useContextPanel();
  const asideRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasShown = useRef(false);
  const titleId = useId();

  // Focus in (keyboard trigger only) and out (every close). Runs before the browser's
  // focus fixup for the now-inert aside, so focus inside it is still observable here.
  useLayoutEffect(() => {
    if (isShown && !wasShown.current) {
      if (focusRequestRef.current) closeButtonRef.current?.focus({ preventScroll: true });
    } else if (!isShown && wasShown.current) {
      if (asideRef.current?.contains(document.activeElement)) {
        if (triggerRef.current) triggerRef.current.focus({ preventScroll: true });
        else focusMain();
      }
    }
    focusRequestRef.current = false;
    wasShown.current = isShown;
  }, [isShown, focusRequestRef, triggerRef]);

  // Escape with focus inside the panel closes it. Window capture runs before the
  // reader's document-capture handlers (highlight edit mode, TTS) and its bubble-phase
  // Escape-to-go-back, which all honor defaultPrevented.
  useEffect(() => {
    if (!isShown) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (!asideRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [isShown, close]);

  return (
    <aside
      ref={asideRef}
      id="context-panel"
      data-testid="context-panel"
      aria-labelledby={titleId}
      inert={!isShown}
      hidden={!isAvailable}
      style={{ width: CONTEXT_PANEL_WIDTH }}
      className={cn(
        'border-sidebar-border fixed inset-y-0 right-0 z-40 flex flex-col border-l',
        'bg-sidebar text-sidebar-foreground',
        'transition-transform duration-250 ease-out',
        isShown ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <div className="flex min-h-12 items-center justify-between gap-2 px-4 py-2">
        <h2 id={titleId} className="truncate text-sm font-semibold">
          {contentTitle}
        </h2>
        <Button
          ref={closeButtonRef}
          variant="ghost"
          size="icon-sm"
          onClick={close}
          aria-label="Close details panel"
          className="text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-transparent dark:hover:bg-transparent"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div ref={setSlotEl} className="flex-1 overflow-y-auto px-4 pb-4" />
    </aside>
  );
}

/**
 * Renders a page's tabs: a tab bar only when there is more than one tab, then the active
 * tab's sections in order, each under a small uppercase label.
 * @param props.tabs - The page's tabs
 * @returns The tab content
 */
export function ContextPanelTabs({ tabs }: { tabs: ContextPanelTab[] }) {
  const [activeId, setActiveId] = useState(tabs[0]?.id);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  if (!active) return null;

  return (
    <div className="flex flex-col gap-4">
      {tabs.length > 1 && (
        <div role="tablist" className="flex gap-1">
          {tabs.map((tab) => (
            <Button
              key={tab.id}
              role="tab"
              aria-selected={tab.id === active.id}
              variant="ghost"
              size="xs"
              onClick={() => setActiveId(tab.id)}
              className={cn(
                'text-sidebar-foreground/70 hover:text-sidebar-foreground font-normal',
                tab.id === active.id && 'bg-sidebar-accent text-sidebar-foreground',
              )}
            >
              {tab.label}
            </Button>
          ))}
        </div>
      )}
      {active.sections.map((section) => (
        <section key={section.id} className="flex flex-col gap-2">
          <h3 className="text-sidebar-foreground/50 text-xs font-semibold tracking-wider uppercase">
            {section.label}
          </h3>
          {section.content}
        </section>
      ))}
    </div>
  );
}

/**
 * Page-side entry point: registers the page as having a context panel and portals its
 * tabs into the shell's body slot. Because the React tree stays under the page, the
 * content keeps access to the page's providers (e.g. `ArticleProvider`, `TTSProvider`).
 * @param props.title - Panel header title
 * @param props.tabs - The page's tabs
 * @returns A portal into the panel slot (null until the slot is mounted)
 */
export function ContextPanelPortal({ title, tabs }: { title: string; tabs: ContextPanelTab[] }) {
  const slotEl = useContextPanelContent(title);
  return slotEl ? createPortal(<ContextPanelTabs tabs={tabs} />, slotEl) : null;
}
