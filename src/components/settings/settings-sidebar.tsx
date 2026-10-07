'use client';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export type SettingsSection = 'general' | 'integrations' | 'voice' | 'usage';

const SECTIONS: { value: SettingsSection; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'integrations', label: 'Integrations' },
  { value: 'voice', label: 'Voice' },
  { value: 'usage', label: 'Usage' },
];

interface SettingsSidebarProps {
  active: SettingsSection;
  onSelect: (section: SettingsSection) => void;
}

/**
 * Left sidebar navigation for the settings page.
 * Renders section links: General, Integrations, Voice.
 */
export function SettingsSidebar({ active, onSelect }: SettingsSidebarProps) {
  return (
    <nav className="flex flex-row gap-1 sm:w-44 sm:shrink-0 sm:flex-col" aria-label="Settings">
      {SECTIONS.map(({ value, label }) => (
        <Button
          key={value}
          variant="ghost"
          onClick={() => onSelect(value)}
          aria-current={active === value ? 'page' : undefined}
          className={cn(
            'justify-start',
            active === value
              ? 'bg-secondary text-foreground hover:bg-secondary'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {label}
        </Button>
      ))}
    </nav>
  );
}
