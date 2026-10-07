import { describe, it, expect } from 'vitest';
import { filterDrafts } from '@/components/drafts/draft-list';
import type { DraftListItem } from '@/lib/draft-api';

function makeDraft(overrides: Partial<DraftListItem>): DraftListItem {
  return {
    id: 1,
    thesisId: 1,
    thesisTitle: 'Test Thesis',
    templateId: 'blog',
    title: 'Test Draft',
    angle: null,
    status: 'draft',
    generatedAt: null,
    lastEditedAt: null,
    publishedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

const drafts: DraftListItem[] = [
  makeDraft({ id: 1, templateId: 'blog', status: 'draft' }),
  makeDraft({ id: 2, templateId: 'linkedin', status: 'draft' }),
  makeDraft({ id: 3, templateId: 'youtube', status: 'published' }),
  makeDraft({ id: 4, templateId: 'blog', status: 'published' }),
];

describe('filterDrafts', () => {
  it('returns all drafts when both filters are all', () => {
    const result = filterDrafts(drafts, { template: 'all', status: 'all' });
    expect(result).toHaveLength(4);
  });

  it('filters by template', () => {
    const result = filterDrafts(drafts, { template: 'blog', status: 'all' });
    expect(result).toHaveLength(2);
    expect(result.every((d) => d.templateId === 'blog')).toBe(true);
  });

  it('filters by status', () => {
    const result = filterDrafts(drafts, { template: 'all', status: 'published' });
    expect(result).toHaveLength(2);
    expect(result.every((d) => d.status === 'published')).toBe(true);
  });

  it('applies template and status together', () => {
    const result = filterDrafts(drafts, { template: 'blog', status: 'published' });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(4);
  });

  it('returns empty array when no drafts match', () => {
    const result = filterDrafts(drafts, { template: 'linkedin', status: 'published' });
    expect(result).toHaveLength(0);
  });
});
