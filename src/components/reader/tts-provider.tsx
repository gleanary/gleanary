'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTTSPlayer } from '@/hooks/useTTSPlayer';
import { patchArticle } from '@/lib/article-api';
import { WordHighlighter } from '@/components/reader/word-highlighter';
import { TTSPlayer } from '@/components/reader/tts-player';
import type { TTSPosition, TTSStatus } from '@/types';

/** How often to auto-save position during playback (ms) */
const SAVE_INTERVAL_MS = 30_000;

interface TTSContextValue {
  status: TTSStatus;
  play: (articleId: number, startParagraph?: number) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  skipForward: () => void;
  skipBack: () => void;
  seekTo: (targetTime: number) => void;
  setSpeed: (speed: number) => void;
  currentParagraph: number;
  currentWordIndex: number;
  currentWords: string[];
  currentTime: number;
  estimatedTotalTime: number;
  progress: number;
  speed: number;
  showResumePrompt: boolean;
  savedPosition: TTSPosition | null;
  resumeFromSaved: () => void;
  startFromBeginning: () => void;
  dismissResumePrompt: () => void;
}

const TTSContext = createContext<TTSContextValue | null>(null);

/**
 * Separate context for the content DOM ref callback.
 * Isolated from TTSContext so consumers (TTSArticleContent) don't re-render
 * when frequently-changing TTS state (word index, time) updates.
 */
const TTSRefContext = createContext<((el: HTMLDivElement | null) => void) | undefined>(undefined);

/**
 * Persists TTS position to the server via PATCH /api/articles/[id].
 * @param articleId - Article to update
 * @param position - Paragraph index and time offset, or null to clear
 */
function saveTTSPositionToServer(articleId: number, position: TTSPosition | null): void {
  const body = position
    ? { ttsParagraph: position.paragraph, ttsTimeOffset: position.timeOffset }
    : { ttsParagraph: null, ttsTimeOffset: null };

  patchArticle(articleId, body, { keepalive: true }).catch(() => {
    // Best-effort save — don't break playback on network errors
  });
}

/**
 * Provides TTS state and controls to child components.
 * Handles position save/restore and resume prompts.
 * Renders the WordHighlighter and TTSPlayer bar.
 * @param children - Child components
 * @param ttsEnabled - Whether TTS is enabled
 * @param articleId - Current article ID for position persistence
 * @param initialTTSPosition - Saved TTS position from server (avoids extra fetch)
 */
