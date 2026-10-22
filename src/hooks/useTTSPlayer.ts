'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isSpokenToken } from '@/lib/tts-tokens';
import type { TTSPosition, TTSStatus } from '@/types';

/** Supported playback speed values */
export const TTS_SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5] as const;

/** Estimated TTS speaking rate in words per minute (slower than silent reading ~238 WPM) */
const TTS_WPM = 150;
/** Fallback duration estimate per paragraph when word count is unavailable */
const FALLBACK_SECONDS_PER_PARAGRAPH = 30;

/** Estimated duration (seconds) of a paragraph at the TTS speaking rate */
function estimatedParagraphDuration(wordCount: number): number {
  return (wordCount / TTS_WPM) * 60;
}

/** Estimated absolute start time (seconds) of a paragraph; 0 when word counts are unknown */
function estimatedParagraphStart(wordCounts: number[] | null, paragraphIndex: number): number {
  if (!wordCounts) return 0;
  let start = 0;
  for (let i = 0; i < paragraphIndex; i++) start += estimatedParagraphDuration(wordCounts[i] ?? 0);
  return start;
}

/** Paragraph whose estimated [start, start + duration) range contains `time` (clamped to the last) */
function estimatedParagraphAt(
  wordCounts: number[],
  time: number,
): { index: number; start: number } {
  let start = 0;
  for (let i = 0; i < wordCounts.length; i++) {
    const duration = estimatedParagraphDuration(wordCounts[i] ?? 0);
    if (time < start + duration || i === wordCounts.length - 1) return { index: i, start };
    start += duration;
  }
  return { index: 0, start: 0 };
}

interface ParagraphData {
  buffer: AudioBuffer;
  words: string[];
  startTimes: number[];
  endTimes: number[];
  duration: number;
}

interface UseTTSPlayerReturn {
  status: TTSStatus;
  play: (articleId: number, startParagraph?: number, startOffset?: number) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  skipForward: () => void;
  skipBack: () => void;
  seekTo: (targetTime: number) => void;
  setSpeed: (speed: number) => void;
  getCurrentPosition: () => TTSPosition | null;
  currentParagraph: number;
  currentWordIndex: number;
  currentWords: string[];
  currentTime: number;
  estimatedTotalTime: number;
  progress: number;
  speed: number;
}

/**
 * React hook encapsulating TTS playback logic.
 * Manages SSE stream consumption, Web Audio API playback, and word tracking.
 * @param onComplete - Optional callback fired when the article finishes playing naturally
 * @returns TTS playback state and control methods
 */
