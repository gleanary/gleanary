import { describe, it, expect } from 'vitest';
import {
  initPickerState,
  reducer,
  buildSubmitPayload,
  isAngleWarning,
  ANGLE_MAX,
  type PickerState,
} from '@/lib/draft-picker-state';

const highlights = [{ id: 1 }, { id: 4 }, { id: 9 }];
const research = [{ id: 2 }, { id: 7 }];

describe('initPickerState', () => {
  it('pre-checks every highlight and research id', () => {
    const state = initPickerState(highlights, research);
    expect([...state.checkedHighlights].sort((a, b) => a - b)).toEqual([1, 4, 9]);
    expect([...state.checkedResearch].sort((a, b) => a - b)).toEqual([2, 7]);
  });

  it('starts at step 1 with no template and empty angle', () => {
    const state = initPickerState(highlights, research);
    expect(state.step).toBe(1);
    expect(state.templateId).toBeNull();
    expect(state.angle).toBe('');
    expect(state.submitting).toBe(false);
    expect(state.error).toBeNull();
  });

  it('handles empty inputs', () => {
    const state = initPickerState([], []);
    expect(state.checkedHighlights.size).toBe(0);
    expect(state.checkedResearch.size).toBe(0);
  });
});

describe('reducer — template selection and navigation', () => {
  it('select_template sets templateId and advances to step 2', () => {
    const state = initPickerState(highlights, research);
    const next = reducer(state, { type: 'select_template', templateId: 'blog' });
    expect(next.templateId).toBe('blog');
    expect(next.step).toBe(2);
  });

  it('back returns to step 1 without clearing templateId or checks', () => {
    let state = initPickerState(highlights, research);
    state = reducer(state, { type: 'select_template', templateId: 'linkedin' });
    state = reducer(state, { type: 'toggle_highlight', id: 1 });
    state = reducer(state, { type: 'set_angle', value: 'draft angle' });
    const back = reducer(state, { type: 'back' });
    expect(back.step).toBe(1);
    expect(back.templateId).toBe('linkedin');
    expect(back.checkedHighlights.has(1)).toBe(false);
    expect(back.angle).toBe('draft angle');
  });
});

describe('reducer — toggles', () => {
  it('toggle_highlight removes when present and adds when absent', () => {
    let state = initPickerState(highlights, research);
    state = reducer(state, { type: 'toggle_highlight', id: 4 });
    expect(state.checkedHighlights.has(4)).toBe(false);
    state = reducer(state, { type: 'toggle_highlight', id: 4 });
    expect(state.checkedHighlights.has(4)).toBe(true);
  });

  it('double toggle_highlight restores original set', () => {
    const initial = initPickerState(highlights, research);
    const once = reducer(initial, { type: 'toggle_highlight', id: 9 });
    const twice = reducer(once, { type: 'toggle_highlight', id: 9 });
    expect([...twice.checkedHighlights].sort()).toEqual([...initial.checkedHighlights].sort());
  });

  it('toggle_research behaves symmetrically', () => {
    let state = initPickerState(highlights, research);
    state = reducer(state, { type: 'toggle_research', id: 2 });
    expect(state.checkedResearch.has(2)).toBe(false);
    state = reducer(state, { type: 'toggle_research', id: 2 });
    expect(state.checkedResearch.has(2)).toBe(true);
  });
});

describe('reducer — angle', () => {
  it('set_angle stores the value', () => {
    const state = reducer(initPickerState(highlights, research), {
      type: 'set_angle',
      value: 'contrarian take',
    });
    expect(state.angle).toBe('contrarian take');
  });

  it('set_angle clamps input to ANGLE_MAX chars', () => {
    const overlong = 'x'.repeat(ANGLE_MAX + 50);
    const state = reducer(initPickerState(highlights, research), {
      type: 'set_angle',
      value: overlong,
    });
    expect(state.angle.length).toBe(ANGLE_MAX);
  });
});

