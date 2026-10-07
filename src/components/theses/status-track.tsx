'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { THESIS_STATUSES } from '@/types';
import type { ThesisStatus } from '@/types';

const STATUS_LABELS: Record<ThesisStatus, string> = {
  nascent: 'Nascent',
  developing: 'Developing',
  researched: 'Researched',
  ready: 'Ready',
  used: 'Used',
};

interface StatusTrackProps {
  status: ThesisStatus;
  onChange?: (status: ThesisStatus) => void;
  readonly?: boolean;
}

/**
 * Visual status progression track for theses.
 * Clicking a step transitions the thesis to that status.
 * @param props - Current status, optional change handler, and readonly flag
 */
export function StatusTrack({ status, onChange, readonly = false }: StatusTrackProps) {
  const currentIndex = THESIS_STATUSES.indexOf(status);

  return (
    <div className="flex items-center gap-1" aria-label={`Thesis status: ${STATUS_LABELS[status]}`}>
      {THESIS_STATUSES.map((s, i) => {
        const isCompleted = i < currentIndex;
        const isCurrent = i === currentIndex;

        return (
          <Button
            key={s}
            type="button"
            variant="ghost"
            size="xs"
            disabled={readonly}
            onClick={() => onChange?.(s)}
            className={cn(
              'h-auto rounded-full px-2.5 py-0.5 font-medium hover:bg-transparent disabled:opacity-100 dark:hover:bg-transparent',
              isCurrent && 'thesis-status-current ring-2 ring-offset-1',
              isCompleted && 'thesis-status-done opacity-60',
              !isCurrent && !isCompleted && 'thesis-status-pending opacity-40',
              !readonly && 'cursor-pointer hover:opacity-80',
              readonly && 'cursor-default',
            )}
            title={readonly ? STATUS_LABELS[s] : `Set to ${STATUS_LABELS[s]}`}
          >
            {STATUS_LABELS[s]}
          </Button>
        );
      })}
    </div>
  );
}

/** Compact status badge (single pill, no interaction) */
export function StatusBadge({ status }: { status: ThesisStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        status === 'nascent' && 'bg-tint-slate text-tint-slate-fg',
        status === 'developing' && 'bg-tint-blue text-tint-blue-fg',
        status === 'researched' && 'bg-tint-purple text-tint-purple-fg',
        status === 'ready' && 'bg-tint-green text-tint-green-fg',
        status === 'used' && 'bg-tint-amber text-tint-amber-fg',
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}