export function useTTSPlayer(onComplete?: () => void): UseTTSPlayerReturn {
  const [status, setStatus] = useState<TTSStatus>('idle');
  const statusRef = useRef<TTSStatus>('idle');
  const [currentParagraph, setCurrentParagraph] = useState(0);
  const [currentWordIndex, setCurrentWordIndex] = useState(-1);
  const [currentWords, setCurrentWords] = useState<string[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [estimatedTotalTime, setEstimatedTotalTime] = useState(0);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeedState] = useState(1.0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const paragraphDataRef = useRef<Map<number, ParagraphData>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);
  const rafIdRef = useRef<number>(0);
  const articleIdRef = useRef<number | null>(null);
  const startOffsetRef = useRef<number>(0);
  const onCompleteRef = useRef(onComplete);
  // Read by the rAF tracking loop, which must not close over stale render values
  const speedRef = useRef(1.0);
  const estimatedTotalTimeRef = useRef(0);
  // Whole-article word counts from metadata (null for servers that don't send them)
  const paragraphWordCountsRef = useRef<number[] | null>(null);
  // Paragraph the current SSE stream started at; its estimated start is the timeline base
  const streamStartParagraphRef = useRef(0);
  const playbackStateRef = useRef({
    paragraphStartTime: 0,
    currentParagraphIndex: 0,
    totalParagraphs: 0,
    paragraphStartOffset: 0,
    isPlaying: false,
    cumulativeDuration: 0,
    waitingForParagraph: -1,
  });

  /** Get or create the AudioContext */
  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === 'closed') {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  }, []);

  /** Get the current playback position for save/restore */
  const getCurrentPosition = useCallback((): TTSPosition | null => {
    const ctx = audioContextRef.current;
    const state = playbackStateRef.current;
    if (!ctx || statusRef.current === 'idle') return null;

    const elapsed = (ctx.currentTime - state.paragraphStartTime) * speed;
    const data = paragraphDataRef.current.get(state.currentParagraphIndex);
    const timeOffset = data ? Math.min(elapsed, data.duration) : elapsed;

    return { paragraph: state.currentParagraphIndex, timeOffset };
  }, [speed]);

  /** Stop the current audio source */
  const stopCurrentSource = useCallback(() => {
    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.onended = null;
        sourceNodeRef.current.stop();
      } catch {
        // May already be stopped
      }
      sourceNodeRef.current = null;
    }
  }, []);

  /** Ref to hold the playParagraphBuffer function for self-referencing */
  const playParagraphBufferRef = useRef<(paragraphIndex: number, offset?: number) => void>(
    () => {},
  );

  /** Play a specific paragraph's audio buffer */
  const playParagraphBuffer = useCallback(
    (paragraphIndex: number, offset = 0) => {
      const ctx = getAudioContext();
      const data = paragraphDataRef.current.get(paragraphIndex);
      if (!data) return;

      stopCurrentSource();

      const source = ctx.createBufferSource();
      source.buffer = data.buffer;
      source.playbackRate.value = speed;
      source.connect(ctx.destination);
      sourceNodeRef.current = source;
      setCurrentWords(data.words);

      playbackStateRef.current.paragraphStartTime = ctx.currentTime - offset / speed;
      playbackStateRef.current.currentParagraphIndex = paragraphIndex;
      playbackStateRef.current.paragraphStartOffset = offset;
      playbackStateRef.current.isPlaying = true;

      setCurrentParagraph(paragraphIndex);

      source.onended = () => {
        if (!playbackStateRef.current.isPlaying) return;
        // Try to play next paragraph
        const nextIndex = paragraphIndex + 1;
        if (
          nextIndex < playbackStateRef.current.totalParagraphs &&
          paragraphDataRef.current.has(nextIndex)
        ) {
          // Update cumulative duration
          playbackStateRef.current.cumulativeDuration += data.duration;
          playParagraphBufferRef.current(nextIndex);
        } else if (nextIndex >= playbackStateRef.current.totalParagraphs) {
          // Article finished
          playbackStateRef.current.isPlaying = false;
          setStatus('idle');
          statusRef.current = 'idle';
          setProgress(1);
          onCompleteRef.current?.();
        } else {
          // Buffer not ready yet — mark which paragraph we're waiting for
          playbackStateRef.current.cumulativeDuration += data.duration;
          playbackStateRef.current.waitingForParagraph = nextIndex;
          playbackStateRef.current.currentParagraphIndex = nextIndex;
          setStatus('loading');
          statusRef.current = 'loading';
        }
      };

      source.start(0, offset);
    },
    [getAudioContext, stopCurrentSource, speed],
  );

  // Keep refs in sync with the latest callbacks
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  useEffect(() => {
    playParagraphBufferRef.current = playParagraphBuffer;
  }, [playParagraphBuffer]);

  /** Animation frame loop for tracking word position */
  const startTracking = useCallback(() => {
    const track = () => {
      if (!playbackStateRef.current.isPlaying) return;

      const ctx = audioContextRef.current;
      if (!ctx) return;

      const state = playbackStateRef.current;
      const data = paragraphDataRef.current.get(state.currentParagraphIndex);
      if (!data) {
        rafIdRef.current = requestAnimationFrame(track);
        return;
      }

      const elapsed = (ctx.currentTime - state.paragraphStartTime) * speedRef.current;
      const clampedElapsed = Math.min(elapsed, data.duration);

      // Find current word via linear scan with early exit (sorted arrays)
      let wordIdx = -1;
      for (let i = 0; i < data.startTimes.length; i++) {
        if (
          clampedElapsed >= (data.startTimes[i] ?? 0) &&
          clampedElapsed <= (data.endTimes[i] ?? 0)
        ) {
          wordIdx = i;
          break;
        }
        if (clampedElapsed < (data.startTimes[i] ?? 0)) break;
      }
      // Only update state when values actually change to avoid unnecessary re-renders
      setCurrentWordIndex((prev) => (prev === wordIdx ? prev : wordIdx));

      // Update overall progress/time
      const totalElapsed = state.cumulativeDuration + clampedElapsed;
      setCurrentTime((prev) => (Math.abs(prev - totalElapsed) < 0.05 ? prev : totalElapsed));
      const estimatedTotal = estimatedTotalTimeRef.current;
      if (estimatedTotal > 0) {
        const newProgress = Math.min(totalElapsed / estimatedTotal, 1);
        setProgress((prev) => (Math.abs(prev - newProgress) < 0.005 ? prev : newProgress));
      }

      rafIdRef.current = requestAnimationFrame(track);
    };

    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(track);
  }, []);

  /** Parse an SSE event line pair */
  const parseSSEEvent = useCallback(
    (eventType: string, data: string): void => {
      try {
        const parsed = JSON.parse(data);

        switch (eventType) {
          case 'metadata': {
            playbackStateRef.current.totalParagraphs = parsed.totalParagraphs;
            paragraphWordCountsRef.current = Array.isArray(parsed.paragraphWordCounts)
              ? parsed.paragraphWordCounts
              : null;
            // Absolute timeline: a stream started mid-article begins at its estimated position
            playbackStateRef.current.cumulativeDuration = estimatedParagraphStart(
              paragraphWordCountsRef.current,
              streamStartParagraphRef.current,
            );
            // Estimate duration from word count at typical TTS speaking rate
            const estimatedTotal = parsed.totalWords
              ? estimatedParagraphDuration(parsed.totalWords)
              : parsed.totalParagraphs * FALLBACK_SECONDS_PER_PARAGRAPH;
            estimatedTotalTimeRef.current = estimatedTotal;
            setEstimatedTotalTime(estimatedTotal);
            break;
          }

          case 'audio': {
            const ctx = getAudioContext();
            const binary = atob(parsed.audioContent);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            // Capture timestamps synchronously before async decode, keeping only
            // spoken words (Inworld also emits whitespace/punctuation tokens)
            const rawWords: string[] = parsed.words ?? [];
            const rawStartTimes: number[] = parsed.startTimes ?? [];
            const rawEndTimes: number[] = parsed.endTimes ?? [];
            const words: string[] = [];
            const startTimes: number[] = [];
            const endTimes: number[] = [];
            rawWords.forEach((word, i) => {
              if (!isSpokenToken(word)) return;
              words.push(word);
              startTimes.push(rawStartTimes[i] ?? 0);
              endTimes.push(rawEndTimes[i] ?? 0);
            });
            ctx
              .decodeAudioData(bytes.buffer.slice(0))
              .then((audioBuffer) => {
                paragraphDataRef.current.set(parsed.paragraphIndex, {
                  buffer: audioBuffer,
                  words,
                  startTimes,
                  endTimes,
                  duration: audioBuffer.duration,
                });

                // If we're waiting for this paragraph, start playing (use ref to avoid stale closure)
                const isWaiting =
                  (statusRef.current === 'loading' &&
                    parsed.paragraphIndex === playbackStateRef.current.currentParagraphIndex) ||
                  playbackStateRef.current.waitingForParagraph === parsed.paragraphIndex;
                if (isWaiting) {
                  playbackStateRef.current.waitingForParagraph = -1;
                  setStatus('playing');
                  statusRef.current = 'playing';
                  // Apply startOffset for the first paragraph on resume
                  const offset = startOffsetRef.current;
                  startOffsetRef.current = 0;
                  playParagraphBufferRef.current(parsed.paragraphIndex, offset);
                  startTracking();
                }
              })
              .catch(() => {});
            break;
          }

          case 'complete':
            // A stream started mid-article only measured part of it: keep the estimate
            if (parsed.totalDuration && streamStartParagraphRef.current === 0) {
              estimatedTotalTimeRef.current = parsed.totalDuration;
              setEstimatedTotalTime(parsed.totalDuration);
            }
            break;

          case 'error':
            setStatus('idle');
            statusRef.current = 'idle';
            break;
        }
      } catch {
        // JSON parse error, skip
      }
    },
    [getAudioContext, startTracking],
  );

  /** Start playback for an article */
  const play = useCallback(
    (articleId: number, startParagraph = 0, startOffset = 0) => {
      // Abort any existing stream
      abortControllerRef.current?.abort();
      stopCurrentSource();
      paragraphDataRef.current.clear();
      playbackStateRef.current.cumulativeDuration = 0;
      playbackStateRef.current.waitingForParagraph = -1;
      playbackStateRef.current.currentParagraphIndex = startParagraph;
      streamStartParagraphRef.current = startParagraph;
      articleIdRef.current = articleId;
      startOffsetRef.current = startOffset;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      setStatus('loading');
      statusRef.current = 'loading';
      setCurrentParagraph(startParagraph);
      setCurrentWordIndex(-1);
      setCurrentTime(0);
      setProgress(0);

      const url = `/api/tts/${articleId}?speed=${speed}&startParagraph=${startParagraph}`;

      fetch(url, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok || !response.body) {
            setStatus('idle');
            statusRef.current = 'idle';
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let currentEventType = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Process complete SSE events
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (currentEventType) {
                  parseSSEEvent(currentEventType, data);
                  currentEventType = '';
                }
              }
            }
          }
        })
        .catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setStatus('idle');
          statusRef.current = 'idle';
        });
    },
    [speed, stopCurrentSource, parseSSEEvent],
  );

  /** Pause audio playback */
  const pause = useCallback(() => {
    const ctx = audioContextRef.current;
    if (ctx && ctx.state === 'running') {
      ctx.suspend();
      playbackStateRef.current.isPlaying = false;
      cancelAnimationFrame(rafIdRef.current);
      setStatus('paused');
      statusRef.current = 'paused';
    }
  }, []);

  /** Resume audio playback */
  const resume = useCallback(() => {
    const ctx = audioContextRef.current;
    if (ctx && ctx.state === 'suspended') {
      ctx.resume();
      playbackStateRef.current.isPlaying = true;
      startTracking();
      setStatus('playing');
      statusRef.current = 'playing';
    }
  }, [startTracking]);

  /** Stop playback completely */
  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
    stopCurrentSource();
    cancelAnimationFrame(rafIdRef.current);
    playbackStateRef.current.isPlaying = false;
    playbackStateRef.current.cumulativeDuration = 0;
    playbackStateRef.current.waitingForParagraph = -1;
    paragraphDataRef.current.clear();
    articleIdRef.current = null;

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }

    setStatus('idle');
    statusRef.current = 'idle';
    setCurrentParagraph(0);
    setCurrentWordIndex(-1);
    setCurrentWords([]);
    setCurrentTime(0);
    setProgress(0);
  }, [stopCurrentSource]);

  /** Skip forward 15 seconds */
  const skipForward = useCallback(() => {
    if (status !== 'playing' && status !== 'paused') return;

    const ctx = audioContextRef.current;
    if (!ctx) return;

    const state = playbackStateRef.current;
    const currentData = paragraphDataRef.current.get(state.currentParagraphIndex);
    if (!currentData) return;

    const elapsed = (ctx.currentTime - state.paragraphStartTime) * speed;
    const targetElapsed = elapsed + 15;

    if (targetElapsed < currentData.duration) {
      // Still within current paragraph
      if (ctx.state === 'suspended') ctx.resume();
      playParagraphBuffer(state.currentParagraphIndex, targetElapsed);
      if (status === 'paused') {
        setStatus('playing');
        statusRef.current = 'playing';
      }
      startTracking();
    } else {
      // Skip to next paragraph — accumulate skipped duration separately to avoid corruption
      let remaining = targetElapsed - currentData.duration;
      let nextIdx = state.currentParagraphIndex + 1;
      let skippedDuration = currentData.duration;

      while (nextIdx < state.totalParagraphs) {
        const nextData = paragraphDataRef.current.get(nextIdx);
        if (!nextData) break;
        if (remaining < nextData.duration) {
          state.cumulativeDuration += skippedDuration;
          if (ctx.state === 'suspended') ctx.resume();
          playParagraphBuffer(nextIdx, remaining);
          if (status === 'paused') {
            setStatus('playing');
            statusRef.current = 'playing';
          }
          startTracking();
          return;
        }
        remaining -= nextData.duration;
        skippedDuration += nextData.duration;
        nextIdx++;
      }
    }
  }, [status, speed, playParagraphBuffer, startTracking]);

  /** Skip back 15 seconds */
  const skipBack = useCallback(() => {
    if (status !== 'playing' && status !== 'paused') return;

    const ctx = audioContextRef.current;
    if (!ctx) return;

    const state = playbackStateRef.current;
    const elapsed = (ctx.currentTime - state.paragraphStartTime) * speed;
    const targetElapsed = elapsed - 15;

    if (targetElapsed >= 0) {
      // Still within current paragraph
      if (ctx.state === 'suspended') ctx.resume();
      playParagraphBuffer(state.currentParagraphIndex, targetElapsed);
      if (status === 'paused') {
        setStatus('playing');
        statusRef.current = 'playing';
      }
      startTracking();
    } else {
      // Go back into previous paragraph(s)
      let remaining = -targetElapsed; // how many seconds to go back before current paragraph
      let prevIdx = state.currentParagraphIndex - 1;

      while (prevIdx >= 0) {
        const prevData = paragraphDataRef.current.get(prevIdx);
        if (!prevData) break;
        if (remaining <= prevData.duration) {
          // Land within this previous paragraph (stream base + loaded durations before it)
          state.cumulativeDuration = estimatedParagraphStart(
            paragraphWordCountsRef.current,
            streamStartParagraphRef.current,
          );
          for (let i = streamStartParagraphRef.current; i < prevIdx; i++) {
            const d = paragraphDataRef.current.get(i);
            if (d) state.cumulativeDuration += d.duration;
          }
          if (ctx.state === 'suspended') ctx.resume();
          playParagraphBuffer(prevIdx, prevData.duration - remaining);
          if (status === 'paused') {
            setStatus('playing');
            statusRef.current = 'playing';
          }
          startTracking();
          return;
        }
        remaining -= prevData.duration;
        prevIdx--;
      }

      // Couldn't go back further — restart from beginning of first available paragraph
      const firstIdx = prevIdx + 1;
      state.cumulativeDuration = estimatedParagraphStart(
        paragraphWordCountsRef.current,
        streamStartParagraphRef.current,
      );
      if (ctx.state === 'suspended') ctx.resume();
      playParagraphBuffer(Math.max(firstIdx, 0), 0);
      if (status === 'paused') {
        setStatus('playing');
        statusRef.current = 'playing';
      }
      startTracking();
    }
  }, [status, speed, playParagraphBuffer, startTracking]);

  /** Seek to an absolute time position (in seconds) */
  const seekTo = useCallback(
    (targetTime: number) => {
      if (statusRef.current !== 'playing' && statusRef.current !== 'paused') return;

      const ctx = audioContextRef.current;
      if (!ctx) return;

      const state = playbackStateRef.current;
      const clampedTarget = Math.max(0, Math.min(targetTime, estimatedTotalTime));
      const wordCounts = paragraphWordCountsRef.current;

      /** Target not loaded: restart the stream at its estimated paragraph (no-op without word counts) */
      const restartStreamAtTarget = () => {
        const articleId = articleIdRef.current;
        if (!wordCounts || articleId === null) return;
        const { index, start } = estimatedParagraphAt(wordCounts, clampedTarget);
        if (ctx.state === 'suspended') ctx.resume();
        play(articleId, index, clampedTarget - start);
        // Show the target on the bar while the new stream loads
        setCurrentTime(clampedTarget);
        setProgress(estimatedTotalTime > 0 ? Math.min(clampedTarget / estimatedTotalTime, 1) : 0);
      };

      // Walk loaded paragraphs from the stream's start (its estimated absolute base)
      let accumulated = estimatedParagraphStart(wordCounts, streamStartParagraphRef.current);
      if (clampedTarget < accumulated) {
        restartStreamAtTarget();
        return;
      }
      for (let i = streamStartParagraphRef.current; i < state.totalParagraphs; i++) {
        const data = paragraphDataRef.current.get(i);
        if (!data) {
          restartStreamAtTarget();
          return;
        }

        if (accumulated + data.duration > clampedTarget) {
          // Target is within this paragraph
          const offset = clampedTarget - accumulated;
          state.cumulativeDuration = accumulated;
          if (ctx.state === 'suspended') ctx.resume();
          playParagraphBuffer(i, offset);
          if (statusRef.current === 'paused') {
            setStatus('playing');
            statusRef.current = 'playing';
          }
          startTracking();
          return;
        }
        accumulated += data.duration;
      }

      // Target beyond end — seek to near-end of last paragraph to avoid immediate completion
      const lastIdx = state.totalParagraphs - 1;
      const lastData = paragraphDataRef.current.get(lastIdx);
      if (lastData) {
        state.cumulativeDuration = accumulated - lastData.duration;
        if (ctx.state === 'suspended') ctx.resume();
        playParagraphBuffer(lastIdx, lastData.duration - 0.01);
        if (statusRef.current === 'paused') {
          setStatus('playing');
          statusRef.current = 'playing';
        }
        startTracking();
      }
    },
    [estimatedTotalTime, play, playParagraphBuffer, startTracking],
  );

  /** Update playback speed */
  const setSpeed = useCallback((newSpeed: number) => {
    speedRef.current = newSpeed;
    setSpeedState(newSpeed);
    // Apply to current source if playing
    if (sourceNodeRef.current) {
      sourceNodeRef.current.playbackRate.value = newSpeed;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      cancelAnimationFrame(rafIdRef.current);
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
    };
  }, []);

  return {
    status,
    play,
    pause,
    resume,
    stop,
    skipForward,
    skipBack,
    seekTo,
    setSpeed,
    getCurrentPosition,
    currentParagraph,
    currentWordIndex,
    currentWords,
    currentTime,
    estimatedTotalTime,
    progress,
    speed,
  };
}
