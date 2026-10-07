import { describe, it, expect } from 'vitest';
import {
  paletteReducer,
  buildFlatItems,
  type PaletteState,
} from '@/components/search/search-palette-results';
import type { SearchResponse } from '@/types';

function makeState(count: number, activeIndex = 0): PaletteState {
  const items = buildFlatItems(makeResponse(count));
  return { items, activeIndex };
}

function makeResponse(articleCount: number): SearchResponse {
  return {
    query: 'test',
    results: {
      articles: Array.from({ length: articleCount }, (_, i) => ({
        id: i + 1,
        title: `Article ${i + 1}`,
        siteName: null,
        status: 'inbox',
        snippet: '',
        savedAt: '',
      })),
      highlights: [],
      theses: [],
      drafts: [],
    },
    totals: { article: articleCount, highlight: 0, thesis: 0, draft: 0 },
  };
}

describe('paletteReducer', () => {
  describe('SET_ITEMS', () => {
    it('auto-activates first result when items is non-empty', () => {
      const state = paletteReducer(
        { items: [], activeIndex: -1 },
        { type: 'SET_ITEMS', items: buildFlatItems(makeResponse(3)) },
      );
      expect(state.activeIndex).toBe(0);
    });

    it('sets activeIndex to -1 when items is empty', () => {
      const state = paletteReducer({ items: [], activeIndex: 2 }, { type: 'SET_ITEMS', items: [] });
      expect(state.activeIndex).toBe(-1);
    });

    it('includes a footer item when results are non-empty', () => {
      const items = buildFlatItems(makeResponse(2));
      expect(items[items.length - 1]?.kind).toBe('footer');
    });

    it('returns empty array for null data', () => {
      expect(buildFlatItems(null)).toHaveLength(0);
    });
  });

  describe('MOVE', () => {
    it('moves forward by 1', () => {
      const state = paletteReducer(makeState(3, 0), { type: 'MOVE', delta: 1 });
      expect(state.activeIndex).toBe(1);
    });

    it('moves backward by 1', () => {
      const state = paletteReducer(makeState(3, 2), { type: 'MOVE', delta: -1 });
      expect(state.activeIndex).toBe(1);
    });

    it('clamps at 0 — no wrap at start', () => {
      const state = paletteReducer(makeState(3, 0), { type: 'MOVE', delta: -1 });
      expect(state.activeIndex).toBe(0);
    });

    it('clamps at last item — no wrap at end', () => {
      const s = makeState(2); // 2 articles + 1 footer = 3 items
      const last = s.items.length - 1;
      const state = paletteReducer({ ...s, activeIndex: last }, { type: 'MOVE', delta: 1 });
      expect(state.activeIndex).toBe(last);
    });

    it('crosses group boundary (article → footer)', () => {
      // 1 article → items are [article, footer]; moving from 0 → 1 crosses into footer
      const s = makeState(1, 0);
      expect(s.items).toHaveLength(2);
      const state = paletteReducer(s, { type: 'MOVE', delta: 1 });
      expect(state.activeIndex).toBe(1);
      expect(state.items[1]?.kind).toBe('footer');
    });

    it('is a no-op when items list is empty', () => {
      const state = paletteReducer({ items: [], activeIndex: -1 }, { type: 'MOVE', delta: 1 });
      expect(state.activeIndex).toBe(-1);
    });
  });

  describe('HOME', () => {
    it('jumps to first item', () => {
      const state = paletteReducer(makeState(3, 2), { type: 'HOME' });
      expect(state.activeIndex).toBe(0);
    });

    it('sets -1 when empty', () => {
      const state = paletteReducer({ items: [], activeIndex: -1 }, { type: 'HOME' });
      expect(state.activeIndex).toBe(-1);
    });
  });

  describe('END', () => {
    it('jumps to last item', () => {
      const s = makeState(3, 0);
      const state = paletteReducer(s, { type: 'END' });
      expect(state.activeIndex).toBe(s.items.length - 1);
    });

    it('sets -1 when empty', () => {
      const state = paletteReducer({ items: [], activeIndex: -1 }, { type: 'END' });
      expect(state.activeIndex).toBe(-1);
    });
  });

  describe('SET_HOVER', () => {
    it('sets the hovered index', () => {
      const state = paletteReducer(makeState(3, 0), { type: 'SET_HOVER', index: 2 });
      expect(state.activeIndex).toBe(2);
    });
  });
});
