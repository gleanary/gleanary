/**
 * Palette state utilities: flat item type, reducer, and helpers.
 * Exported for use by search-palette.tsx (shell) and unit tests.
 */

import type {
  SearchResponse,
  SearchResultArticle,
  SearchResultHighlight,
  SearchResultThesis,
  SearchResultDraft,
} from '@/types';

// ── Flat item list ──────────────────────────────────────────────────────────

export type FlatItem =
  | { kind: 'article'; result: SearchResultArticle }
  | { kind: 'highlight'; result: SearchResultHighlight }
  | { kind: 'thesis'; result: SearchResultThesis }
  | { kind: 'draft'; result: SearchResultDraft }
  | { kind: 'footer'; total: number };

/**
 * Flattens a SearchResponse into an ordered list of palette items.
 * Groups: articles → highlights → theses → drafts → footer.
 * Returns empty array when data is null.
 */
export function buildFlatItems(data: SearchResponse | null): FlatItem[] {
  if (!data) return [];
  const items: FlatItem[] = [];
  for (const r of data.results.articles) items.push({ kind: 'article', result: r });
  for (const r of data.results.highlights) items.push({ kind: 'highlight', result: r });
  for (const r of data.results.theses) items.push({ kind: 'thesis', result: r });
  for (const r of data.results.drafts) items.push({ kind: 'draft', result: r });
  const total = Object.values(data.totals).reduce((s, n) => s + n, 0);
  if (items.length > 0) items.push({ kind: 'footer', total });
  return items;
}

// ── Reducer ─────────────────────────────────────────────────────────────────

export interface PaletteState {
  items: FlatItem[];
  activeIndex: number;
}

export type PaletteAction =
  | { type: 'SET_ITEMS'; items: FlatItem[] }
  | { type: 'MOVE'; delta: 1 | -1 }
  | { type: 'HOME' }
  | { type: 'END' }
  | { type: 'SET_HOVER'; index: number };

export function paletteReducer(state: PaletteState, action: PaletteAction): PaletteState {
  switch (action.type) {
    case 'SET_ITEMS':
      return {
        items: action.items,
        // Auto-activate first result — type → Enter navigates immediately without ArrowDown
        activeIndex: action.items.length > 0 ? 0 : -1,
      };
    case 'MOVE': {
      if (state.items.length === 0) return state;
      const next = state.activeIndex + action.delta;
      return { ...state, activeIndex: Math.max(0, Math.min(next, state.items.length - 1)) };
    }
    case 'HOME':
      return { ...state, activeIndex: state.items.length > 0 ? 0 : -1 };
    case 'END':
      return { ...state, activeIndex: state.items.length > 0 ? state.items.length - 1 : -1 };
    case 'SET_HOVER':
      return { ...state, activeIndex: action.index };
    default:
      return state;
  }
}

// ── ID helpers ───────────────────────────────────────────────────────────────

export function itemDomId(item: FlatItem, index: number): string {
  if (item.kind === 'footer') return 'search-option-footer';
  return `search-option-${item.kind}-${item.result.id}-${index}`;
}

/**
 * Returns the DOM id of the currently active palette option, or undefined
 * when no item is active (used for aria-activedescendant).
 */
export function activeItemId(items: FlatItem[], activeIndex: number): string | undefined {
  if (activeIndex < 0 || activeIndex >= items.length) return undefined;
  return itemDomId(items[activeIndex]!, activeIndex);
}
