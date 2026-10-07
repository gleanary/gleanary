'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface UsageSummary {
  totalUsd: number;
  callCount: number;
  budgetUsd: number | null;
  range: string;
}

/**
 * Sidebar footer widget showing monthly AI spend and optional budget.
 * Subscribes to the 'usage:changed' DOM event emitted after each streaming call.
 * Clicking navigates to /settings?tab=usage.
 */
export function UsageFooter() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  useEffect(() => {
    function load() {
      fetch('/api/usage/summary?range=month')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) setSummary(data);
        })
        .catch(() => {});
    }

    load();
    document.addEventListener('usage:changed', load);
    return () => document.removeEventListener('usage:changed', load);
  }, []);

  if (!summary) return null;

  const spent = summary.totalUsd.toFixed(2);
  const budget = summary.budgetUsd;
  const overBudget = budget !== null && summary.totalUsd > budget;

  return (
    <Link
      href="/settings?tab=usage"
      className="text-sidebar-foreground/60 hover:text-sidebar-foreground block px-3 pb-1 text-xs transition-colors"
    >
      {budget !== null ? (
        <>
          <div className="flex justify-between">
            <span>AI spend (month)</span>
            <span className={overBudget ? 'text-warning font-medium' : ''}>
              ${spent} / ${budget.toFixed(2)}
            </span>
          </div>
          <div className="bg-sidebar-accent mt-1 h-1 w-full overflow-hidden rounded-full">
            <div
              className={`h-full rounded-full transition-all ${overBudget ? 'bg-warning' : 'bg-sidebar-foreground/30'}`}
              style={{ width: `${Math.min((summary.totalUsd / budget) * 100, 100)}%` }}
            />
          </div>
        </>
      ) : (
        <div className="flex justify-between">
          <span>AI spend (month)</span>
          <span>${spent}</span>
        </div>
      )}
    </Link>
  );
}
