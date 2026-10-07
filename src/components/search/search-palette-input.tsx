'use client';

import { forwardRef } from 'react';
import { Search, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SearchPaletteInputProps {
  value: string;
  onChange: (value: string) => void;
  hasResults: boolean;
  activeItemId: string | undefined;
  isLoading: boolean;
  onClose: () => void;
  /** Called with the key name for navigation keys handled by the parent reducer */
  onKeyNav: (key: string) => void;
}

/**
 * Combobox input for the search palette.
 * Implements WAI-ARIA combobox pattern: DOM focus stays here; active option is
 * communicated via aria-activedescendant (virtual focus).
 */
export const SearchPaletteInput = forwardRef<HTMLInputElement, SearchPaletteInputProps>(
  function SearchPaletteInput(
    { value, onChange, hasResults, activeItemId, isLoading, onClose, onKeyNav },
    ref,
  ) {
    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      const { key } = e;
      if (key === 'Tab') {
        e.preventDefault();
        onClose();
        return;
      }
      if (
        key === 'ArrowDown' ||
        key === 'ArrowUp' ||
        key === 'Home' ||
        key === 'End' ||
        key === 'Enter'
      ) {
        e.preventDefault();
        onKeyNav(key);
      }
    }

    return (
      <div className="border-border flex items-center gap-2 border-b px-4 py-3">
        <Search size={16} className="text-muted-foreground shrink-0" aria-hidden="true" />
        <input
          ref={ref}
          // Marks this as the palette's own input — suppresses the global Cmd/Ctrl+K guard
          data-search-palette-input="true"
          role="combobox"
          aria-expanded={hasResults}
          aria-controls="search-palette-listbox"
          aria-activedescendant={activeItemId}
          aria-autocomplete="list"
          aria-label="Search"
          type="text"
          placeholder="Search articles, highlights, theses…"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          className="placeholder:text-muted-foreground flex-1 bg-transparent text-sm outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        {isLoading && value.length >= 2 && (
          <Loader2
            size={14}
            className="text-muted-foreground shrink-0 animate-spin"
            aria-hidden="true"
          />
        )}
        {/* Mobile-only close: full-screen palette has no overlay to tap and no Escape key */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close search"
          className="text-muted-foreground hover:text-foreground shrink-0 hover:bg-transparent sm:hidden dark:hover:bg-transparent"
        >
          <X className="size-[18px]" />
        </Button>
      </div>
    );
  },
);
