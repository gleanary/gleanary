'use client';

import { ContextPanelPortal } from '@/components/layout/context-panel';
import type { ContextPanelTab } from '@/types';

// Placeholder until the widgets land (module 22, session 3)
const TABS: ContextPanelTab[] = [
  {
    id: 'details',
    label: 'Details',
    sections: [
      {
        id: 'about',
        label: 'About',
        content: (
          <p className="text-sidebar-foreground/60 text-sm">Article details will appear here.</p>
        ),
      },
    ],
  },
];

/**
 * The reader page's context panel content. Rendered inside the reader's providers, so its
 * widgets can use `useArticle()` and `useTTS()`; the content is portaled into the shell.
 * @returns The panel portal
 */
export function ReaderContextPanel() {
  return <ContextPanelPortal title="Details" tabs={TABS} />;
}
