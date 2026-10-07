'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DraftCard } from './draft-card';
import { listAllDrafts } from '@/lib/draft-api';
import { useRefreshOnMount } from '@/hooks/use-refresh-on-mount';
import { TEMPLATES } from '@/lib/content-templates';
import type { DraftListItem } from '@/lib/draft-api';
import type { TemplateId, DraftStatus } from '@/types';

type TemplateFilter = 'all' | TemplateId;
type StatusFilter = 'all' | DraftStatus;

const TEMPLATE_OPTIONS: Array<{ value: TemplateFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'blog', label: TEMPLATES.blog.name },
  { value: 'linkedin', label: TEMPLATES.linkedin.name },
  { value: 'youtube', label: TEMPLATES.youtube.name },
];

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
];

/**
 * Filters a draft list by template and status. Pure function exported for testing.
 * @param drafts - Full list of drafts
 * @param filters - Template and status filter values
 * @returns Filtered array
 */
export function filterDrafts(
  drafts: DraftListItem[],
  filters: { template: TemplateFilter; status: StatusFilter },
): DraftListItem[] {
  return drafts.filter((d) => {
    if (filters.template !== 'all' && d.templateId !== filters.template) return false;
    if (filters.status !== 'all' && d.status !== filters.status) return false;
    return true;
  });
}

interface DraftListProps {
  initialDrafts: DraftListItem[];
}

/**
 * Client component rendering the cross-thesis draft list with template/status filters.
 * @param props.initialDrafts - SSR-fetched drafts; refreshed on mount to pick up navigation changes
 * @returns Draft list with filter bar
 */
export function DraftList({ initialDrafts }: DraftListProps) {
  const [drafts, setDrafts] = useState<DraftListItem[]>(initialDrafts);
  const [templateFilter, setTemplateFilter] = useState<TemplateFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useRefreshOnMount(async () => {
    const fresh = await listAllDrafts().catch(() => null);
    if (fresh) setDrafts(fresh);
  });

  const filtered = filterDrafts(drafts, { template: templateFilter, status: statusFilter });

  return (
    <div>
      <div className="mb-4 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium">Template:</span>
          <div className="flex flex-wrap gap-1">
            {TEMPLATE_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                variant="ghost"
                onClick={() => setTemplateFilter(opt.value)}
                className="h-auto p-0 hover:bg-transparent dark:hover:bg-transparent"
              >
                <Badge
                  variant={templateFilter === opt.value ? 'default' : 'secondary'}
                  className="cursor-pointer text-xs"
                >
                  {opt.label}
                </Badge>
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium">Status:</span>
          <div className="flex flex-wrap gap-1">
            {STATUS_OPTIONS.map((opt) => (
              <Button
                key={opt.value}
                variant="ghost"
                onClick={() => setStatusFilter(opt.value)}
                className="h-auto p-0 hover:bg-transparent dark:hover:bg-transparent"
              >
                <Badge
                  variant={statusFilter === opt.value ? 'default' : 'secondary'}
                  className="cursor-pointer text-xs"
                >
                  {opt.label}
                </Badge>
              </Button>
            ))}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="text-muted-foreground py-16 text-center">
          {drafts.length === 0 ? (
            <>
              <p className="text-lg">No drafts yet.</p>
              <p className="mt-2 text-sm">Open a thesis to start one.</p>
            </>
          ) : (
            <p className="text-sm">No drafts match the selected filters.</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((draft) => (
            <DraftCard key={draft.id} draft={draft} showThesis />
          ))}
        </div>
      )}
    </div>
  );
}
