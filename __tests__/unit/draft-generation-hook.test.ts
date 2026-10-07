import { describe, it, expect } from 'vitest';
import { processSseLines, type SseParseState } from '@/components/drafts/use-draft-generation';

const initial = (): SseParseState => ({ currentEvent: '' });

describe('processSseLines', () => {
  it('emits nothing on an empty batch and preserves state', () => {
    const out = processSseLines([], initial());
    expect(out.events).toEqual([]);
    expect(out.state.currentEvent).toBe('');
  });

  it('emits delta when data follows event: delta', () => {
    const out = processSseLines(['event: delta', 'data: {"text":"hi"}'], initial());
    expect(out.events).toEqual([{ type: 'delta', text: 'hi' }]);
    expect(out.state.currentEvent).toBe('delta');
  });

  it('emits done when data follows event: done', () => {
    const out = processSseLines(['event: done', 'data: {}'], initial());
    expect(out.events).toEqual([{ type: 'done' }]);
  });

  it('emits error with message when data follows event: error', () => {
    const out = processSseLines(['event: error', 'data: {"error":"boom"}'], initial());
    expect(out.events).toEqual([{ type: 'error', error: 'boom' }]);
  });

  it('preserves currentEvent across calls when the stream splits mid-event', () => {
    const first = processSseLines(['event: delta'], initial());
    expect(first.events).toEqual([]);
    const second = processSseLines(['data: {"text":"a"}'], first.state);
    expect(second.events).toEqual([{ type: 'delta', text: 'a' }]);
  });

  it('handles multiple delta chunks in one batch under the same event', () => {
    const out = processSseLines(
      ['event: delta', 'data: {"text":"hello "}', 'data: {"text":"world"}'],
      initial(),
    );
    expect(out.events).toEqual([
      { type: 'delta', text: 'hello ' },
      { type: 'delta', text: 'world' },
    ]);
  });

  it('ignores malformed JSON in data lines without throwing', () => {
    const out = processSseLines(['event: delta', 'data: {not json'], initial());
    expect(out.events).toEqual([]);
  });

  it('ignores blank lines between events', () => {
    const out = processSseLines(['event: delta', '', 'data: {"text":"x"}'], initial());
    expect(out.events).toEqual([{ type: 'delta', text: 'x' }]);
  });

  it('drops delta data that lacks a text field', () => {
    const out = processSseLines(['event: delta', 'data: {}'], initial());
    expect(out.events).toEqual([]);
  });

  it('tracks transitions between event types in one batch', () => {
    const out = processSseLines(
      [
        'event: delta',
        'data: {"text":"a"}',
        'event: delta',
        'data: {"text":"b"}',
        'event: done',
        'data: {}',
      ],
      initial(),
    );
    expect(out.events).toEqual([
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
      { type: 'done' },
    ]);
  });
});
