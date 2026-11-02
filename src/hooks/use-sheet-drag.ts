'use client';

import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

/** A release past this fraction of the sheet height dismisses it. */
export const DISMISS_DISTANCE_RATIO = 0.25;
/** A release faster than this (px/ms, downward) dismisses the sheet. */
export const DISMISS_VELOCITY = 0.5;
/** A velocity dismiss also needs this much travel, so a jittery tap never closes (px). */
export const DISMISS_MIN_DISTANCE = 10;
/** Release velocity is measured over the moves of this last window (ms). */
const VELOCITY_WINDOW_MS = 100;
/** A body gesture must travel this far before it is classified as drag or scroll (px). */
const BODY_SLOP_PX = 3;
const SPRING_BACK_TRANSITION = 'transform 200ms ease-out';

interface SheetDragRelease {
  /** Downward drag distance at release (px); ≤ 0 means up or no movement. */
  dy: number;
  /** Sheet height (px). */
  height: number;
  /** Downward velocity at release (px/ms); negative means moving up. */
  velocity: number;
}

interface SheetDragPointerHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

interface UseSheetDragOptions {
  /** The sheet element moved by the drag (`transform: translateY`). */
  sheetRef: RefObject<HTMLElement | null>;
  /** The scrollable body; drags start there only from the top and downward. */
  bodyEl: HTMLElement | null;
  /** Called when a release passes the dismiss thresholds. */
  onDismiss: () => void;
}

/**
 * Whether releasing a sheet drag should dismiss it: a downward drag past
 * {@link DISMISS_DISTANCE_RATIO} of the sheet height, or faster than {@link DISMISS_VELOCITY}
 * over at least {@link DISMISS_MIN_DISTANCE}.
 * @param release.dy - Downward drag distance (px)
 * @param release.height - Sheet height (px)
 * @param release.velocity - Downward release velocity (px/ms)
 * @returns True to dismiss, false to spring back
 */
export function shouldDismissSheet({ dy, height, velocity }: SheetDragRelease): boolean {
  if (dy <= 0) return false;
  return (
    dy > height * DISMISS_DISTANCE_RATIO ||
    (dy >= DISMISS_MIN_DISTANCE && velocity > DISMISS_VELOCITY)
  );
}

/** Body gesture classification: undecided until it moves past the slop, then fixed. */
type BodyGesture = 'pending' | 'drag' | 'scroll';

/**
 * The drag engine shared by every input path (handle/header pointer events, body touch
 * listener, body mouse pointer events). Holds the gesture state in a closure, so nothing
 * re-renders while dragging.
 */
