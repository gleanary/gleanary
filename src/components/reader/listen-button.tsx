'use client';

import { Headphones, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTTS } from '@/components/reader/tts-provider';

/** Shared className for the full-width option rows in the resume-prompt popover. */
const POPOVER_ITEM_CLASS = 'h-auto w-full justify-start gap-2 px-3 py-2 text-sm font-normal';

/**
 * "Listen" button shown in the reader toolbar.
 * Starts TTS playback for the current article.
 * Shows a resume prompt if a saved position exists.
 * Only rendered when TTS is enabled.
 */
export function ListenButton({ articleId }: { articleId: number }) {
  const {
    status,
    play,
    stop,
    showResumePrompt,
    resumeFromSaved,
    startFromBeginning,
    dismissResumePrompt,
  } = useTTS();

  const isActive = status !== 'idle';

  const handleClick = () => {
    if (isActive) {
      stop();
    } else {
      play(articleId);
    }
  };

  return (
    <Popover open={showResumePrompt} onOpenChange={(open) => !open && dismissResumePrompt()}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" onClick={handleClick} className="gap-1.5">
          <Headphones className={`h-4 w-4 ${isActive ? 'text-blue-500' : ''}`} />
          <span className="hidden sm:inline">{isActive ? 'Stop' : 'Listen'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <Button variant="ghost" className={POPOVER_ITEM_CLASS} onClick={resumeFromSaved}>
          <Play className="h-4 w-4" />
          Resume where you left off
        </Button>
        <Button variant="ghost" className={POPOVER_ITEM_CLASS} onClick={startFromBeginning}>
          <RotateCcw className="h-4 w-4" />
          Start from beginning
        </Button>
      </PopoverContent>
    </Popover>
  );
}
