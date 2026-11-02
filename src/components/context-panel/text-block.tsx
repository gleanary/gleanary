import type { ReactNode } from 'react';

interface TextBlockProps {
  value: string | null;
  /** Rendered when the value is null or empty. */
  emptyState?: ReactNode;
}

/**
 * Multi-line plain text (the AI summary). The value goes through React as text, so it is
 * auto-escaped: if summaries are ever rendered as markdown or HTML, they must go through
 * `renderMarkdown()` → `sanitizeArticleHtml()` first. Never inject model output as HTML.
 * @param props.value - The text, or null
 * @param props.emptyState - Rendered instead when the value is null or empty
 * @returns The text block, the empty state, or nothing
 */
export function TextBlock({ value, emptyState = null }: TextBlockProps) {
  if (!value) return <>{emptyState}</>;
  return (
    <p data-testid="panel-text-block" className="text-sm leading-relaxed whitespace-pre-line">
      {value}
    </p>
  );
}