export function TTSProvider({
  children,
  ttsEnabled,
  articleId,
  initialTTSPosition,
}: {
  children: React.ReactNode;
  ttsEnabled: boolean;
  articleId: number;
  initialTTSPosition?: TTSPosition | null;
}) {
  const [savedPosition, setSavedPosition] = useState<TTSPosition | null>(
    initialTTSPosition ?? null,
  );
  const [showResumePrompt, setShowResumePrompt] = useState(false);

  /** Called when article finishes playing naturally — clear saved position */
  const handleComplete = useCallback(() => {
    setSavedPosition(null);
    saveTTSPositionToServer(articleId, null);
  }, [articleId]);

  const tts = useTTSPlayer(handleComplete);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Refs for use in effects/intervals to avoid stale closures
  const articleIdRef = useRef(articleId);
  const ttsRef = useRef(tts);

  useEffect(() => {
    articleIdRef.current = articleId;
  }, [articleId]);

  useEffect(() => {
    ttsRef.current = tts;
  });

  const setContentRef = useCallback((el: HTMLDivElement | null) => {
    contentRef.current = el;
  }, []);

  /** Read current position from hook and persist to server + local state */
  const saveCurrentPosition = useCallback(() => {
    const pos = ttsRef.current.getCurrentPosition();
    if (pos && articleIdRef.current) {
      saveTTSPositionToServer(articleIdRef.current, pos);
      setSavedPosition(pos);
    }
  }, []);

  /** Save current position and then stop playback */
  const stopWithSave = useCallback(() => {
    saveCurrentPosition();
    ttsRef.current.stop();
  }, [saveCurrentPosition]);

  /** Save current position on pause */
  const pauseWithSave = useCallback(() => {
    ttsRef.current.pause();
    saveCurrentPosition();
  }, [saveCurrentPosition]);

  /** Wrapped play that shows resume prompt if saved position exists */
  const playWithResume = useCallback(
    (id: number, startParagraph?: number) => {
      if (savedPosition && startParagraph === undefined) {
        setShowResumePrompt(true);
        return;
      }
      tts.play(id, startParagraph);
    },
    [savedPosition, tts],
  );

  /** Resume from saved position */
  const resumeFromSaved = useCallback(() => {
    setShowResumePrompt(false);
    if (savedPosition) {
      tts.play(articleId, savedPosition.paragraph, savedPosition.timeOffset);
    }
  }, [savedPosition, articleId, tts]);

  /** Start from beginning, clearing saved position */
  const startFromBeginning = useCallback(() => {
    setShowResumePrompt(false);
    setSavedPosition(null);
    saveTTSPositionToServer(articleId, null);
    tts.play(articleId, 0);
  }, [articleId, tts]);

  /** Dismiss resume prompt without starting */
  const dismissResumePrompt = useCallback(() => {
    setShowResumePrompt(false);
  }, []);

  // Periodic save during playback (every 30s)
  useEffect(() => {
    if (tts.status !== 'playing') return;

    const intervalId = setInterval(() => {
      const pos = ttsRef.current.getCurrentPosition();
      if (pos && articleIdRef.current) {
        saveTTSPositionToServer(articleIdRef.current, pos);
      }
    }, SAVE_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [tts.status]);

  // Save position on unmount (navigation away while playing)
  useEffect(() => {
    return () => {
      const pos = ttsRef.current.getCurrentPosition();
      if (pos && articleIdRef.current) {
        saveTTSPositionToServer(articleIdRef.current, pos);
      }
    };
  }, []);

  const contextValue = useMemo<TTSContextValue>(
    () => ({
      status: tts.status,
      play: playWithResume,
      pause: pauseWithSave,
      resume: tts.resume,
      stop: stopWithSave,
      skipForward: tts.skipForward,
      skipBack: tts.skipBack,
      seekTo: tts.seekTo,
      setSpeed: tts.setSpeed,
      currentParagraph: tts.currentParagraph,
      currentWordIndex: tts.currentWordIndex,
      currentWords: tts.currentWords,
      currentTime: tts.currentTime,
      estimatedTotalTime: tts.estimatedTotalTime,
      progress: tts.progress,
      speed: tts.speed,
      showResumePrompt,
      savedPosition,
      resumeFromSaved,
      startFromBeginning,
      dismissResumePrompt,
    }),
    [
      tts.status,
      playWithResume,
      pauseWithSave,
      tts.resume,
      stopWithSave,
      tts.skipForward,
      tts.skipBack,
      tts.seekTo,
      tts.setSpeed,
      tts.currentParagraph,
      tts.currentWordIndex,
      tts.currentWords,
      tts.currentTime,
      tts.estimatedTotalTime,
      tts.progress,
      tts.speed,
      showResumePrompt,
      savedPosition,
      resumeFromSaved,
      startFromBeginning,
      dismissResumePrompt,
    ],
  );

  if (!ttsEnabled) {
    return <>{children}</>;
  }

  return (
    <TTSRefContext.Provider value={setContentRef}>
      <TTSContext.Provider value={contextValue}>
        {children}
        <WordHighlighter
          contentRef={contentRef}
          status={tts.status}
          currentParagraph={tts.currentParagraph}
          currentWordIndex={tts.currentWordIndex}
          currentWords={tts.currentWords}
        />
        <TTSPlayer />
      </TTSContext.Provider>
    </TTSRefContext.Provider>
  );
}

/**
 * Hook to access TTS state and controls from child components.
 * Must be used within a TTSProvider.
 */
export function useTTS(): TTSContextValue {
  const ctx = useContext(TTSContext);
  if (!ctx) {
    throw new Error('useTTS must be used within a TTSProvider');
  }
  return ctx;
}

/**
 * Hook that returns the TTS content ref callback if TTS is available.
 * Uses a separate context from TTSContext to avoid re-renders from TTS state changes.
 * Returns undefined if outside TTSProvider — safe to call unconditionally.
 */
export function useTTSContentRef(): ((el: HTMLDivElement | null) => void) | undefined {
  return useContext(TTSRefContext);
}
