'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTTS } from '@/components/reader/tts-provider';
import { TTS_SPEEDS } from '@/hooks/useTTSPlayer';

/** Skip 15s icon: circular arrow with "15" text, direction controls arrow orientation */
function Skip15Icon({
  direction,
  className,
}: {
  direction: 'back' | 'forward';
  className?: string;
}) {
  const arrowPath = direction === 'back' ? 'M12 5V1L7 5l5 4V5' : 'M12 5V1l5 4-5 4V5';
  const arcPath = direction === 'back' ? 'M7 5a8 8 0 1 0 2.3-1.7' : 'M17 5a8 8 0 1 1-2.3-1.7';

  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={arrowPath} />
      <path d={arcPath} />
      <text
        x="12"
        y="15.5"
        textAnchor="middle"
        fontSize="7.5"
        fill="currentColor"
        stroke="none"
        fontWeight="bold"
      >
        15
      </text>
    </svg>
  );
}

/**
 * Formats seconds as mm:ss.
 */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Fixed-bottom playback bar for TTS.
 * Shows play/pause, skip, speed controls, and progress.
 * Only renders when TTS is active (not idle).
 */
export function TTSPlayer() {
  const {
    status,
    pause,
    resume,
    stop,
    skipForward,
    skipBack,
    seekTo,
    setSpeed,
    currentTime,
    estimatedTotalTime,
    progress,
    speed,
  } = useTTS();

  const barRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragProgress, setDragProgress] = useState(0);

  /** Calculate progress fraction from a pointer event relative to the bar */
  const getProgressFromEvent = useCallback((e: React.PointerEvent | PointerEvent): number => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (status === 'idle' || status === 'loading') return;
      e.preventDefault();
      barRef.current?.setPointerCapture(e.pointerId);
      setIsDragging(true);
      setDragProgress(getProgressFromEvent(e));
    },
    [status, getProgressFromEvent],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      setDragProgress(getProgressFromEvent(e));
    },
    [isDragging, getProgressFromEvent],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      setIsDragging(false);
      const fraction = getProgressFromEvent(e);
      seekTo(fraction * estimatedTotalTime);
    },
    [isDragging, getProgressFromEvent, seekTo, estimatedTotalTime],
  );

  const handlePlayPause = useCallback(() => {
    if (status === 'playing') pause();
    else if (status === 'paused') resume();
  }, [status, pause, resume]);

  const cycleSpeed = useCallback(() => {
    const currentIndex = TTS_SPEEDS.indexOf(speed as (typeof TTS_SPEEDS)[number]);
    const nextIndex = (currentIndex + 1) % TTS_SPEEDS.length;
    setSpeed(TTS_SPEEDS[nextIndex] ?? 1.0);
  }, [speed, setSpeed]);

  // Keyboard shortcuts
  useEffect(() => {
    if (status === 'idle') return;

    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
        return;

      switch (e.key) {
        case 'p':
        case 'P':
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            stop();
          } else {
            handlePlayPause();
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          e.stopPropagation();
          skipBack();
          break;
        case 'ArrowRight':
          e.preventDefault();
          e.stopPropagation();
          skipForward();
          break;
        case ',':
          e.preventDefault();
          setSpeed(Math.max(0.5, speed - 0.25));
          break;
        case '.':
          e.preventDefault();
          setSpeed(Math.min(1.5, speed + 0.25));
          break;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          stop();
          break;
      }
    };

    // Use capture to intercept before ArticleReader's escape handler
    document.addEventListener('keydown', handler, { capture: true });
    return () => document.removeEventListener('keydown', handler, { capture: true });
  }, [status, handlePlayPause, stop, skipBack, skipForward, setSpeed, speed]);

  if (status === 'idle') return null;

  return (
    <div className="fixed right-0 bottom-0 left-0 z-20 border-t border-[rgb(var(--reader-text))]/10 bg-[var(--reader-bg)]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[680px] items-center gap-3 px-4 py-2">
        {/* Controls + progress */}
        <div className="flex flex-1 flex-col gap-1">
          {/* Controls row */}
          <div className="flex items-center justify-center gap-3">
            <Button
              variant="ghost"
              className="h-10 w-10 rounded-full p-0"
              onClick={skipBack}
              disabled={status === 'loading'}
            >
              <Skip15Icon direction="back" className="size-8" />
            </Button>

            <Button
              variant="ghost"
              className="h-12 w-12 rounded-full p-0"
              onClick={handlePlayPause}
              disabled={status === 'loading'}
            >
              {status === 'playing' ? <Pause className="size-7" /> : <Play className="size-7" />}
            </Button>

            <Button
              variant="ghost"
              className="h-10 w-10 rounded-full p-0"
              onClick={skipForward}
              disabled={status === 'loading'}
            >
              <Skip15Icon direction="forward" className="size-8" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              className="min-w-[3rem] font-mono text-xs"
              onClick={cycleSpeed}
            >
              {speed}x
            </Button>
          </div>

          {/* Progress bar with time labels */}
          <div className="flex items-center gap-2">
            <span className="min-w-[3rem] font-mono text-xs text-[rgb(var(--reader-text))]/50">
              {formatTime(isDragging ? dragProgress * estimatedTotalTime : currentTime)}
            </span>
            <div
              ref={barRef}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={Math.round(estimatedTotalTime)}
              aria-valuenow={Math.round(currentTime)}
              aria-label="Audio progress"
              tabIndex={0}
              className="group relative h-2 flex-1 cursor-pointer rounded-full bg-[rgb(var(--reader-text))]/10"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <div
                className={`h-full rounded-full bg-blue-500 ${isDragging ? '' : 'transition-all duration-300'}`}
                style={{
                  width: `${Math.min((isDragging ? dragProgress : progress) * 100, 100)}%`,
                }}
              />
              <div
                className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-500 opacity-0 shadow transition-opacity group-hover:opacity-100"
                style={{
                  left: `${Math.min((isDragging ? dragProgress : progress) * 100, 100)}%`,
                }}
              />
            </div>
            <span className="min-w-[3rem] text-right font-mono text-xs text-[rgb(var(--reader-text))]/50">
              {formatTime(estimatedTotalTime)}
            </span>
          </div>

          {status === 'loading' && (
            <p className="text-center text-xs text-[rgb(var(--reader-text))]/40">
              Loading audio...
            </p>
          )}
        </div>

        {/* Close button — right-aligned, vertically centered */}
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={stop}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
