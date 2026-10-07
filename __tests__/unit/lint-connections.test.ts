import { describe, it, expect } from 'vitest';
import { clusterHighlightsByTopics } from '@/lib/lint/connections';

/**
 * Pure-logic tests for the topic-clustering helper used by the connections
 * lint check. The clustering step is deterministic and runs before any LLM
 * call, so we can unit-test it without mocks.
 */
describe('clusterHighlightsByTopics', () => {
  it('returns no clusters when fewer than 2 articles are involved', () => {
    const clusters = clusterHighlightsByTopics([
      {
        id: 1,
        articleId: 1,
        articleTitle: 'A',
        text: 'first',
        aiIndex: 'TOPICS: ai, regulation\nENTITIES: openai',
      },
      {
        id: 2,
        articleId: 1,
        articleTitle: 'A',
        text: 'second',
        aiIndex: 'TOPICS: ai, regulation\nENTITIES: openai',
      },
    ]);
    expect(clusters).toHaveLength(0);
  });

  it('clusters highlights from different articles that share topics', () => {
    const clusters = clusterHighlightsByTopics([
      {
        id: 1,
        articleId: 10,
        articleTitle: 'Article Alpha',
        text: 'alpha text',
        aiIndex: 'TOPICS: regulatory capture, central banking',
      },
      {
        id: 2,
        articleId: 11,
        articleTitle: 'Article Beta',
        text: 'beta text',
        aiIndex: 'TOPICS: regulatory capture, lobbying',
      },
      {
        id: 3,
        articleId: 12,
        articleTitle: 'Article Gamma',
        text: 'gamma text',
        aiIndex: 'TOPICS: regulatory capture, corporate influence',
      },
    ]);

    expect(clusters.length).toBeGreaterThanOrEqual(1);
    const cluster = clusters[0]!;
    expect(cluster.highlightIds).toContain(1);
    expect(cluster.highlightIds).toContain(2);
    expect(cluster.highlightIds).toContain(3);
    expect(cluster.seedTerm).toBe('regulatory capture');
  });

  it('drops stop-topics that appear in too many highlights', () => {
    // "technology" appears in 5/5 highlights → >30% threshold → should be dropped
    // "quantum" appears in only 2 highlights but from 2 different articles → should cluster
    const highlights = [
      {
        id: 1,
        articleId: 1,
        articleTitle: 'A',
        text: 't1',
        aiIndex: 'TOPICS: technology, quantum',
      },
      {
        id: 2,
        articleId: 2,
        articleTitle: 'B',
        text: 't2',
        aiIndex: 'TOPICS: technology, quantum',
      },
      { id: 3, articleId: 3, articleTitle: 'C', text: 't3', aiIndex: 'TOPICS: technology, ai' },
      { id: 4, articleId: 4, articleTitle: 'D', text: 't4', aiIndex: 'TOPICS: technology, ai' },
      {
        id: 5,
        articleId: 5,
        articleTitle: 'E',
        text: 't5',
        aiIndex: 'TOPICS: technology, biology',
      },
    ];
    const clusters = clusterHighlightsByTopics(highlights);
    // "technology" should never be a seed since it appears in 100% of highlights
    expect(clusters.every((c) => c.seedTerm !== 'technology')).toBe(true);
  });

  it('ignores highlights with no aiIndex', () => {
    const clusters = clusterHighlightsByTopics([
      {
        id: 1,
        articleId: 1,
        articleTitle: 'A',
        text: 't1',
        aiIndex: null,
      },
      {
        id: 2,
        articleId: 2,
        articleTitle: 'B',
        text: 't2',
        aiIndex: null,
      },
    ]);
    expect(clusters).toHaveLength(0);
  });

  it('parses TOPICS line case-insensitively and trims whitespace', () => {
    const clusters = clusterHighlightsByTopics([
      {
        id: 1,
        articleId: 1,
        articleTitle: 'A',
        text: 't1',
        aiIndex: 'TOPICS:  Central Banking ,  Monetary Policy  \nENTITIES: fed',
      },
      {
        id: 2,
        articleId: 2,
        articleTitle: 'B',
        text: 't2',
        aiIndex: 'topics: central banking, inflation\nENTITIES: ecb',
      },
      {
        id: 3,
        articleId: 3,
        articleTitle: 'C',
        text: 't3',
        aiIndex: 'TOPICS: central banking, bretton woods',
      },
    ]);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]!.seedTerm).toBe('central banking');
  });

  it('caps cluster size at 10 highlights', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      articleId: i + 1,
      articleTitle: `Article ${i + 1}`,
      text: `text ${i + 1}`,
      aiIndex: 'TOPICS: shared topic',
    }));
    const clusters = clusterHighlightsByTopics(items);
    for (const c of clusters) {
      expect(c.highlightIds.length).toBeLessThanOrEqual(10);
    }
  });
});
