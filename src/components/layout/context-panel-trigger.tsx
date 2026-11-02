'use client';

import { PanelRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isMacPlatform } from '@/lib/platform';
import { TopBarButton } from './top-bar';
import { CONTEXT_PANEL_SHEET_ID, useContextPanel } from './context-panel-context';

/**
 * Toolbar button toggling the context panel (mirrors the sidebar's `PanelLeft`). Renders
 * only once the page has registered content (client-side, so no SSR mismatch). On desktop
 * it toggles the side sheet, and a keyboard activation (`click` with `detail === 0`) moves
 * focus into it; below `md` it opens the modal bottom sheet.
 * @returns The trigger button, or null when the page has no panel
 */
export function ContextPanelTrigger() {
  const { isOpen, presentation, hasContent, toggle, triggerRef } = useContextPanel();
  if (!hasContent) return null;

  return (
    <TopBarButton
      ref={triggerRef}
      data-testid="context-panel-trigger"
      onClick={(e) => toggle({ focusPanel: e.detail === 0 })}
      aria-label="Toggle details panel"
      aria-expanded={isOpen}
      // The sheet exists only while open (Radix unmounts it); the aside is always mounted
      aria-controls={
        presentation === 'side' ? 'context-panel' : isOpen ? CONTEXT_PANEL_SHEET_ID : undefined
      }
      title={isMacPlatform() ? 'Details (⌘⇧\\)' : 'Details (Ctrl+Shift+\\)'}
      className={cn(isOpen && 'bg-secondary text-foreground')}
    >
      <PanelRight className="h-4 w-4" />
    </TopBarButton>
  );
}
