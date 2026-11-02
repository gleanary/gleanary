'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import * as DialogPrimitive from 'radix-ui/dialog';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import { useSheetDrag } from '@/hooks/use-sheet-drag';
import {
  CONTEXT_PANEL_SHEET_ID,
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

/** Returns focus to the panel trigger, or to `<main>` when the page has none. */
function returnFocus(trigger: HTMLElement | null): void {
  if (trigger) trigger.focus({ preventScroll: true });
  else focusMain();
}

/** Shared close (X) button styling of both presentations. */
const CLOSE_BUTTON_CLASS =
  'text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-transparent dark:hover:bg-transparent';

/**
 * The context panel shell, rendered once by `AppShell`, in one of two presentations, each
 * with a header (registered title + close button) and a body slot that pages portal their
 * tabs into (see {@link ContextPanelPortal}):
 * - ≥ `md`: a non-modal push side sheet (`<aside>`), always mounted;
 * - < `md`: a modal bottom sheet (Radix Dialog), only on pages with content.
 * @returns The side sheet, plus the bottom sheet on mobile
 */
export function ContextPanel() {
  const { presentation, hasContent } = useContextPanel();
  return (
    <>
      <ContextPanelSide />
      {presentation === 'bottom' && hasContent && <ContextPanelSheet />}
    </>
  );
}

/**
 * Desktop push side sheet. It stays mounted; while closed it is off-screen and `inert`,
 * and it is hidden on pages without content and below `md`. Its body slot is mounted only
 * on desktop, so it never competes with the bottom sheet's slot.
 */
function ContextPanelSide() {
  const {
    isVisible: isShown,
    close,
    contentTitle,
    isAvailable,
    presentation,
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
        returnFocus(triggerRef.current);
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
        // Reduced motion: no slide, in step with the content wrapper's instant margin
        'motion-reduce:transition-none',
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
          className={CLOSE_BUTTON_CLASS}
        >
          <X className="size-4" />
        </Button>
      </div>
      {presentation === 'side' && (
        <div ref={setSlotEl} className="flex-1 overflow-y-auto px-4 pb-4" />
      )}
    </aside>
  );
}

/**
 * Mobile modal bottom sheet (Radix Dialog primitives: focus trap, Escape, backdrop tap,
 * scroll lock, `aria-modal`). Above everything in the reader (`z-[80]`). Swipe down on the
 * handle, the header, or the body when it is scrolled to the top to dismiss. Its body is
 * the panel slot while open (Radix unmounts it when closed, so the slot is then null).
 */
function ContextPanelSheet() {
  const { isSheetOpen, close, contentTitle, slotEl, setSlotEl, triggerRef } = useContextPanel();
  const sheetRef = useRef<HTMLDivElement>(null);
  // On mobile the side sheet mounts no slot, so `slotEl` is this sheet's body
  const { handleProps } = useSheetDrag({ sheetRef, bodyEl: slotEl, onDismiss: close });

  return (
    <Dialog open={isSheetOpen} onOpenChange={(open) => !open && close()}>
      <DialogPortal>
        <DialogOverlay data-testid="context-panel-sheet-overlay" className="z-[80]" />
        <DialogPrimitive.Content
          ref={sheetRef}
          id={CONTEXT_PANEL_SHEET_ID}
          data-testid="context-panel-sheet"
          aria-describedby={undefined}
          // Focus goes back to the trigger (or <main>), not to whatever had it before
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocus(triggerRef.current);
          }}
          className={cn(
            'border-sidebar-border fixed inset-x-0 bottom-0 z-[80] flex max-h-[85dvh] flex-col rounded-t-lg border-t outline-none',
            'bg-sidebar text-sidebar-foreground pb-[env(safe-area-inset-bottom)]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out duration-250 ease-out',
            // Reduced motion: an opacity fade in place of the slide
            'motion-safe:data-[state=open]:slide-in-from-bottom motion-safe:data-[state=closed]:slide-out-to-bottom',
            'motion-reduce:data-[state=open]:fade-in-0 motion-reduce:data-[state=closed]:fade-out-0',
          )}
        >
          <div
            data-testid="context-panel-sheet-handle"
            className="flex touch-none justify-center pt-2 pb-1"
            {...handleProps}
          >
            <div aria-hidden="true" className="bg-sidebar-foreground/20 h-1 w-10 rounded-full" />
          </div>
          <div
            className="flex min-h-12 touch-none items-center justify-between gap-2 px-4 py-1"
            {...handleProps}
          >
            <DialogTitle className="truncate text-sm">{contentTitle}</DialogTitle>
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close details panel"
                className={CLOSE_BUTTON_CLASS}
              >
                <X className="size-4" />
              </Button>
            </DialogClose>
          </div>
          <div
            ref={setSlotEl}
            data-testid="context-panel-sheet-body"
            className="flex-1 touch-pan-y overflow-y-auto overscroll-contain px-4 pb-4"
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
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
