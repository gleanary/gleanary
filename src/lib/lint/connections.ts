import { sql, eq } from 'drizzle-orm';
import { articles, highlights, thesisHighlights } from '@/db/schema';
import { callClaude, LINT_CONNECTIONS_PROMPT, parseLintConnectionValidation } from '@/lib/ai';
import { UTILITY_MODEL } from '@/lib/models';
import { logger } from '@/lib/logger';
import { truncate } from '@/lib/text-utils';
import type { LintContext, Suggestion } from './types';

/** Maximum unlinked highlights scanned before clustering. */
const MAX_UNLINKED = 500;

/** Minimum highlights required for a cluster seed. */
const MIN_CLUSTER_SIZE = 3;

/** Maximum highlights we send to the LLM per cluster. */
const MAX_CLUSTER_SIZE = 10;

/** Cap on total clusters validated by the LLM — bounds worst-case run time. */
const MAX_CLUSTERS = 20;

/** Terms above this frequency are "stop topics" for this KB and ignored. */
const STOP_TOPIC_RATIO = 0.3;

/** Quorum: need ≥10 unlinked highlights from ≥3 articles to run at all. */
const QUORUM_MIN_HIGHLIGHTS = 10;
const QUORUM_MIN_ARTICLES = 3;

/** Shape passed to the pure clustering function. Accepts raw rows from the DB join. */
export interface ClusterableHighlight {
  id: number;
  articleId: number;
  articleTitle: string;
  text: string;
  aiIndex: string | null;
}

/** A cluster seed identified by the pure clustering pass, before LLM validation. */
export interface TopicCluster {
  seedTerm: string;
  highlightIds: number[];
  articleIds: number[];
}

/**
 * Pure in-memory clustering of highlights by shared concept terms extracted
 * from each parent article's `aiIndex` TOPICS line. Deterministic — no LLM.
 *
 * Algorithm:
 *   1. Parse TOPICS and ENTITIES from each highlight's article aiIndex
 *   2. Build inverted index `term → Set<highlightId>`
 *   3. Drop stop-topics (terms in >30% of highlights — dominant themes of the KB)
 *   4. Pick terms with 3-10 highlights from ≥2 distinct articles as cluster seeds
 *   5. Merge seeds whose highlight sets overlap ≥50%
 *   6. Return the top clusters by seed-term rarity
 *
 * @param items - Highlights with their parent article metadata
 * @returns Ordered list of candidate clusters, already capped to `MAX_CLUSTERS`
 */
export function clusterHighlightsByTopics(items: ClusterableHighlight[]): TopicCluster[] {
  if (items.length < 2) return [];

  // Build term → highlightId inverted index.
  const termToHighlights = new Map<string, Set<number>>();
  const highlightToArticle = new Map<number, number>();
  for (const h of items) {
    highlightToArticle.set(h.id, h.articleId);
    const terms = extractTerms(h.aiIndex);
    for (const t of terms) {
      let set = termToHighlights.get(t);
      if (!set) {
        set = new Set<number>();
        termToHighlights.set(t, set);
      }
      set.add(h.id);
    }
  }

  // Drop stop-topics (terms that appear in too many highlights to be distinctive).
  // Floor at MIN_CLUSTER_SIZE so the filter doesn't nuke legitimate clusters in
  // small inputs where a shared topic legitimately covers every highlight.
  const stopThreshold = Math.max(Math.ceil(items.length * STOP_TOPIC_RATIO), MIN_CLUSTER_SIZE);
  for (const [term, set] of termToHighlights) {
    if (set.size > stopThreshold) {
      termToHighlights.delete(term);
    }
  }

  // Pick seeds: a term with MIN_CLUSTER_SIZE–MAX_CLUSTER_SIZE highlights
  // from at least 2 distinct articles.
  const seeds: TopicCluster[] = [];
  for (const [term, set] of termToHighlights) {
    if (set.size < MIN_CLUSTER_SIZE) continue;
    const hIds = Array.from(set).slice(0, MAX_CLUSTER_SIZE);
    const articleIds = Array.from(new Set(hIds.map((id) => highlightToArticle.get(id)!)));
    if (articleIds.length < 2) continue;
    seeds.push({ seedTerm: term, highlightIds: hIds, articleIds });
  }

  // Merge seeds that overlap ≥50% of their highlight set — avoids near-duplicate clusters
  // (e.g., "monetary policy" and "central banking" often cover the same highlights).
  const merged: TopicCluster[] = [];
  const used = new Set<number>();
  for (let i = 0; i < seeds.length; i++) {
    if (used.has(i)) continue;
    let current = seeds[i]!;
    for (let j = i + 1; j < seeds.length; j++) {
      if (used.has(j)) continue;
      const other = seeds[j]!;
      const overlap = current.highlightIds.filter((id) => other.highlightIds.includes(id)).length;
      const smaller = Math.min(current.highlightIds.length, other.highlightIds.length);
      if (smaller > 0 && overlap / smaller >= 0.5) {
        // Merge: keep the more distinctive (smaller) seed term, union the ids.
        const unionIds = Array.from(
          new Set([...current.highlightIds, ...other.highlightIds]),
        ).slice(0, MAX_CLUSTER_SIZE);
        const unionArticles = Array.from(
          new Set(unionIds.map((id) => highlightToArticle.get(id)!)),
        );
        current = {
          seedTerm:
            current.highlightIds.length <= other.highlightIds.length
              ? current.seedTerm
              : other.seedTerm,
          highlightIds: unionIds,
          articleIds: unionArticles,
        };
        used.add(j);
      }
    }
    merged.push(current);
  }

  // Rarer terms first — they identify more specific, actionable clusters.
  merged.sort((a, b) => a.highlightIds.length - b.highlightIds.length);

  return merged.slice(0, MAX_CLUSTERS);
}

