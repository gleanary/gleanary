'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

const STORAGE_KEY = 'sidebar-open';

interface SidebarContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

// --- localStorage-backed store for sidebar state ---

const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Write to localStorage and notify all subscribers. */
function setSidebarOpen(value: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage unavailable — silently ignore
  }
  listeners.forEach((cb) => cb());
}

/**
 * Provides sidebar open/close state to the entire app. Persists state in localStorage.
 * Uses useSyncExternalStore for hydration-safe reads.
 * @param props.children - Child components that can access sidebar state
 * @returns Context provider wrapping children
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const isOpen = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const open = useCallback(() => setSidebarOpen(true), []);
  const close = useCallback(() => setSidebarOpen(false), []);
  const toggle = useCallback(() => setSidebarOpen(!getSnapshot()), []);

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
