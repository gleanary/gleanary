'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/text-utils';
import type { NewsletterApprovalStatus } from '@/types';

interface NewsletterCardProps {
  id: number;
  name: string;
  senderAddress: string | null;
  articleCount: number;
  lastReceivedAt: string | null;
  status: NewsletterApprovalStatus;
  recentSubjects?: string[];
  onApprove: (id: number) => Promise<void>;
  onBlock: (id: number) => Promise<void>;
}

const STATUS_BADGE: Record<
  NewsletterApprovalStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  pending: { label: 'Pending', variant: 'outline' },
  approved: { label: 'Approved', variant: 'default' },
  blocked: { label: 'Blocked', variant: 'destructive' },
};

/**
 * Card displaying a newsletter sender with approve/block actions.
 * @param props - Newsletter sender data and action callbacks
 */
export function NewsletterCard({
  id,
  name,
  senderAddress,
  articleCount,
  lastReceivedAt,
  status,
  recentSubjects,
  onApprove,
  onBlock,
}: NewsletterCardProps) {
  const [loading, setLoading] = useState(false);

  async function handleAction(action: 'approve' | 'block') {
    setLoading(true);
    try {
      if (action === 'approve') {
        await onApprove(id);
      } else {
        await onBlock(id);
      }
    } finally {
      setLoading(false);
    }
  }

  const badgeConfig = STATUS_BADGE[status];

  return (
    <div className="border-border flex items-center justify-between rounded-lg border p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          <Badge variant={badgeConfig.variant}>{badgeConfig.label}</Badge>
        </div>
        <div className="text-muted-foreground mt-1 text-xs">
          {senderAddress}
          {' · '}
          {articleCount} {articleCount === 1 ? 'article' : 'articles'}
          {lastReceivedAt && (
            <>
              {' · '}
              Last: {formatDate(lastReceivedAt)}
            </>
          )}
        </div>
        {status === 'pending' && recentSubjects && recentSubjects.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {recentSubjects.slice(0, 5).map((subject, i) => (
              <li key={i} className="text-muted-foreground truncate text-xs">
                <span className="mr-1.5 opacity-50">Subject:</span>
                {subject}
              </li>
            ))}
            {recentSubjects.length > 5 && (
              <li className="text-muted-foreground text-xs italic">
                +{recentSubjects.length - 5} more
              </li>
            )}
          </ul>
        )}
        {status === 'pending' && (
          <p className="text-muted-foreground mt-1 text-xs italic">
            Articles hidden until approved
          </p>
        )}
      </div>
      <div className="ml-4 flex gap-2">
        {status !== 'approved' && (
          <Button
            size="sm"
            variant="default"
            disabled={loading}
            onClick={() => handleAction('approve')}
          >
            Approve
          </Button>
        )}
        {status !== 'blocked' && (
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => handleAction('block')}
          >
            Block
          </Button>
        )}
        {status === 'blocked' && (
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => handleAction('approve')}
          >
            Unblock
          </Button>
        )}
      </div>
    </div>
  );
}