/** Extract lowercase, trimmed terms from the TOPICS and ENTITIES lines of an aiIndex string. */
function extractTerms(aiIndex: string | null): string[] {
  if (!aiIndex) return [];
  const terms: string[] = [];
  const topicsMatch = aiIndex.match(/^topics:\s*(.+)$/im);
  if (topicsMatch) {
    terms.push(...splitTerms(topicsMatch[1]!));
  }
  const entitiesMatch = aiIndex.match(/^entities:\s*(.+)$/im);
  if (entitiesMatch) {
    terms.push(...splitTerms(entitiesMatch[1]!));
  }
  return terms;
}

function splitTerms(line: string): string[] {
  return line
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 3 && s.length <= 50);
}

/**
 * Connections lint check — find unlinked highlights from different articles
 * that share concepts and could anchor a new thesis.
 *
 * Hybrid approach: cheap deterministic clustering on aiIndex topics, then one
 * Haiku call per cluster to confirm coherence and propose a thesis title.
 */
export async function* runConnections(ctx: LintContext): AsyncGenerator<Suggestion> {
  const { db } = ctx;

  // Fetch unlinked highlights joined with their parent article metadata.
  const linkedIdsSubquery = db
    .select({ highlightId: thesisHighlights.highlightId })
    .from(thesisHighlights);

  const rows = db
    .select({
      id: highlights.id,
      articleId: highlights.articleId,
      articleTitle: articles.title,
      text: highlights.text,
      aiIndex: articles.aiIndex,
    })
    .from(highlights)
    .innerJoin(articles, eq(articles.id, highlights.articleId))
    .where(sql`${highlights.id} NOT IN ${linkedIdsSubquery}`)
    .orderBy(sql`${highlights.createdAt} DESC`)
    .limit(MAX_UNLINKED)
    .all();

  // Quorum gate.
  const articleCount = new Set(rows.map((r) => r.articleId)).size;
  if (rows.length < QUORUM_MIN_HIGHLIGHTS || articleCount < QUORUM_MIN_ARTICLES) {
    yield {
      type: 'connection',
      description: `Not enough unlinked highlights to cluster (need ≥${QUORUM_MIN_HIGHLIGHTS} from ≥${QUORUM_MIN_ARTICLES} articles, have ${rows.length} from ${articleCount}).`,
      relatedIds: [],
    };
    return;
  }

  const clusters = clusterHighlightsByTopics(rows);

  if (clusters.length === 0) {
    yield {
      type: 'connection',
      description:
        'No obvious cross-article clusters found. Your highlights are either well-organized or too diverse to cluster on shared topics.',
      relatedIds: [],
    };
    return;
  }

  const highlightById = new Map(rows.map((r) => [r.id, r]));

  for (const cluster of clusters) {
    const clusterRows = cluster.highlightIds
      .map((id) => highlightById.get(id))
      .filter((r): r is (typeof rows)[number] => Boolean(r));

    if (clusterRows.length < MIN_CLUSTER_SIZE) continue;

    // Build a compact prompt body — Haiku sees just the highlight text and
    // its article title, NOT the full aiIndex (we already used that for clustering).
    const userMessage = [
      `Seed concept: "${cluster.seedTerm}"`,
      '',
      'Highlights:',
      ...clusterRows.map((h) => `[${h.id}] "${truncate(h.text, 300)}" — from "${h.articleTitle}"`),
    ].join('\n');

    let response: string;
    try {
      response = await callClaude(
        LINT_CONNECTIONS_PROMPT,
        userMessage,
        { feature: 'lint_connections' },
        UTILITY_MODEL,
        512,
      );
    } catch (err) {
      logger.warn(
        { err, event: 'lint_connections_call_failed', seed: cluster.seedTerm },
        'Haiku validation failed for cluster',
      );
      continue;
    }

    const validation = parseLintConnectionValidation(response);
    if (!validation || !validation.coherent || !validation.thesisTitle) continue;

    const excluded = new Set(validation.excludedHighlightIds ?? []);
    const finalIds = cluster.highlightIds.filter((id) => !excluded.has(id));
    if (finalIds.length < MIN_CLUSTER_SIZE) continue;

    yield {
      type: 'connection',
      description: `Potential thesis: ${validation.thesisTitle}`,
      relatedIds: finalIds.map((id) => ({ type: 'highlight' as const, id })),
      suggestedAction: 'Create thesis',
    };
  }
}
