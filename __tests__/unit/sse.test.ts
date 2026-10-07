import { describe, it, expect } from 'vitest';
import { sseEvent, SSE_HEADERS } from '@/lib/sse';

describe('sseEvent', () => {
  it('returns a Uint8Array', () => {
    expect(sseEvent('delta', { text: 'hi' })).toBeInstanceOf(Uint8Array);
  });

  it('decodes to the exact SSE wire format: event line, data line, blank-line terminator', () => {
    const bytes = sseEvent('delta', { text: 'hi', n: 1 });
    const decoded = new TextDecoder().decode(bytes);
    expect(decoded).toBe('event: delta\ndata: {"text":"hi","n":1}\n\n');
  });

  it('serializes the data payload with JSON.stringify', () => {
    const data = { a: 1, b: ['x', null], c: true };
    const decoded = new TextDecoder().decode(sseEvent('done', data));
    expect(decoded).toBe(`event: done\ndata: ${JSON.stringify(data)}\n\n`);
  });
});

describe('SSE_HEADERS', () => {
  it('carries the three streaming headers', () => {
    expect(SSE_HEADERS).toEqual({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  });
});