function createSheetDrag() {
  // Wired up by the hook's effect (refs are only read outside render)
  let getSheet: () => HTMLElement | null = () => null;
  let dismiss: () => void = () => {};
  let active = false;
  let startY = 0;
  let dy = 0;
  let samples: { t: number; y: number }[] = [];
  let body: { state: BodyGesture; originX: number; originY: number } | null = null;

  function start(y: number) {
    const sheet = getSheet();
    if (!sheet) return;
    active = true;
    startY = y;
    dy = 0;
    samples = [{ t: performance.now(), y }];
    sheet.style.transition = 'none';
  }

  function move(y: number) {
    const sheet = getSheet();
    if (!active || !sheet) return;
    const t = performance.now();
    dy = Math.max(0, y - startY);
    samples.push({ t, y });
    while (samples.length > 2 && samples[0]!.t < t - VELOCITY_WINDOW_MS) samples.shift();
    sheet.style.transform = `translateY(${dy}px)`;
  }

  /** Ends the drag at `y` (null = cancelled: always springs back). */
  function end(y: number | null) {
    const sheet = getSheet();
    if (!active) return;
    if (y !== null) move(y);
    active = false;
    if (!sheet) return;
    const now = performance.now();
    const recent = samples.filter((s) => s.t >= now - VELOCITY_WINDOW_MS);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const velocity =
      first && last && last.t > first.t ? (last.y - first.y) / (last.t - first.t) : 0;
    const height = sheet.getBoundingClientRect().height;
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (y !== null && shouldDismissSheet({ dy, height, velocity })) {
      // The fade-out (no slide-out class) would otherwise end at translateY 0, sliding
      // the sheet back up. Not with motion: inline, it would beat slide-out's 100%
      if (reduceMotion) sheet.style.setProperty('--tw-exit-translate-y', `${dy}px`);
      dismiss();
      return;
    }
    // Spring back (an instant snap under reduced motion)
    sheet.style.transition = reduceMotion ? 'none' : SPRING_BACK_TRANSITION;
    sheet.style.transform = '';
  }

  /**
   * Classifies a body gesture once it passes the slop: a drag only from the top of the
   * body and mostly downward, a scroll otherwise (for the rest of the gesture).
   * @param getScrollTop - Read only while the gesture is undecided (no per-move layout read)
   * @returns Whether the gesture is (now) a drag
   */
  function classifyBody(x: number, y: number, getScrollTop: () => number): boolean {
    if (!body || body.state === 'scroll') return false;
    if (body.state === 'pending') {
      const dx = Math.abs(x - body.originX);
      const delta = y - body.originY;
      if (Math.max(dx, Math.abs(delta)) < BODY_SLOP_PX) return false;
      if (delta <= dx || getScrollTop() > 0) {
        body.state = 'scroll';
        return false;
      }
      body.state = 'drag';
      start(body.originY);
    }
    return true;
  }

  function releasePointer(e: ReactPointerEvent<HTMLElement>, y: number | null) {
    if (!active) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    end(y);
  }

  const handleProps: SheetDragPointerHandlers = {
    onPointerDown: (e) => {
      if (e.button !== 0) return;
      // Let buttons in the header (close) receive their click
      if ((e.target as Element).closest('button, a, input')) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      start(e.clientY);
    },
    onPointerMove: (e) => move(e.clientY),
    onPointerUp: (e) => releasePointer(e, e.clientY),
    onPointerCancel: (e) => releasePointer(e, null),
  };

  /**
   * Binds the body's touch and mouse paths as native listeners: React's `onTouchMove` is
   * passive (no `preventDefault`), and the body's content is portaled in from another
   * React tree, whose synthetic events never bubble to the body element.
   * @returns Cleanup removing the listeners
   */
  function bindBody(el: HTMLElement): () => void {
    const getScrollTop = () => el.scrollTop;
    const onTouchStart = (e: TouchEvent) => {
      // A second finger mid-drag cancels it (body becomes null below: native scrolling)
      if (body?.state === 'drag') end(null);
      const touch = e.touches[0];
      body =
        touch && e.touches.length === 1
          ? { state: 'pending', originX: touch.clientX, originY: touch.clientY }
          : null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch || !classifyBody(touch.clientX, touch.clientY, getScrollTop)) return;
      e.preventDefault();
      move(touch.clientY);
    };
    const onTouchEnd = (e: TouchEvent) => {
      const wasDrag = body?.state === 'drag';
      body = null;
      if (!wasDrag) return;
      const touch = e.changedTouches[0];
      end(e.type === 'touchcancel' || !touch ? null : touch.clientY);
    };

    // Mouse only: touch input is owned by the touch listeners above
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      body = { state: 'pending', originX: e.clientX, originY: e.clientY };
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      // No button held: a press that ended outside the body left a stale gesture
      if (!(e.buttons & 1)) {
        body = null;
        return;
      }
      const wasDragging = active;
      if (!classifyBody(e.clientX, e.clientY, getScrollTop)) return;
      if (!wasDragging) el.setPointerCapture(e.pointerId);
      move(e.clientY);
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      body = null;
      if (!active) return;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      end(e.type === 'pointercancel' ? null : e.clientY);
    };

    const listeners: [string, EventListener, AddEventListenerOptions][] = [
      ['touchstart', onTouchStart as EventListener, { passive: true }],
      ['touchmove', onTouchMove as EventListener, { passive: false }],
      ['touchend', onTouchEnd as EventListener, { passive: true }],
      ['touchcancel', onTouchEnd as EventListener, { passive: true }],
      ['pointerdown', onPointerDown as EventListener, {}],
      ['pointermove', onPointerMove as EventListener, {}],
      ['pointerup', onPointerEnd as EventListener, {}],
      ['pointercancel', onPointerEnd as EventListener, {}],
    ];
    listeners.forEach(([type, fn, opts]) => el.addEventListener(type, fn, opts));
    return () => listeners.forEach(([type, fn]) => el.removeEventListener(type, fn));
  }

  function configure(nextGetSheet: () => HTMLElement | null, nextDismiss: () => void) {
    getSheet = nextGetSheet;
    dismiss = nextDismiss;
  }

  return { handleProps, bindBody, configure };
}

/**
 * Swipe-to-dismiss for a bottom sheet. The sheet follows the finger (`translateY`, clamped
 * at 0) and, on release, either dismisses ({@link shouldDismissSheet}) or springs back.
 *
 * - **Handle and header** (spread `handleProps`; give them `touch-action: none`): pointer
 *   events of any type. Presses on a button are ignored so its click still lands.
 * - **Body, touch**: a native non-passive `touchmove` listener. A gesture that starts with
 *   the body at `scrollTop` 0 and moves down drives the drag (`preventDefault`); any other
 *   gesture is left alone for its whole duration, so the body scrolls natively.
 * - **Body, mouse**: native pointer listeners with the same gating, mouse only, so touch
 *   input is never handled twice. Native because the body's content is portaled in.
 *
 * @param options.sheetRef - The sheet element to move
 * @param options.bodyEl - The scrollable body element (null while unmounted)
 * @param options.onDismiss - Called when a release dismisses the sheet
 * @returns Pointer handlers for the handle and header
 */
export function useSheetDrag({ sheetRef, bodyEl, onDismiss }: UseSheetDragOptions): {
  handleProps: SheetDragPointerHandlers;
} {
  const [drag] = useState(createSheetDrag);

  useEffect(() => {
    drag.configure(() => sheetRef.current, onDismiss);
  }, [drag, sheetRef, onDismiss]);

  useEffect(() => (bodyEl ? drag.bindBody(bodyEl) : undefined), [drag, bodyEl]);

  return { handleProps: drag.handleProps };
}
