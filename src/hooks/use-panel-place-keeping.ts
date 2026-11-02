'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { clampScrollY, RESTORE_CANCEL_EVENTS } from '@/lib/scroll-progress';
import { getContentContainer } from '@/lib/reading-anchor';
import { capturePanelAnchor, panelAnchorToScrollY } from '@/lib/panel-anchor';
import { useOptionalTTS } from '@/components/reader/tts-provider';
import { useOptionalContextPanel } from '@/components/layout/context-panel-context';
import type { PanelAnchor } from '@/types';

/** A panel restore ends once the slide is over and layout has been quiet this long. */
const PANEL_RESTORE_QUIET_MS = 300;
/** Hard cap on a panel restore (e.g. when `transitionend` never fires). */
const PANEL_RESTORE_MAX_MS = 1_500;
/** Trailing programmatic scroll events after a panel restore stops are still ignored. */
const PANEL_TRANSITION_SETTLE_MS = 200;

/** Whether `el` has a zero computed `transition-duration` (e.g. `motion-reduce:transition-none`). */
function hasNoTransition(el: Element): boolean {
  return getComputedStyle(el)
    .transitionDuration.split(',')
    .every((duration) => parseFloat(duration) === 0);
}

/**
 * Keeps the reader's place when a side panel (context panel, sidebar) opens or closes
 * and the column width changes. Tracks the anchor at the viewport top while the reader
 * scrolls, then holds it there while the text reflows, until the slide is over and
 * layout is quiet. A no-op outside the app shell (no context panel provider).
 *
 * Call it after the mount scroll-restore effect is declared so these effects run after
 * it (e.g. the anchor is seeded in the frame after the restore scroll).
 *
 * The caller owns `isPanelTransitioning` (rather than receiving it back) so its own
 * effects declared before this call, such as progress tracking, can read it.
 *
 * @param options.mountRestoreRef - The mount scroll restore's stop function, set while it
 *   owns the position (its own observer handles the reflow, so a panel restore is skipped)
 * @param options.isPanelTransitioning - Ref this hook sets to `true` while a panel
 *   transition reflows the page; progress tracking should ignore scroll events while set
 */
export function usePanelPlaceKeeping({
  mountRestoreRef,
  isPanelTransitioning: isPanelTransitioningRef,
}: {
  mountRestoreRef: RefObject<(() => void) | null>;
  isPanelTransitioning: RefObject<boolean>;
}): void {
  // Place-keeping across side-panel width changes (null outside the app shell)
  const contextPanel = useOptionalContextPanel();
  const layoutKey = contextPanel?.layoutKey ?? null;
  const contentWrapperRef = contextPanel?.contentWrapperRef;
  const tts = useOptionalTTS();
  const isTTSPlaying = useRef(false);
  // Position at the viewport top, kept current by a throttled scroll listener
  const lastAnchor = useRef<PanelAnchor | null>(null);
  const stopPanelRestore = useRef<(() => void) | null>(null);
  const panelSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLayoutKey = useRef(layoutKey);

  // Last known anchor: captured on scroll (once per frame), seeded once after mount.
  // Frozen during a panel transition so reflow scrolls never overwrite it.
  const hasContextPanel = layoutKey !== null;
  useEffect(() => {
    if (!hasContextPanel) return;
    let rafId: number | null = null;
    const capture = () => {
      rafId = null;
      if (!isPanelTransitioningRef.current) lastAnchor.current = capturePanelAnchor();
    };
    const onScroll = () => {
      if (rafId === null) rafId = requestAnimationFrame(capture);
    };
    rafId = requestAnimationFrame(capture);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [hasContextPanel, isPanelTransitioningRef]);

  useLayoutEffect(() => {
    isTTSPlaying.current = tts?.status === 'playing';
  });

  // A side panel opened or closed: the column width changes and the text reflows. Keep
  // the last known anchor at the viewport top until the slide is over and layout is quiet
  // (PDF pages re-render after a debounced width update, well after transitionend).
  useLayoutEffect(() => {
    if (prevLayoutKey.current === layoutKey) return;
    prevLayoutKey.current = layoutKey;
    // The mount restore owns the position during its window (its observer handles the reflow)
    if (mountRestoreRef.current) return;
    // TTS auto-scroll owns the position while playing
    if (isTTSPlaying.current) return;
    const anchor = lastAnchor.current;
    if (!anchor) return;

    stopPanelRestore.current?.();
    if (panelSettleTimer.current) clearTimeout(panelSettleTimer.current);
    isPanelTransitioningRef.current = true;

    const wrapper = contentWrapperRef?.current ?? null;
    // No margin transition (reduced motion): transitionend never fires, so the slide is
    // already over and the quiet timer alone ends the restore
    let transitionEnded = wrapper !== null && hasNoTransition(wrapper);
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    const restore = () => {
      const top = panelAnchorToScrollY(anchor);
      if (top !== null) window.scrollTo({ top: clampScrollY(top), behavior: 'instant' });
    };
    const armQuietTimer = () => {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (transitionEnded) stop();
      }, PANEL_RESTORE_QUIET_MS);
    };
    const onResize = () => {
      restore();
      armQuietTimer();
    };
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target !== wrapper) return;
      transitionEnded = true;
      restore();
      armQuietTimer();
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
    const container = getContentContainer();
    if (container) observer?.observe(container);
    observer?.observe(document.documentElement);
    wrapper?.addEventListener('transitionend', onTransitionEnd);
    if (transitionEnded) armQuietTimer();
    const capTimer = setTimeout(stop, PANEL_RESTORE_MAX_MS);
    RESTORE_CANCEL_EVENTS.forEach((type) => window.addEventListener(type, stop, { passive: true }));

    function stop() {
      observer?.disconnect();
      wrapper?.removeEventListener('transitionend', onTransitionEnd);
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(capTimer);
      RESTORE_CANCEL_EVENTS.forEach((type) => window.removeEventListener(type, stop));
      stopPanelRestore.current = null;
      panelSettleTimer.current = setTimeout(() => {
        isPanelTransitioningRef.current = false;
      }, PANEL_TRANSITION_SETTLE_MS);
    }
    stopPanelRestore.current = stop;
  }, [layoutKey, contentWrapperRef, isPanelTransitioningRef, mountRestoreRef]);

  useEffect(
    () => () => {
      stopPanelRestore.current?.();
      if (panelSettleTimer.current) clearTimeout(panelSettleTimer.current);
    },
    [],
  );
}
