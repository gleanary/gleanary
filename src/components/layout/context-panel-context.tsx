'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode, RefObject } from 'react';
import { usePathname } from 'next/navigation';
import { useSidebar } from './sidebar-context';

/** Width of the desktop side sheet, in px. */
export const CONTEXT_PANEL_WIDTH = 320;

/** DOM id of the mobile sheet's dialog content (the trigger's `aria-controls` on mobile). */
export const CONTEXT_PANEL_SHEET_ID = 'context-panel-sheet';

/** Same breakpoint as Tailwind `md` (the left sidebar's backdrop breakpoint). */
const DESKTOP_QUERY = '(min-width: 768px)';

type ContextPanelPresentation = 'side' | 'bottom';

interface ContextPanelOpenOptions {
  /** Move focus to the panel's close button (keyboard activation of the trigger only). */
  focusPanel?: boolean;
}

interface ContextPanelContextValue {
  /**
   * Whether the panel of the current presentation is open. In memory: on desktop it
   * survives client navigation and resets on reload; crossing `md` closes it.
   */
  isOpen: boolean;
  /** `isOpen` on mobile (the modal sheet). Starts closed and closes on every route change. */
  isSheetOpen: boolean;
  /** Opens the panel of the current presentation (side sheet or bottom sheet). */
  open: (options?: ContextPanelOpenOptions) => void;
  /** Closes the panel. */
  close: () => void;
  /** Toggles the panel of the current presentation. */
  toggle: (options?: ContextPanelOpenOptions) => void;
  /** 'side' (≥ md) or 'bottom' (< md); derived from matchMedia, never stored. */
  presentation: ContextPanelPresentation;
  /** Header title registered by the current page; null = the page has no context panel. */
  contentTitle: string | null;
  setContentTitle: (title: string | null) => void;
  /** Whether the page registered content (drives the trigger and shortcut on both presentations). */
  hasContent: boolean;
  /** Whether the side sheet can be shown (content registered, desktop presentation). */
  isAvailable: boolean;
  /** Whether the side sheet is actually shown (open and available): drives the push margin. */
  isVisible: boolean;
  /** Changes whenever the effective left/right content margins change. */
  layoutKey: string;
  /** Body slot of the mounted presentation (side sheet, or the open bottom sheet); pages portal their tabs into it. */
  slotEl: HTMLDivElement | null;
  setSlotEl: (el: HTMLDivElement | null) => void;
  /** Set by an open that asked for focus; consumed (and cleared) by the shell. */
  focusRequestRef: RefObject<boolean>;
  /** The trigger button, where focus returns when the panel closes. */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** AppShell's content wrapper (its margin transition ends the place-keeping restore). */
  contentWrapperRef: RefObject<HTMLDivElement | null>;
  /** True while a modal (mobile) sheet is open; AppShell's swipe ignores gestures then. */
  isSheetOpenRef: RefObject<boolean>;
}

const ContextPanelContext = createContext<ContextPanelContextValue | null>(null);

