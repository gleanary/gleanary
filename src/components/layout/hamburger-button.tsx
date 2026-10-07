'use client';

import { PanelLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSidebar } from './sidebar-context';

/**
 * Button that opens the sidebar. Renders inline in the page flow.
 * Hidden when the sidebar is open.
 * @param props.className - Additional CSS classes merged via cn()
 * @returns Menu button element, or null when sidebar is open
 */
export function HamburgerButton({ className }: { className?: string }) {
  const { isOpen, open } = useSidebar();

  if (isOpen) return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={open}
      className={className}
      aria-label="Open navigation"
    >
      <PanelLeft className="size-5" />
    </Button>
  );
}
