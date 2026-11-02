'use client';

import { PanelRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isMacPlatform } from '@/lib/platform';
import { TopBarButton } from './top-bar';
import { useContextPanel } from './context-panel-context';

/**
 * Toolbar button toggling the context panel (mirrors the sidebar's `PanelLeft`). Renders
 * only once the page has registered content (client-side, so no SSR mismatch) and only on
 * desktop. A keyboard activation (`click` with `detail === 0`) moves focus into the panel.
 * @returns The trigger button, or null when the page has no panel or on mobile
 */
export function ContextPanelTrigger() {
  const { isOpen, isAvailable, toggle, triggerRef } = useContextPanel();
  if (!isAvailable) return null;

  return (
    <TopBarButton
      ref={triggerRef}
      onClick={(e) => toggle({ focusPanel: e.detail === 0 })}
      aria-label="Toggle details panel"
      aria-expanded={isOpen}
      aria-controls="context-panel"
      title={isMacPlatform() ? 'Details (⌘⇧\\)' : 'Details (Ctrl+Shift+\\)'}
      className={cn(isOpen && 'bg-secondary text-foreground')}
    >
      <PanelRight className="h-4 w-4" />
    </TopBarButton>
  );
}
