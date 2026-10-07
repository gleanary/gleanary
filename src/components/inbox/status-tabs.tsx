'use client';

import type { ArticleStatus } from '@/types';
import { TopBar, TopBarButton } from '@/components/layout/top-bar';

const STATUS_TABS: { value: ArticleStatus | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'reading', label: 'Reading' },
  { value: 'archived', label: 'Archived' },
];

interface StatusTabsProps {
  activeStatus: ArticleStatus | null;
  isFavoriteFilter: boolean;
  onChange: (status: ArticleStatus | null, isFavorite: boolean) => void;
  title?: string;
}

/**
 * Tab bar for filtering articles by status or favorites, with sidebar toggle.
 * @param activeStatus - Currently selected status filter (null = All)
 * @param isFavoriteFilter - Whether the favorites filter is active
 * @param onChange - Callback when a tab is clicked
 */
export function StatusTabs({ activeStatus, isFavoriteFilter, onChange, title }: StatusTabsProps) {
  return (
    <TopBar>
      {title && <span className="text-foreground mr-1 px-2 text-sm font-semibold">{title}</span>}
      {STATUS_TABS.map((tab) => (
        <TopBarButton
          key={tab.label}
          onClick={() => onChange(tab.value, false)}
          className={
            !isFavoriteFilter && activeStatus === tab.value
              ? 'bg-secondary text-foreground font-medium'
              : undefined
          }
        >
          {tab.label}
        </TopBarButton>
      ))}
      <TopBarButton
        onClick={() => onChange(null, true)}
        className={isFavoriteFilter ? 'bg-secondary text-foreground font-medium' : undefined}
      >
        Favorites
      </TopBarButton>
    </TopBar>
  );
}
