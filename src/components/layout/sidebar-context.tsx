'use client';

import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createLocalStorageStore, useLocalStorageStore } from '@/lib/local-storage-store';

const STORAGE_KEY = 'sidebar-open';

interface SidebarContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const sidebarStore = createLocalStorageStore(STORAGE_KEY, (raw) => raw === 'true', false);

/**
 * Provides sidebar open/close state to the entire app. Persists state in localStorage.
 * Reads are hydration-safe (see `useLocalStorageStore`).
 * @param props.children - Child components that can access sidebar state
 * @returns Context provider wrapping children
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const isOpen = useLocalStorageStore(sidebarStore);

  const open = useCallback(() => sidebarStore.set(true), []);
  const close = useCallback(() => sidebarStore.set(false), []);
  const toggle = useCallback(() => sidebarStore.set(!sidebarStore.getSnapshot()), []);

  const value = useMemo(() => ({ isOpen, open, close, toggle }), [isOpen, open, close, toggle]);

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

/**
 * Access sidebar state and actions. Must be used within SidebarProvider.
 * @returns Sidebar context value with isOpen state and open/close/toggle actions
 */
export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return ctx;
}
