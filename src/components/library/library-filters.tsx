'use client';

import { useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { TagWithCount } from '@/types';

export interface LibraryFiltersState {
  tagId: number | null;
  dateFrom: string;
  dateTo: string;
  sort: 'createdAt' | 'updatedAt';
  order: 'desc' | 'asc';
}

export const DEFAULT_FILTERS: LibraryFiltersState = {
  tagId: null,
  dateFrom: '',
  dateTo: '',
  sort: 'createdAt',
  order: 'desc',
};

interface LibraryFiltersProps {
  filters: LibraryFiltersState;
  tags: TagWithCount[];
  onChange: (filters: LibraryFiltersState) => void;
}

/**
 * Filter bar for the highlight library: tag, date range, and sort controls.
 * @param props - Current filter state, available tags, and onChange callback
 * @returns Filter bar component
 */
export function LibraryFilters({ filters, tags, onChange }: LibraryFiltersProps) {
  const update = useCallback(
    (partial: Partial<LibraryFiltersState>) => {
      onChange({ ...filters, ...partial });
    },
    [filters, onChange],
  );

  const hasFilters = filters.tagId || filters.dateFrom || filters.dateTo;

  return (
    <div className="space-y-3">
      {tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium">Tag:</span>
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Button
                key={tag.id}
                variant="ghost"
                onClick={() => update({ tagId: filters.tagId === tag.id ? null : tag.id })}
                className="h-auto p-0 hover:bg-transparent dark:hover:bg-transparent"
              >
                <Badge
                  variant={filters.tagId === tag.id ? 'default' : 'secondary'}
                  className="cursor-pointer text-xs"
                >
                  {tag.name}
                  <span className="text-muted-foreground/60 ml-1">{tag.highlightCount}</span>
                </Badge>
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Date range + sort */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs font-medium">From:</span>
        <Input
          type="date"
          value={filters.dateFrom}
          onChange={(e) => update({ dateFrom: e.target.value })}
          className="h-8 w-36 text-xs"
        />
        <span className="text-muted-foreground text-xs font-medium">To:</span>
        <Input
          type="date"
          value={filters.dateTo}
          onChange={(e) => update({ dateTo: e.target.value })}
          className="h-8 w-36 text-xs"
        />

        <span className="text-muted-foreground ml-3 text-xs font-medium">Sort:</span>
        <select
          value={`${filters.sort}-${filters.order}`}
          onChange={(e) => {
            const [sort, order] = e.target.value.split('-') as [
              'createdAt' | 'updatedAt',
              'desc' | 'asc',
            ];
            update({ sort, order });
          }}
          className="border-input bg-background h-8 rounded-md border px-2 text-xs"
        >
          <option value="createdAt-desc">Newest first</option>
          <option value="createdAt-asc">Oldest first</option>
          <option value="updatedAt-desc">Recently updated</option>
        </select>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-8 text-xs"
            onClick={() => onChange(DEFAULT_FILTERS)}
          >
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}
