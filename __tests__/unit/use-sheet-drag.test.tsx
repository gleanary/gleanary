/** @vitest-environment jsdom */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  DISMISS_DISTANCE_RATIO,
  DISMISS_VELOCITY,
  shouldDismissSheet,
  useSheetDrag,
} from '@/hooks/use-sheet-drag';

describe('shouldDismissSheet', () => {
  const height = 400;

  it('uses the documented thresholds', () => {
    expect(DISMISS_DISTANCE_RATIO).toBe(0.25);
    expect(DISMISS_VELOCITY).toBe(0.5);
  });

  it('dismisses past 25% of the sheet height, even when slow', () => {
    expect(shouldDismissSheet({ dy: 101, height, velocity: 0 })).toBe(true);
  });

  it('does not dismiss just below the distance threshold when slow', () => {
    expect(shouldDismissSheet({ dy: 99, height, velocity: 0.1 })).toBe(false);
  });

  it('dismisses a fast downward flick over a short distance', () => {
    expect(shouldDismissSheet({ dy: 20, height, velocity: 0.6 })).toBe(true);
  });

  it('does not dismiss just below the velocity threshold', () => {
    expect(shouldDismissSheet({ dy: 20, height, velocity: 0.49 })).toBe(false);
  });

  it('does not dismiss a fast jitter below the minimum distance (a tap)', () => {
    expect(shouldDismissSheet({ dy: 2, height, velocity: 0.7 })).toBe(false);
    expect(shouldDismissSheet({ dy: 9, height, velocity: 2 })).toBe(false);
  });

  it('never dismisses an upward (or zero) drag', () => {
    expect(shouldDismissSheet({ dy: 0, height, velocity: 2 })).toBe(false);
    expect(shouldDismissSheet({ dy: -150, height, velocity: -2 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hook behavior: a minimal sheet (handle with a button, scrollable body)
// ---------------------------------------------------------------------------

const SHEET_HEIGHT = 400;
let now = 0;

function Harness({ onDismiss }: { onDismiss: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [bodyEl, setBodyEl] = useState<HTMLDivElement | null>(null);
  const { handleProps } = useSheetDrag({ sheetRef, bodyEl, onDismiss });
  return (
    <>
      <div ref={sheetRef} data-testid="sheet">
        <div data-testid="handle" {...handleProps}>
          <button type="button">close</button>
        </div>
        <div ref={setBodyEl} data-testid="body" />
      </div>
      {/* Like the panel's sections: portaled in from outside the sheet's React tree */}
      {bodyEl && createPortal(<p data-testid="portaled">section</p>, bodyEl)}
    </>
  );
}

function setup() {
  const onDismiss = vi.fn();
  render(<Harness onDismiss={onDismiss} />);
  const sheet = screen.getByTestId('sheet');
  vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue({
    height: SHEET_HEIGHT,
  } as DOMRect);
  return {
    onDismiss,
    sheet,
    handle: screen.getByTestId('handle'),
    body: screen.getByTestId('body'),
    portaled: () => screen.getByTestId('portaled'),
  };
}

function at(ms: number) {
  now = ms;
}

function setScrollTop(el: HTMLElement, value: number) {
  Object.defineProperty(el, 'scrollTop', { configurable: true, value });
}

function touch(clientY: number) {
  return [{ clientX: 100, clientY }];
}

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useSheetDrag: handle and header (pointer events)', () => {
  it('follows the pointer down, clamped at 0 when dragging up', () => {
    const { sheet, handle } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'touch', clientY: 100 });
    expect(Element.prototype.setPointerCapture).toHaveBeenCalledWith(1);

    at(500);
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientY: 150 });
    expect(sheet.style.transform).toBe('translateY(50px)');
    expect(sheet.style.transition).toBe('none');

    at(1000);
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientY: 60 });
    expect(sheet.style.transform).toBe('translateY(0px)');
  });

  it('dismisses on release past 25% of the sheet height', () => {
    const { onDismiss, handle } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'mouse', clientY: 100 });
    at(1000);
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'mouse', clientY: 220 });
    at(2000);
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: 'mouse', clientY: 220 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each([
    [true, '120px'],
    [false, ''],
  ])('reduced motion %s: the exit keyframe ends at the release point (%s)', (reduce, exitY) => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: reduce })),
    );
    const { onDismiss, sheet, handle } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'mouse', clientY: 100 });
    at(1000);
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'mouse', clientY: 220 });
    at(2000);
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: 'mouse', clientY: 220 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Without slide-out-to-bottom, tw-animate-css's exit would snap back to 0 while fading;
    // with motion, the slide-out class's 100% must win (no inline override)
    expect(sheet.style.getPropertyValue('--tw-exit-translate-y')).toBe(exitY);
    vi.unstubAllGlobals();
  });

  it('dismisses a fast short flick', () => {
    const { onDismiss, handle } = setup();
    at(0);
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'touch', clientY: 100 });
    at(20);
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientY: 115 });
    at(50);
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientY: 140 });
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: 'touch', clientY: 140 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('springs back on a slow short drag', () => {
    const { onDismiss, sheet, handle } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'touch', clientY: 100 });
    at(1000);
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientY: 150 });
    at(2000);
    fireEvent.pointerUp(handle, { pointerId: 1, pointerType: 'touch', clientY: 150 });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
    expect(sheet.style.transition).toContain('200ms');
  });

  it('springs back on pointercancel', () => {
    const { onDismiss, sheet, handle } = setup();
    fireEvent.pointerDown(handle, { pointerId: 1, pointerType: 'touch', clientY: 100 });
    at(100);
    fireEvent.pointerMove(handle, { pointerId: 1, pointerType: 'touch', clientY: 350 });
    fireEvent.pointerCancel(handle, { pointerId: 1, pointerType: 'touch' });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('does not start a drag from a button in the header (its click must land)', () => {
    const { onDismiss, sheet } = setup();
    const button = screen.getByRole('button', { name: 'close' });
    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'mouse', clientY: 100 });
    at(1000);
    fireEvent.pointerMove(button, { pointerId: 1, pointerType: 'mouse', clientY: 300 });
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'mouse', clientY: 300 });
    expect(Element.prototype.setPointerCapture).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('useSheetDrag: body (native touch path)', () => {
  it('at scrollTop 0, a downward touchmove is prevented and drives the drag', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 0);
    fireEvent.touchStart(body, { touches: touch(100) });
    at(1000);
    const notPrevented = fireEvent.touchMove(body, { touches: touch(160) });
    expect(notPrevented).toBe(false);
    expect(sheet.style.transform).toBe('translateY(60px)');

    at(1500);
    fireEvent.touchMove(body, { touches: touch(260) });
    at(2500);
    fireEvent.touchEnd(body, { changedTouches: touch(260) });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a second finger during a touch drag cancels it (springs back, no dismiss)', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 0);
    fireEvent.touchStart(body, { touches: touch(100) });
    at(1000);
    fireEvent.touchMove(body, { touches: touch(260) });
    expect(sheet.style.transform).toBe('translateY(160px)');

    fireEvent.touchStart(body, { touches: [...touch(260), { clientX: 200, clientY: 300 }] });
    expect(sheet.style.transform).toBe('');
    expect(sheet.style.transition).not.toBe('none');
    // The rest of the gesture is left to native scrolling
    expect(fireEvent.touchMove(body, { touches: touch(400) })).toBe(true);
    fireEvent.touchEnd(body, { changedTouches: touch(400) });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('a mostly horizontal swipe at the top is left to native scrolling', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 0);
    fireEvent.touchStart(body, { touches: [{ clientX: 100, clientY: 100 }] });
    at(1000);
    expect(fireEvent.touchMove(body, { touches: [{ clientX: 160, clientY: 105 }] })).toBe(true);
    expect(fireEvent.touchMove(body, { touches: [{ clientX: 220, clientY: 200 }] })).toBe(true);
    fireEvent.touchEnd(body, { changedTouches: [{ clientX: 220, clientY: 200 }] });
    expect(sheet.style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('springs back on a short slow touch drag', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 0);
    fireEvent.touchStart(body, { touches: touch(100) });
    at(1000);
    fireEvent.touchMove(body, { touches: touch(140) });
    at(2000);
    fireEvent.touchEnd(body, { changedTouches: touch(140) });
    expect(onDismiss).not.toHaveBeenCalled();
    expect(sheet.style.transform).toBe('');
  });

  it('with the body scrolled, a downward touchmove scrolls natively (no drag)', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 120);
    fireEvent.touchStart(body, { touches: touch(100) });
    at(1000);
    expect(fireEvent.touchMove(body, { touches: touch(300) })).toBe(true);
    // Reaching the top mid-gesture does not turn the scroll into a dismiss
    setScrollTop(body, 0);
    expect(fireEvent.touchMove(body, { touches: touch(400) })).toBe(true);
    fireEvent.touchEnd(body, { changedTouches: touch(400) });
    expect(sheet.style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('an upward touchmove at the top scrolls natively (no drag)', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 0);
    fireEvent.touchStart(body, { touches: touch(300) });
    expect(fireEvent.touchMove(body, { touches: touch(200) })).toBe(true);
    expect(fireEvent.touchMove(body, { touches: touch(500) })).toBe(true);
    fireEvent.touchEnd(body, { changedTouches: touch(500) });
    expect(sheet.style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('useSheetDrag: body (pointer path)', () => {
  it('ignores touch-type pointer events (the touch listener owns touch input)', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 0);
    fireEvent.pointerDown(body, { pointerId: 1, pointerType: 'touch', clientY: 100 });
    at(1000);
    fireEvent.pointerMove(body, { pointerId: 1, pointerType: 'touch', clientY: 300 });
    fireEvent.pointerUp(body, { pointerId: 1, pointerType: 'touch', clientY: 300 });
    expect(sheet.style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('a mouse drag down from the top of the body dismisses', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 0);
    fireEvent.pointerDown(body, { pointerId: 1, pointerType: 'mouse', clientY: 100, button: 0 });
    at(1000);
    fireEvent.pointerMove(body, { pointerId: 1, pointerType: 'mouse', clientY: 180, buttons: 1 });
    expect(sheet.style.transform).toBe('translateY(80px)');
    at(1500);
    fireEvent.pointerMove(body, { pointerId: 1, pointerType: 'mouse', clientY: 300, buttons: 1 });
    at(2500);
    fireEvent.pointerUp(body, { pointerId: 1, pointerType: 'mouse', clientY: 300 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a mouse drag starting on portaled content dismisses', () => {
    const { onDismiss, sheet, body, portaled } = setup();
    setScrollTop(body, 0);
    const target = portaled();
    fireEvent.pointerDown(target, { pointerId: 1, pointerType: 'mouse', clientY: 100, button: 0 });
    at(1000);
    fireEvent.pointerMove(target, { pointerId: 1, pointerType: 'mouse', clientY: 180, buttons: 1 });
    expect(sheet.style.transform).toBe('translateY(80px)');
    at(2000);
    fireEvent.pointerUp(target, { pointerId: 1, pointerType: 'mouse', clientY: 300 });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a hover move after a press released outside the body starts no drag', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 0);
    fireEvent.pointerDown(body, { pointerId: 1, pointerType: 'mouse', clientY: 100, button: 0 });
    // Released outside the body: no pointerup reaches it. Later, a hover (no button)
    at(1000);
    fireEvent.pointerMove(body, { pointerId: 1, pointerType: 'mouse', clientY: 200, buttons: 0 });
    expect(sheet.style.transform).toBe('');
    fireEvent.pointerUp(body, { pointerId: 1, pointerType: 'mouse', clientY: 200 });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('a mouse drag on a scrolled body does not start a drag', () => {
    const { onDismiss, sheet, body } = setup();
    setScrollTop(body, 50);
    fireEvent.pointerDown(body, { pointerId: 1, pointerType: 'mouse', clientY: 100, button: 0 });
    at(1000);
    fireEvent.pointerMove(body, { pointerId: 1, pointerType: 'mouse', clientY: 300, buttons: 1 });
    fireEvent.pointerUp(body, { pointerId: 1, pointerType: 'mouse', clientY: 300 });
    expect(sheet.style.transform).toBe('');
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
