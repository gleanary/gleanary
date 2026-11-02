/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { capturePanelAnchor, panelAnchorToScrollY } from '@/lib/panel-anchor';

// Layout model: element i sits at document y = START + i * SPACING (scaled by `scale`
// to mimic a reflow after a width change), each HEIGHT * scale tall. Rects derive from
// window.scrollY so they stay consistent with the scroll position the test sets.
const START = 200;
const SPACING = 500;
const HEIGHT = 400;
let scale = 1;

function setScrollY(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

function stubRects(elements: NodeListOf<HTMLElement>) {
  elements.forEach((el, i) => {
    el.getBoundingClientRect = () => {
      const top = (START + i * SPACING) * scale - window.scrollY;
      const height = HEIGHT * scale;
      return {
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });
}

function mountHtml(count = 5) {
  document.body.innerHTML = `<div class="article-content">${Array.from(
    { length: count },
    (_, i) => `<p>Paragraph ${i}</p>`,
  ).join('')}</div>`;
  stubRects(document.querySelectorAll<HTMLElement>('.article-content p'));
}

function mountPdf(count = 3) {
  document.body.innerHTML = `<div class="react-pdf__Document">${Array.from(
    { length: count },
    (_, i) => `<div data-page="${i + 1}" class="mb-2"><canvas></canvas></div>`,
  ).join('')}</div>`;
  stubRects(document.querySelectorAll<HTMLElement>('[data-page]'));
}

beforeEach(() => {
  scale = 1;
  setScrollY(0);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('capturePanelAnchor / panelAnchorToScrollY: HTML', () => {
  it('captures the block at the viewport top and how far it is scrolled past', () => {
    mountHtml();
    // block 2 spans 1200–1600; scrollY 1300 → 25% scrolled past
    setScrollY(1300);
    expect(capturePanelAnchor()).toEqual({ kind: 'html', block: 2, offset: 0.25, gap: 0 });
  });

  it('round-trips to the same scroll offset in the same layout', () => {
    mountHtml();
    setScrollY(1300);
    const anchor = capturePanelAnchor();
    setScrollY(0);
    expect(panelAnchorToScrollY(anchor!)).toBe(1300);
  });

  it('keeps the same point of the block at the viewport top after a reflow', () => {
    mountHtml();
    setScrollY(1300);
    const anchor = capturePanelAnchor();
    // Narrower column: everything 1.5× further down and taller
    scale = 1.5;
    // block 2 now spans 1800–2400; 25% into it → 1950
    expect(panelAnchorToScrollY(anchor!)).toBe(1950);
  });

  it('keeps the gap when the viewport top is between blocks', () => {
    mountHtml();
    // block 1 spans 700–1100, block 2 starts at 1200 → 50px gap at scrollY 1150
    setScrollY(1150);
    const anchor = capturePanelAnchor();
    expect(anchor).toEqual({ kind: 'html', block: 2, offset: 0, gap: 50 });
    setScrollY(0);
    expect(panelAnchorToScrollY(anchor!)).toBe(1150);
  });

  it('returns null at the very top of the page (nothing to keep)', () => {
    mountHtml();
    setScrollY(0);
    expect(capturePanelAnchor()).toBeNull();
  });

  it('returns null for an HTML anchor whose block no longer exists', () => {
    mountHtml(2);
    expect(panelAnchorToScrollY({ kind: 'html', block: 4, offset: 0, gap: 0 })).toBeNull();
  });
});

describe('capturePanelAnchor / panelAnchorToScrollY: PDF', () => {
  it('captures the [data-page] element at the viewport top and the fraction into it', () => {
    mountPdf();
    // page 2 spans 700–1100; scrollY 800 → 25% into it
    setScrollY(800);
    expect(capturePanelAnchor()).toEqual({ kind: 'pdf', page: 2, offset: 0.25, gap: 0 });
  });

  it('round-trips a page anchor across a reflow', () => {
    mountPdf();
    setScrollY(800);
    const anchor = capturePanelAnchor();
    scale = 2;
    // page 2 now spans 1400–2200; 25% into it → 1600
    expect(panelAnchorToScrollY(anchor!)).toBe(1600);
  });

  it('returns null for a page that is not in the DOM', () => {
    mountPdf(2);
    expect(panelAnchorToScrollY({ kind: 'pdf', page: 9, offset: 0, gap: 0 })).toBeNull();
  });
});

describe('capturePanelAnchor without reader DOM', () => {
  it('returns null when there is neither .article-content nor [data-page]', () => {
    document.body.innerHTML = '<div><p>Not a reader</p></div>';
    setScrollY(500);
    expect(capturePanelAnchor()).toBeNull();
  });
});
