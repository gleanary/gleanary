import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

interface TagListProps {
  tags: string[];
  /** Rendered when there are no tags. */
  emptyState?: ReactNode;
}

/**
 * A wrapping list of tag pills (the article's AI tags).
 * @param props.tags - Tag names
 * @param props.emptyState - Rendered instead when there are no tags
 * @returns The tag list, the empty state, or nothing
 */
export function TagList({ tags, emptyState = null }: TagListProps) {
  if (tags.length === 0) return <>{emptyState}</>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <li key={tag}>
          <Badge variant="secondary">{tag}</Badge>
        </li>
      ))}
    </ul>
  );
}
