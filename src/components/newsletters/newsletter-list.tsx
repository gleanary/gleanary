'use client';

import { useState, useCallback } from 'react';
import { NewsletterCard } from './newsletter-card';
import { TopBarButton } from '@/components/layout/top-bar';
import type { NewsletterApprovalStatus } from '@/types';

interface NewsletterItem {
  id: number;
  name: string;
  senderAddress: string | null;
  isBlocked: boolean | null;
  lastReceivedAt: string | null;
  articleCount: number;
  status: NewsletterApprovalStatus;
}

const TABS: { value: NewsletterApprovalStatus | null; label: string }[] = [
  { value: null, label: 'All' },
  { value: 'approved', label: 'Approved' },
  { value: 'pending', label: 'Pending' },
  { value: 'blocked', label: 'Blocked' },
];

interface NewsletterListProps {
  newsletters: NewsletterItem[];
  pendingCount: number;
  recentSubjects: Record<number, string[]>;
}

/**
 * Newsletter management list with status filter tabs.
 * @param newsletters - Initial list of newsletter sources
 * @param pendingCount - Number of pending sources for badge display
 * @param recentSubjects - Map of source ID to recent article subjects (for pending sources)
 */
export function NewsletterList({
  newsletters: initial,
  pendingCount: initialPending,
  recentSubjects,
}: NewsletterListProps) {
  const [activeTab, setActiveTab] = useState<NewsletterApprovalStatus | null>(null);
  const [newsletters, setNewsletters] = useState(initial);
  const [pendingCount, setPendingCount] = useState(initialPending);

  const refreshData = useCallback(async () => {
    const res = await fetch('/api/newsletters');
    if (res.ok) {
      const data = await res.json();
      setNewsletters(data.newsletters);
      setPendingCount(data.pendingCount);
    }
  }, []);

  const handleAction = useCallback(
    async (id: number, isBlocked: boolean) => {
      const res = await fetch(`/api/newsletters/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isBlocked }),
      });
      if (res.ok) {
        await refreshData();
      }
    },
    [refreshData],
  );

  const handleApprove = useCallback((id: number) => handleAction(id, false), [handleAction]);
  const handleBlock = useCallback((id: number) => handleAction(id, true), [handleAction]);

  const filtered = activeTab ? newsletters.filter((n) => n.status === activeTab) : newsletters;

  return (
    <div>
      <div className="mb-4 flex gap-1">
        {TABS.map((tab) => (
          <TopBarButton
            key={tab.label}
            onClick={() => setActiveTab(tab.value)}
            className={
              activeTab === tab.value ? 'bg-secondary text-foreground font-medium' : undefined
            }
          >
            {tab.label}
            {tab.value === 'pending' && pendingCount > 0 && (
              <span className="bg-destructive text-destructive-foreground ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs font-medium">
                {pendingCount}
              </span>
            )}
          </TopBarButton>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-sm">
          {activeTab === 'pending'
            ? 'No pending senders to review.'
            : activeTab === 'blocked'
              ? 'No blocked senders.'
              : 'No newsletter senders yet. Send an email to your configured address to get started.'}
        </p>
      ) : (
        <div className="space-y-3">
          {filtered.map((newsletter) => (
            <NewsletterCard
              key={newsletter.id}
              id={newsletter.id}
              name={newsletter.name}
              senderAddress={newsletter.senderAddress}
              articleCount={newsletter.articleCount}
              lastReceivedAt={newsletter.lastReceivedAt}
              status={newsletter.status}
              recentSubjects={recentSubjects[newsletter.id]}
              onApprove={handleApprove}
              onBlock={handleBlock}
            />
          ))}
        </div>
      )}
    </div>
  );
}
