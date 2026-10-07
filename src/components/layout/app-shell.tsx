'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { SidebarProvider, useSidebar } from './sidebar-context';
import { Sidebar, SIDEBAR_WIDTH } from './sidebar';
import { SearchPalette } from '@/components/search/search-palette';
import type { SidebarData } from './sidebar';

interface AppShellProps {
  children: React.ReactNode;
  sidebarData: SidebarData;
}

const SWIPE_EDGE_ZONE = 20;
const SWIPE_THRESHOLD = 80;

function AppShellInner({ children, sidebarData }: AppShellProps) {
  const { isOpen, open, close, toggle } = useSidebar();
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);
  const isOpenRef = useRef(isOpen);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const isSwiping = useRef(false);

  // Keep ref in sync so stable handlers always read current state
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  // Keyboard shortcuts: Escape to close sidebar, Cmd/Ctrl+\ to toggle sidebar, Cmd/Ctrl+K for palette
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpenRef.current) {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key === '\\' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        const target = e.target as HTMLElement;
        // Suppress when focus is in another input/textarea/contenteditable (not the palette's own input)
        const isOtherFocusable =
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.contentEditable === 'true') &&
          !target.closest('[data-search-palette-input]');
        if (!isOtherFocusable) {
          e.preventDefault();
          setIsPaletteOpen((prev) => !prev);
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [close, toggle]);

  // Swipe gestures for mobile
  useEffect(() => {
    function handleTouchStart(e: TouchEvent) {
      const touch = e.touches[0];
      if (!touch) return;
      touchStartX.current = touch.clientX;
      touchStartY.current = touch.clientY;
      isSwiping.current = isOpenRef.current || touch.clientX < SWIPE_EDGE_ZONE;
    }

    function handleTouchEnd(e: TouchEvent) {
      if (!isSwiping.current) return;
      isSwiping.current = false;

      const touch = e.changedTouches[0];
      if (!touch) return;
      const deltaX = touch.clientX - touchStartX.current;
      const deltaY = Math.abs(touch.clientY - touchStartY.current);

      // Only process horizontal swipes (not vertical scroll)
      if (deltaY > Math.abs(deltaX)) return;

      if (!isOpenRef.current && deltaX > SWIPE_THRESHOLD) {
        open();
      } else if (isOpenRef.current && deltaX < -SWIPE_THRESHOLD) {
        close();
      }
    }

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [open, close]);

  return (
    <>
      <Suspense>
        <Sidebar data={sidebarData} onOpenSearch={() => setIsPaletteOpen(true)} />
      </Suspense>
      <SearchPalette open={isPaletteOpen} onOpenChange={setIsPaletteOpen} />

      {/* Mobile backdrop */}
      <div
        className={cn(
          'fixed inset-0 z-30 bg-black/10 transition-opacity duration-250 md:hidden',
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={close}
        aria-hidden="true"
      />

      {/* Content wrapper — pushes right when sidebar is open */}
      <div
        className="min-h-screen transition-[margin-left] duration-250 ease-out"
        style={{ marginLeft: isOpen ? SIDEBAR_WIDTH : undefined }}
      >
        {children}
      </div>
    </>
  );
}

/**
 * App layout shell with retractable sidebar, backdrop, push animation, and gesture support.
 * @param props.children - Page content to render inside the shell
 * @param props.sidebarData - Server-fetched navigation data for the sidebar
 * @returns Layout wrapper with sidebar provider, sidebar, and content area
 */
export function AppShell({ children, sidebarData }: AppShellProps) {
  return (
    <SidebarProvider>
      <AppShellInner sidebarData={sidebarData}>{children}</AppShellInner>
    </SidebarProvider>
  );
}
