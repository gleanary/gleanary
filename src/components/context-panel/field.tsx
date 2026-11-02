import type { ReactNode } from 'react';

interface FieldProps {
  label: string;
  /** A single value; null or '' renders an em-dash. */
  value: ReactNode;
}

/**
 * One label/value row of a context panel section (author, site, dates, length).
 * Renders a `<dt>`/`<dd>` pair, so rows go inside a `<dl>`.
 * @param props.label - Row label
 * @param props.value - Single value; null or '' renders an em-dash
 * @returns The field row
 */
export function Field({ label, value }: FieldProps) {
  const isEmpty = value == null || value === '';
  return (
    <div data-testid="panel-field" className="grid grid-cols-[5.5rem_1fr] gap-x-3 text-sm">
      <dt className="text-sidebar-foreground/60">{label}</dt>
      <dd className="min-w-0 break-words">{isEmpty ? '—' : value}</dd>
    </div>
  );
}
