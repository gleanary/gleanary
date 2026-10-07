'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Discriminated event emitted by the SSE stream parser. */
export type SseEvent =
  { type: 'delta'; text: string } | { type: 'done' } | { type: 'error'; error: string };

/** State threaded between calls to processSseLines — tracks the active event name. */
export interface SseParseState {
  currentEvent: string;
}

/**
 * Pure SSE line-batch parser for the `/api/drafts/[id]/generate` stream.
 * Expects `event: <name>` and `data: <json>` lines (matching the sseEvent
 * helper); handles split batches by threading `state` between calls.
 * Malformed JSON, blank lines, and unknown event names are silently skipped.
 * @param lines - Lines from the current decoder chunk (no trailing newline)
 * @param state - Parser state returned by the previous call
 * @returns Emitted events plus the updated state
 */
export function processSseLines(
  lines: string[],
  state: SseParseState,
): { events: SseEvent[]; state: SseParseState } {
  const events: SseEvent[] = [];
  let currentEvent = state.currentEvent;
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (currentEvent === 'delta') {
        const text = (parsed as { text?: unknown }).text;
        if (typeof text === 'string') events.push({ type: 'delta', text });
      } else if (currentEvent === 'done') {
        events.push({ type: 'done' });
      } else if (currentEvent === 'error') {
        const error = (parsed as { error?: unknown }).error;
        if (typeof error === 'string') events.push({ type: 'error', error });
      }
    }
  }
  return { events, state: { currentEvent } };
}

/** Discriminated error surface for the generation hook. */
export type GenerationError = { kind: 'needs-force' | 'other'; message: string };

/** Options accepted by `start()` — `onDone` fires after a successful stream
 *  completes, with the full accumulated text so the caller sees the final
 *  value without relying on the hook's React state (which would be stale if
 *  captured before the stream started). */
export interface StartOptions {
  onDone?: (finalText: string) => void | Promise<void>;
}

/**
 * Client hook that drives a single draft's SSE generation stream.
 *
 * - `start(force, { onDone })` aborts any in-flight call, then POSTs to
 *   `/api/drafts/[id]/generate`. A 409 response surfaces as
 *   `error.kind === 'needs-force'` without throwing.
 * - `streamedText` accumulates all `delta` chunks; the consumer renders it
 *   directly while `isStreaming` is true.
 * - Unmount cleanup aborts the fetch, which cascades to the server route's
 *   `ReadableStream.cancel()` and the upstream Anthropic call.
 *
 * @param draftId - Target draft ID
 */
export function useDraftGeneration(draftId: number) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [error, setError] = useState<GenerationError | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const clearStreamedText = useCallback(() => setStreamedText(''), []);
  const clearError = useCallback(() => setError(null), []);

  const start = useCallback(
    async (force: boolean, opts?: StartOptions) => {
      abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setError(null);
      setStreamedText('');
      setIsStreaming(true);

      let response: Response;
      try {
        response = await fetch(`/api/drafts/${draftId}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          setIsStreaming(false);
          return;
        }
        setIsStreaming(false);
        setError({ kind: 'other', message: err instanceof Error ? err.message : 'Network error' });
        return;
      }

      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        const message = body?.error ?? `Request failed (${response.status})`;
        setIsStreaming(false);
        setError({ kind: response.status === 409 ? 'needs-force' : 'other', message });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let parseState: SseParseState = { currentEvent: '' };
      let accumulated = '';
      let done = false;
      let errorEvent: string | null = null;

      const applyEvents = (events: SseEvent[]) => {
        for (const event of events) {
          if (event.type === 'delta') {
            accumulated += event.text;
            setStreamedText(accumulated);
          } else if (event.type === 'done') {
            done = true;
          } else if (event.type === 'error') {
            errorEvent = event.error;
          }
        }
      };

      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          const result = processSseLines(lines, parseState);
          parseState = result.state;
          applyEvents(result.events);
        }
        if (buffer.trim().length > 0) {
          const result = processSseLines(buffer.split('\n'), parseState);
          applyEvents(result.events);
        }
      } catch (err) {
        if (controller.signal.aborted) {
          setIsStreaming(false);
          return;
        }
        setIsStreaming(false);
        setError({ kind: 'other', message: err instanceof Error ? err.message : 'Stream error' });
        return;
      }

      setIsStreaming(false);
      if (errorEvent) {
        setError({ kind: 'other', message: errorEvent });
        return;
      }
      if (done) {
        await opts?.onDone?.(accumulated);
      }
    },
    [draftId, abort],
  );

  useEffect(() => {
    return () => abort();
  }, [abort]);

  return {
    start,
    abort,
    isStreaming,
    error,
    streamedText,
    clearStreamedText,
    clearError,
  };
}
