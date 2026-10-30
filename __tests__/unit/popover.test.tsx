/** @vitest-environment jsdom */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';

describe('Popover accessible name and description', () => {
  it('names the dialog after PopoverTitle via aria-labelledby', () => {
    render(
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>Chat scope</PopoverTitle>
        </PopoverContent>
      </Popover>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Chat scope' });
    const title = screen.getByText('Chat scope');
    expect(title.id).not.toBe('');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
  });

  it('describes the dialog with PopoverDescription via aria-describedby', () => {
    render(
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>Resume listening</PopoverTitle>
          <PopoverDescription>Pick up where you left off</PopoverDescription>
        </PopoverContent>
      </Popover>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Resume listening' });
    const description = screen.getByText('Pick up where you left off');
    expect(description.id).not.toBe('');
    expect(dialog.getAttribute('aria-describedby') ?? '').toContain(description.id);
  });

  it('sets no aria-labelledby when the popover has no title', () => {
    render(
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent>
          <p>untitled content</p>
        </PopoverContent>
      </Popover>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('keeps the popover-title slot and merges className', () => {
    render(
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle className="sr-only">Hidden title</PopoverTitle>
        </PopoverContent>
      </Popover>,
    );

    const title = screen.getByText('Hidden title');
    expect(title.getAttribute('data-slot')).toBe('popover-title');
    expect(title.classList.contains('font-medium')).toBe(true);
    expect(title.classList.contains('sr-only')).toBe(true);
  });

  it('keeps the popover-description slot and muted styling', () => {
    render(
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle>Title</PopoverTitle>
          <PopoverDescription>Some description</PopoverDescription>
        </PopoverContent>
      </Popover>,
    );

    const description = screen.getByText('Some description');
    expect(description.getAttribute('data-slot')).toBe('popover-description');
    expect(description.classList.contains('text-muted-foreground')).toBe(true);
  });
});