function subscribeToViewport(callback: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

function getPresentation(): ContextPanelPresentation {
  if (typeof window.matchMedia !== 'function') return 'side';
  return window.matchMedia(DESKTOP_QUERY).matches ? 'side' : 'bottom';
}

function getServerPresentation(): ContextPanelPresentation {
  return 'side';
}

/**
 * Provides the context panel state. Must be mounted inside `SidebarProvider`: opening the
 * panel closes the sidebar (persisted as usual), and the sidebar going from closed to
 * open — by any entry point, since all of them write the one sidebar store — closes the
 * panel. Crossing `md` either way while open closes it too, and a route change closes the
 * mobile sheet (the desktop flag survives navigation).
 * @param props.children - The app shell and pages
 * @returns Context provider wrapping children
 */
export function ContextPanelProvider({ children }: { children: ReactNode }) {
  const { isOpen: isSidebarOpen, close: closeSidebar } = useSidebar();
  const presentation = useSyncExternalStore(
    subscribeToViewport,
    getPresentation,
    getServerPresentation,
  );
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [contentTitle, setContentTitle] = useState<string | null>(null);
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const focusRequestRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentWrapperRef = useRef<HTMLDivElement | null>(null);
  const isSheetOpenRef = useRef(false);

  // Adjust state when an input changes, during render (no effect, no extra paint): the
  // sidebar opening or the viewport crossing `md` (either way) closes the panel, and a
  // route change, or the page dropping its content, closes the mobile sheet (mobile always
  // starts closed). Crossing closes the
  // panel, so one flag serves both presentations.
  const hasContent = contentTitle !== null;
  const [prevInputs, setPrevInputs] = useState({
    isSidebarOpen,
    presentation,
    pathname,
    hasContent,
  });
  if (
    prevInputs.isSidebarOpen !== isSidebarOpen ||
    prevInputs.presentation !== presentation ||
    prevInputs.pathname !== pathname ||
    prevInputs.hasContent !== hasContent
  ) {
    setPrevInputs({ isSidebarOpen, presentation, pathname, hasContent });
    const sidebarOpened = isSidebarOpen && !prevInputs.isSidebarOpen;
    const crossed = presentation !== prevInputs.presentation;
    // The modal sheet never outlives its page or its content (else it would pop back open)
    const sheetLeft =
      presentation === 'bottom' && (pathname !== prevInputs.pathname || !hasContent);
    if (isOpen && (sidebarOpened || crossed || sheetLeft)) setIsOpen(false);
  }

  const isSheetOpen = isOpen && presentation === 'bottom';

  // AppShell's swipe handler reads this ref (a stable listener, no re-subscription)
  useLayoutEffect(() => {
    isSheetOpenRef.current = isSheetOpen;
  }, [isSheetOpen]);

  const open = useCallback(
    (options?: ContextPanelOpenOptions) => {
      // Focus moves into the non-modal side sheet only on request; the modal sheet
      // takes focus itself (Radix)
      focusRequestRef.current = presentation === 'side' && !!options?.focusPanel;
      closeSidebar();
      setIsOpen(true);
    },
    [closeSidebar, presentation],
  );
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(
    (options?: ContextPanelOpenOptions) => (isOpen ? close() : open(options)),
    [isOpen, open, close],
  );

  const isAvailable = hasContent && presentation === 'side';
  const isVisible = isOpen && isAvailable;
  const layoutKey = `${isSidebarOpen ? 'left' : ''}|${isVisible ? 'right' : ''}`;

  const value = useMemo(
    () => ({
      isOpen,
      isSheetOpen,
      open,
      close,
      toggle,
      presentation,
      contentTitle,
      setContentTitle,
      hasContent,
      isAvailable,
      isVisible,
      layoutKey,
      slotEl,
      setSlotEl,
      focusRequestRef,
      triggerRef,
      contentWrapperRef,
      isSheetOpenRef,
    }),
    [
      isOpen,
      isSheetOpen,
      open,
      close,
      toggle,
      presentation,
      contentTitle,
      hasContent,
      isAvailable,
      isVisible,
      layoutKey,
      slotEl,
    ],
  );

  return <ContextPanelContext.Provider value={value}>{children}</ContextPanelContext.Provider>;
}

/**
 * Access the context panel state and actions. Must be used within `ContextPanelProvider`.
 * @returns The context panel context value
 */
export function useContextPanel(): ContextPanelContextValue {
  const ctx = useContext(ContextPanelContext);
  if (!ctx) {
    throw new Error('useContextPanel must be used within a ContextPanelProvider');
  }
  return ctx;
}

/**
 * Non-throwing variant of {@link useContextPanel} for components that also render
 * outside the app shell (e.g. `ArticleReader` in unit tests).
 * @returns The context panel context value, or null outside `ContextPanelProvider`
 */
export function useOptionalContextPanel(): ContextPanelContextValue | null {
  return useContext(ContextPanelContext);
}

/**
 * Registers the current page as having a context panel, titled `title`, for as long as
 * the calling component is mounted (null again on unmount, which hides the trigger).
 * @param title - Panel header title
 * @returns The shell's body slot element to portal content into (null until mounted)
 */
export function useContextPanelContent(title: string): HTMLDivElement | null {
  const { setContentTitle, slotEl } = useContextPanel();
  useEffect(() => {
    setContentTitle(title);
    return () => setContentTitle(null);
  }, [title, setContentTitle]);
  return slotEl;
}