describe('isAngleWarning', () => {
  it('returns false below 450 chars', () => {
    expect(isAngleWarning('x'.repeat(449))).toBe(false);
  });

  it('returns true at 450 chars', () => {
    expect(isAngleWarning('x'.repeat(450))).toBe(true);
  });

  it('returns true at ANGLE_MAX chars', () => {
    expect(isAngleWarning('x'.repeat(ANGLE_MAX))).toBe(true);
  });
});

describe('buildSubmitPayload', () => {
  it('returns payload with sorted id arrays and undefined angle when empty', () => {
    let state = initPickerState(highlights, research);
    state = reducer(state, { type: 'select_template', templateId: 'blog' });
    const payload = buildSubmitPayload(state, 42);
    expect(payload).toEqual({
      thesisId: 42,
      templateId: 'blog',
      model: 'claude-sonnet-4-6',
      angle: undefined,
      includedHighlightIds: [1, 4, 9],
      includedResearchIds: [2, 7],
    });
  });

  it('treats whitespace-only angle as undefined', () => {
    let state = initPickerState(highlights, research);
    state = reducer(state, { type: 'select_template', templateId: 'blog' });
    state = reducer(state, { type: 'set_angle', value: '   \n  ' });
    expect(buildSubmitPayload(state, 1).angle).toBeUndefined();
  });

  it('trims but preserves non-empty angle', () => {
    let state = initPickerState(highlights, research);
    state = reducer(state, { type: 'select_template', templateId: 'youtube' });
    state = reducer(state, { type: 'set_angle', value: '  hook them early  ' });
    expect(buildSubmitPayload(state, 1).angle).toBe('hook them early');
  });

  it('reflects unchecked items by excluding their ids', () => {
    let state = initPickerState(highlights, research);
    state = reducer(state, { type: 'select_template', templateId: 'linkedin' });
    state = reducer(state, { type: 'toggle_highlight', id: 4 });
    state = reducer(state, { type: 'toggle_research', id: 7 });
    const payload = buildSubmitPayload(state, 99);
    expect(payload.includedHighlightIds).toEqual([1, 9]);
    expect(payload.includedResearchIds).toEqual([2]);
  });

  it('throws when templateId is null', () => {
    const state = initPickerState(highlights, research);
    expect(() => buildSubmitPayload(state, 1)).toThrow();
  });
});

describe('reducer — reset', () => {
  it('reset re-initializes from fresh highlight and research inputs', () => {
    let state = initPickerState(highlights, research);
    state = reducer(state, { type: 'select_template', templateId: 'blog' });
    state = reducer(state, { type: 'toggle_highlight', id: 1 });
    state = reducer(state, { type: 'set_angle', value: 'something' });

    const reset = reducer(state, {
      type: 'reset',
      highlights: [{ id: 11 }, { id: 12 }],
      research: [{ id: 21 }],
    });

    expect(reset.step).toBe(1);
    expect(reset.templateId).toBeNull();
    expect(reset.angle).toBe('');
    expect([...reset.checkedHighlights].sort((a, b) => a - b)).toEqual([11, 12]);
    expect([...reset.checkedResearch]).toEqual([21]);
  });
});

describe('reducer — submit lifecycle', () => {
  const ready = (): PickerState => {
    let s = initPickerState(highlights, research);
    s = reducer(s, { type: 'select_template', templateId: 'blog' });
    return s;
  };

  it('submit_start sets submitting true and clears error', () => {
    let state = ready();
    state = reducer(state, { type: 'submit_error', message: 'prior' });
    const next = reducer(state, { type: 'submit_start' });
    expect(next.submitting).toBe(true);
    expect(next.error).toBeNull();
  });

  it('submit_error sets error and clears submitting', () => {
    let state = ready();
    state = reducer(state, { type: 'submit_start' });
    const next = reducer(state, { type: 'submit_error', message: 'boom' });
    expect(next.submitting).toBe(false);
    expect(next.error).toBe('boom');
  });

  it('submit_success clears submitting and error', () => {
    let state = ready();
    state = reducer(state, { type: 'submit_start' });
    const next = reducer(state, { type: 'submit_success' });
    expect(next.submitting).toBe(false);
    expect(next.error).toBeNull();
  });
});
