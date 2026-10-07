import type Database from 'better-sqlite3';
import type { ChatMessage, ChatCitation } from '@/types';
import { escapeFts5Query } from '@/lib/search';
import { logger } from '@/lib/logger';
import { ValidationError } from '@/lib/errors';
import { callClaude } from '@/lib/ai';
import { getModelBudget, UTILITY_MODEL, DEFAULT_CHAT_MODEL } from '@/lib/models';

/** Maximum articles returned from FTS5 search */
const MAX_FTS_ARTICLES = 20;

/** Maximum highlights returned from FTS5 search */
const MAX_FTS_HIGHLIGHTS = 30;

/** System prompt for knowledge chat. Instructs citation format and grounding rules. */
export const CHAT_SYSTEM_PROMPT =
  "You are a research assistant with access to the user's reading knowledge base. " +
  'Answer questions by synthesizing information from the provided articles, highlights, and theses.\n\n' +
  'Citation rules:\n' +
  '- Always cite your sources using [article:ID], [highlight:ID], or [thesis:ID] notation.\n' +
  '- Only cite sources from the provided context. Never invent citations.\n' +
  "- When you don't have enough information, say so honestly.\n\n" +
  'Keep your answers focused and well-structured. Use markdown formatting.';

/** Prompt for LLM-based keyword extraction */
const KEYWORD_EXTRACTION_PROMPT =
  "Extract 5-8 search terms from the user's question. Include synonyms and related concepts " +
  'that would help find relevant articles via full-text search. ' +
  'Return ONLY a JSON array of lowercase strings, e.g. ["term1", "term2"]. No other text.';

/** Discriminated union for parsed scopes */
export type ParsedScope =
  | { type: 'all' }
  | { type: 'article'; articleId: number }
  | { type: 'thesis'; thesisId: number }
  | { type: 'tag'; tagName: string }
  | { type: 'recent'; days: number };

/**
 * Parses a scope string into a typed discriminated union.
 * @param scope - Scope string ('all', 'article:{id}', 'thesis:{id}', 'tag:{name}', 'recent:{days}')
 * @returns Parsed scope object
 * @throws ValidationError on invalid format
 */
export function parseScope(scope: string): ParsedScope {
  if (scope === 'all') return { type: 'all' };

  const articleMatch = scope.match(/^article:(\d+)$/);
  if (articleMatch) return { type: 'article', articleId: parseInt(articleMatch[1]!, 10) };

  const thesisMatch = scope.match(/^thesis:(\d+)$/);
  if (thesisMatch) return { type: 'thesis', thesisId: parseInt(thesisMatch[1]!, 10) };

  const tagMatch = scope.match(/^tag:(.+)$/);
  if (tagMatch) return { type: 'tag', tagName: tagMatch[1]! };

  const recentMatch = scope.match(/^recent:(\d+)$/);
  if (recentMatch) return { type: 'recent', days: parseInt(recentMatch[1]!, 10) };

  throw new ValidationError(`Invalid scope: ${scope}`);
}

/** Common English stop words to filter from heuristic keyword extraction */
const STOP_WORDS = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  "aren't",
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  "can't",
  'could',
  "couldn't",
  'did',
  "didn't",
  'do',
  'does',
  "doesn't",
  'doing',
  "don't",
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  "hadn't",
  'has',
  "hasn't",
  'have',
  "haven't",
  'having',
  'he',
  "he'd",
  "he'll",
  "he's",
  'her',
  "here's",
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  "how's",
  'i',
  "i'd",
  "i'll",
  "i'm",
  "i've",
  'if',
  'in',
  'into',
  'is',
  "isn't",
  'it',
  "it's",
  'its',
  'itself',
  'just',
  'me',
  "me'd",
  "me'll",
  "me's",
  'might',
  'more',
  'most',
  "mustn't",
  'my',
  'myself',
  'no',
  'nor',
  'not',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'ought',
  'our',
  'ours',
  'ourselves',
  'out',
  'over',
  'own',
  'same',
  "shan't",
  'she',
  "she'd",
  "she'll",
  "she's",
  'should',
  "shouldn't",
  'so',
  'some',
  'such',
  'than',
  'that',
  "that's",
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  "there's",
  'these',
  'they',
  "they'd",
  "they'll",
  "they're",
  "they've",
  'this',
  'those',
  'through',
  'to',
  'under',
  "shan't",
  'until',
  'up',
  'very',
  'was',
  "wasn't",
  'we',
  "we'd",
  "we'll",
  "we're",
  "we've",
  'were',
  "weren't",
  'what',
  "what's",
  'when',
  "when's",
  'where',
  "where's",
  'which',
  'while',
  'who',
  "who's",
  'whom',
  'why',
  "why's",
  'with',
  "won't",
  'would',
  "wouldn't",
  'you',
  "you'd",
  "you'll",
  "you're",
  "you've",
  'your',
  'yours',
  'yourself',
  'yourselves',
]);

/**
 * Simple heuristic keyword extraction from a question.
 * Removes stop words and limits output to top 10 terms.
 * @param question - User question text
 * @returns Array of lowercase keyword strings
 */
export function extractKeywordsHeuristic(question: string): string[] {
  const words = question
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate and limit to 10
  const unique = Array.from(new Set(words));
  return unique.slice(0, 10);
}

/**
 * LLM-based keyword extraction from a question.
 * Falls back to heuristic if extraction fails.
 * @param question - User question text
 * @param sessionId - Chat session ID for usage tracking (one-off; new utility functions should accept TrackingContext directly)
 * @returns Promise resolving to array of keyword strings
 */
export async function extractKeywords(question: string, sessionId?: number): Promise<string[]> {
  try {
    const response = await callClaude(
      KEYWORD_EXTRACTION_PROMPT,
      question,
      {
        feature: 'chat_keyword_expansion',
        ...(sessionId !== undefined && {
          resourceType: 'chat_session' as const,
          resourceId: sessionId,
        }),
      },
      UTILITY_MODEL,
    );
    const parsed = JSON.parse(response);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed.slice(0, 10);
    }
  } catch {
    logger.warn(
      { event: 'keyword_extraction_failed' },
      'LLM keyword extraction failed, using heuristic',
    );
  }
  // Fallback to heuristic
  return extractKeywordsHeuristic(question);
}

/** Retrieved article for context assembly */
interface RetrievedArticle {
  id: number;
  title: string;
  excerpt: string | null;
  contentMarkdown: string | null;
  contentText: string | null;
  aiIndex: string | null;
}

/** Retrieved highlight for context assembly */
interface RetrievedHighlight {
  id: number;
  articleId: number;
  text: string;
  note: string | null;
  articleTitle: string;
}

/** Retrieved thesis for context assembly */
interface RetrievedThesis {
  id: number;
  title: string;
  claim: string | null;
  counterarguments: string | null;
  implications: string | null;
  notes: string | null;
}

/** Retrieved research entry for context assembly */
interface RetrievedResearch {
  id: number;
  title: string;
  content: string;
}

/** Retrieved highlight with thesis role annotation */
interface RetrievedHighlightWithRole extends RetrievedHighlight {
  role?: 'supporting' | 'opposing' | 'context';
}

/** Result of context retrieval */
export interface RetrievalResult {
  articles: RetrievedArticle[];
  highlights: RetrievedHighlight[];
  theses?: RetrievedThesis[];
  contextText: string;
  totalChars: number;
}

/**
 * Retrieves and assembles context for chat based on scope and keywords.
 * @param scope - Parsed scope
 * @param keywords - Search keywords
 * @param sqlite - Database instance
 * @param model - Model name for budget calculation
 * @returns Retrieval result with assembled context
 */
export function retrieveContext(
  scope: ParsedScope,
  keywords: string[],
  sqlite: Database.Database,
  model: string = DEFAULT_CHAT_MODEL,
): RetrievalResult {
  const { contextBudgetChars } = getModelBudget(model);
  const empty: RetrievalResult = { articles: [], highlights: [], contextText: '', totalChars: 0 };

  if (scope.type === 'article') {
    return retrieveArticleScope(scope.articleId, sqlite, contextBudgetChars);
  }

  if (scope.type === 'thesis') {
    return retrieveThesisScope(scope.thesisId, sqlite, contextBudgetChars);
  }

  if (scope.type === 'tag') {
    return retrieveTagScope(scope.tagName, sqlite, contextBudgetChars);
  }

  if (scope.type === 'recent') {
    return retrieveRecentScope(scope.days, sqlite, contextBudgetChars);
  }

  // scope.type === 'all': FTS5 search
  if (keywords.length === 0) return empty;

  const ftsQuery = keywords
    .map((k) => {
      const escaped = escapeFts5Query(k);
      // Wrap in double-quotes so FTS5 treats multi-word keywords as phrases,
      // not as column:value expressions (e.g. "data driven" → "data driven")
      return escaped ? `"${escaped}"` : '';
    })
    .filter(Boolean)
    .join(' OR ');
  if (!ftsQuery.trim()) return empty;

  const articles = sqlite
    .prepare(
      `SELECT a.id, a.title, a.excerpt, a.content_markdown, a.content_text, a.ai_index
       FROM articles_fts fts
       JOIN articles a ON a.id = fts.rowid
       WHERE articles_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, MAX_FTS_ARTICLES) as Array<{
    id: number;
    title: string;
    excerpt: string | null;
    content_markdown: string | null;
    content_text: string | null;
    ai_index: string | null;
  }>;

  const highlights = sqlite
    .prepare(
      `SELECT h.id, h.article_id, h.text, h.note, a.title AS article_title
       FROM highlights_fts fts
       JOIN highlights h ON h.id = fts.rowid
       JOIN articles a ON a.id = h.article_id
       WHERE highlights_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(ftsQuery, MAX_FTS_HIGHLIGHTS) as Array<{
    id: number;
    article_id: number;
    text: string;
    note: string | null;
    article_title: string;
  }>;

  const mappedArticles: RetrievedArticle[] = articles.map((a) => ({
    id: a.id,
    title: a.title,
    excerpt: a.excerpt,
    contentMarkdown: a.content_markdown,
    contentText: a.content_text,
    aiIndex: a.ai_index,
  }));

  const mappedHighlights: RetrievedHighlight[] = highlights.map((h) => ({
    id: h.id,
    articleId: h.article_id,
    text: h.text,
    note: h.note,
    articleTitle: h.article_title,
  }));

  return assembleContext(mappedArticles, mappedHighlights, contextBudgetChars);
}

/**
 * Retrieves context for a single article scope.
 * @param articleId - Article ID
 * @param sqlite - Database instance
 * @param contextBudgetChars - Character budget for context assembly
 * @returns Retrieval result with article and its highlights
 */
function retrieveArticleScope(
  articleId: number,
  sqlite: Database.Database,
  contextBudgetChars: number,
): RetrievalResult {
  const article = sqlite
    .prepare(
      `SELECT id, title, excerpt, content_markdown, content_text, ai_index
       FROM articles WHERE id = ?`,
    )
    .get(articleId) as
    | {
        id: number;
        title: string;
        excerpt: string | null;
        content_markdown: string | null;
        content_text: string | null;
        ai_index: string | null;
      }
    | undefined;

  if (!article) {
    return { articles: [], highlights: [], contextText: '', totalChars: 0 };
  }

  const highlights = sqlite
    .prepare(
      `SELECT h.id, h.article_id, h.text, h.note, a.title AS article_title
       FROM highlights h
       JOIN articles a ON a.id = h.article_id
       WHERE h.article_id = ?
       ORDER BY h.created_at`,
    )
    .all(articleId) as Array<{
    id: number;
    article_id: number;
    text: string;
    note: string | null;
    article_title: string;
  }>;

  const mappedArticle: RetrievedArticle = {
    id: article.id,
    title: article.title,
    excerpt: article.excerpt,
    contentMarkdown: article.content_markdown,
    contentText: article.content_text,
    aiIndex: article.ai_index,
  };

  const mappedHighlights: RetrievedHighlight[] = highlights.map((h) => ({
    id: h.id,
    articleId: h.article_id,
    text: h.text,
    note: h.note,
    articleTitle: h.article_title,
  }));

  return assembleContext([mappedArticle], mappedHighlights, contextBudgetChars);
}

/**
 * Fetches articles by a list of IDs and maps them to RetrievedArticle format.
 * Shared helper for thesis/tag/recent scope retrievers.
 * @param articleIds - Array of article IDs to fetch
 * @param sqlite - Database instance
 * @returns Array of RetrievedArticle objects
 */
function fetchArticlesByIds(articleIds: number[], sqlite: Database.Database): RetrievedArticle[] {
  if (articleIds.length === 0) return [];
  const rows = sqlite
    .prepare(
      `SELECT id, title, excerpt, content_markdown, content_text, ai_index
       FROM articles WHERE id IN (${articleIds.map(() => '?').join(',')})`,
    )
    .all(...articleIds) as Array<{
    id: number;
    title: string;
    excerpt: string | null;
    content_markdown: string | null;
    content_text: string | null;
    ai_index: string | null;
  }>;
  return rows.map((a) => ({
    id: a.id,
    title: a.title,
    excerpt: a.excerpt,
    contentMarkdown: a.content_markdown,
    contentText: a.content_text,
    aiIndex: a.ai_index,
  }));
}

/**
 * Retrieves context for a thesis scope: the thesis itself, linked highlights grouped
 * by role, research entries, and parent articles.
 * @param thesisId - Thesis ID
 * @param sqlite - Database instance
 * @param contextBudgetChars - Character budget for context assembly
 * @returns Retrieval result with thesis, highlights, and articles
 */
function retrieveThesisScope(
  thesisId: number,
  sqlite: Database.Database,
  contextBudgetChars: number,
): RetrievalResult {
  const thesis = sqlite
    .prepare(
      'SELECT id, title, claim, counterarguments, implications, notes FROM theses WHERE id = ?',
    )
    .get(thesisId) as RetrievedThesis | undefined;

  if (!thesis) {
    return { articles: [], highlights: [], contextText: '', totalChars: 0 };
  }

  // Fetch linked highlights with roles
  const linkedHighlights = sqlite
    .prepare(
      `SELECT h.id, h.article_id, h.text, h.note, a.title AS article_title, th.role
       FROM thesis_highlights th
       JOIN highlights h ON h.id = th.highlight_id
       JOIN articles a ON a.id = h.article_id
       WHERE th.thesis_id = ?
       ORDER BY th.role, th.added_at`,
    )
    .all(thesisId) as Array<{
    id: number;
    article_id: number;
    text: string;
    note: string | null;
    article_title: string;
    role: 'supporting' | 'opposing' | 'context';
  }>;

  // Fetch research entries
  const research = sqlite
    .prepare(
      'SELECT id, title, content FROM thesis_research WHERE thesis_id = ? ORDER BY created_at',
    )
    .all(thesisId) as RetrievedResearch[];

  // Collect unique article IDs and fetch articles
  const articleIds = [...new Set(linkedHighlights.map((h) => h.article_id))];
  const mappedArticles = fetchArticlesByIds(articleIds, sqlite);

  const mappedHighlights: RetrievedHighlightWithRole[] = linkedHighlights.map((h) => ({
    id: h.id,
    articleId: h.article_id,
    text: h.text,
    note: h.note,
    articleTitle: h.article_title,
    role: h.role,
  }));

  return assembleThesisContext(
    thesis,
    mappedHighlights,
    research,
    mappedArticles,
    contextBudgetChars,
  );
}

/**
 * Retrieves context for a tag scope: all highlights with the given tag and their parent articles.
 * @param tagName - Tag name (case-insensitive lookup)
 * @param sqlite - Database instance
 * @param contextBudgetChars - Character budget for context assembly
 * @returns Retrieval result with tagged highlights and their articles
 */
function retrieveTagScope(
  tagName: string,
  sqlite: Database.Database,
  contextBudgetChars: number,
): RetrievalResult {
  const tag = sqlite.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(tagName) as
    { id: number } | undefined;

  if (!tag) {
    return { articles: [], highlights: [], contextText: '', totalChars: 0 };
  }

  const highlights = sqlite
    .prepare(
      `SELECT h.id, h.article_id, h.text, h.note, a.title AS article_title
       FROM highlight_tags ht
       JOIN highlights h ON h.id = ht.highlight_id
       JOIN articles a ON a.id = h.article_id
       WHERE ht.tag_id = ?
       ORDER BY h.created_at DESC`,
    )
    .all(tag.id) as Array<{
    id: number;
    article_id: number;
    text: string;
    note: string | null;
    article_title: string;
  }>;

  // Collect unique articles
  const articleIds = [...new Set(highlights.map((h) => h.article_id))];
  const mappedArticles = fetchArticlesByIds(articleIds, sqlite);

  const mappedHighlights: RetrievedHighlight[] = highlights.map((h) => ({
    id: h.id,
    articleId: h.article_id,
    text: h.text,
    note: h.note,
    articleTitle: h.article_title,
  }));

  return assembleContext(mappedArticles, mappedHighlights, contextBudgetChars);
}

/** Maximum days for recent scope */
const MAX_RECENT_DAYS = 365;

/**
 * Retrieves context for a recent scope: articles saved in the last N days and their highlights.
 * @param days - Number of days to look back (capped at 365)
 * @param sqlite - Database instance
 * @param contextBudgetChars - Character budget for context assembly
 * @returns Retrieval result with recent articles and highlights
 */
function retrieveRecentScope(
  days: number,
  sqlite: Database.Database,
  contextBudgetChars: number,
): RetrievalResult {
  const cappedDays = Math.min(days, MAX_RECENT_DAYS);

  const articleRows = sqlite
    .prepare(
      `SELECT id, title, excerpt, content_markdown, content_text, ai_index
       FROM articles
       WHERE saved_at >= datetime('now', ? || ' days')
       ORDER BY saved_at DESC
       LIMIT ?`,
    )
    .all(`-${cappedDays}`, MAX_FTS_ARTICLES) as Array<{
    id: number;
    title: string;
    excerpt: string | null;
    content_markdown: string | null;
    content_text: string | null;
    ai_index: string | null;
  }>;

  if (articleRows.length === 0) {
    return { articles: [], highlights: [], contextText: '', totalChars: 0 };
  }

  const articleIds = articleRows.map((a) => a.id);
  const highlightRows = sqlite
    .prepare(
      `SELECT h.id, h.article_id, h.text, h.note, a.title AS article_title
       FROM highlights h
       JOIN articles a ON a.id = h.article_id
       WHERE h.article_id IN (${articleIds.map(() => '?').join(',')})
       ORDER BY h.created_at DESC
       LIMIT ?`,
    )
    .all(...articleIds, MAX_FTS_HIGHLIGHTS) as Array<{
    id: number;
    article_id: number;
    text: string;
    note: string | null;
    article_title: string;
  }>;

  const mappedArticles: RetrievedArticle[] = articleRows.map((a) => ({
    id: a.id,
    title: a.title,
    excerpt: a.excerpt,
    contentMarkdown: a.content_markdown,
    contentText: a.content_text,
    aiIndex: a.ai_index,
  }));

  const mappedHighlights: RetrievedHighlight[] = highlightRows.map((h) => ({
    id: h.id,
    articleId: h.article_id,
    text: h.text,
    note: h.note,
    articleTitle: h.article_title,
  }));

  return assembleContext(mappedArticles, mappedHighlights, contextBudgetChars);
}

/**
 * Assembles context specifically for thesis scope, grouping highlights by role
 * with clear section headers. Priority: thesis → highlights by role → research → articles.
 * @param thesis - The thesis being discussed
 * @param highlights - Linked highlights with role annotations
 * @param research - Research entries for the thesis
 * @param articles - Parent articles of the linked highlights
 * @param contextBudgetChars - Character budget
 * @returns Retrieval result with formatted thesis context
 */
function assembleThesisContext(
  thesis: RetrievedThesis,
  highlights: RetrievedHighlightWithRole[],
  research: RetrievedResearch[],
  articles: RetrievedArticle[],
  contextBudgetChars: number,
): RetrievalResult {
  const blocks: string[] = [];
  let totalChars = 0;

  // Priority 1: Thesis metadata (always include)
  const thesisBlock = [
    `[thesis:${thesis.id}] "${thesis.title}"`,
    thesis.claim ? `Claim: ${thesis.claim}` : null,
    thesis.counterarguments ? `Counterarguments: ${thesis.counterarguments}` : null,
    thesis.implications ? `Implications: ${thesis.implications}` : null,
    thesis.notes ? `Notes: ${thesis.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  blocks.push(thesisBlock);
  totalChars += thesisBlock.length;

  // Priority 2: Highlights grouped by role
  const byRole: Record<string, RetrievedHighlightWithRole[]> = {
    supporting: [],
    opposing: [],
    context: [],
  };
  for (const h of highlights) {
    const role = h.role ?? 'context';
    byRole[role]!.push(h);
  }

  const roleHeaders: Record<string, string> = {
    supporting: '## Supporting Evidence',
    opposing: '## Opposing Evidence',
    context: '## Context',
  };

  for (const role of ['supporting', 'opposing', 'context'] as const) {
    const group = byRole[role]!;
    if (group.length === 0) continue;

    const header = roleHeaders[role]!;
    if (totalChars + header.length > contextBudgetChars) break;
    blocks.push(header);
    totalChars += header.length;

    for (const h of group) {
      const block =
        `[highlight:${h.id}] From "${h.articleTitle}":\n> ${h.text}` +
        (h.note ? `\nNote: ${h.note}` : '');
      if (totalChars + block.length > contextBudgetChars) break;
      blocks.push(block);
      totalChars += block.length;
    }
  }

  // Priority 3: Research entries (truncated to 5K chars each)
  if (research.length > 0 && totalChars < contextBudgetChars) {
    blocks.push('## Research');
    totalChars += 12;

    for (const r of research) {
      const truncatedContent = r.content.slice(0, 5_000);
      const block = `**${r.title}**\n${truncatedContent}`;
      if (totalChars + block.length > contextBudgetChars) break;
      blocks.push(block);
      totalChars += block.length;
    }
  }

  // Priority 4: Article content (lowest priority, excerpt only for thesis scope)
  for (const a of articles) {
    const block = `[article:${a.id}] "${a.title}":\n${a.excerpt ?? '(no excerpt)'}`;
    if (totalChars + block.length > contextBudgetChars) break;
    blocks.push(block);
    totalChars += block.length;
  }

  return {
    articles,
    highlights,
    theses: [thesis],
    contextText: blocks.join('\n\n'),
    totalChars,
  };
}

/**
 * Assembles retrieved articles and highlights into a formatted context string,
 * respecting the token budget. Prioritizes highlights over full article content.
 * @param articles - Array of retrieved articles
 * @param highlights - Array of retrieved highlights
 * @param contextBudgetChars - Character budget for context (model-aware)
 * @returns Retrieval result with formatted context text
 */
function assembleContext(
  articles: RetrievedArticle[],
  highlights: RetrievedHighlight[],
  contextBudgetChars: number,
): RetrievalResult {
  const blocks: string[] = [];
  let totalChars = 0;

  // Priority 1: Highlights (user-selected signal, most valuable)
  for (const h of highlights) {
    const block =
      `[highlight:${h.id}] From "${h.articleTitle}":\n> ${h.text}` +
      (h.note ? `\nNote: ${h.note}` : '');
    if (totalChars + block.length > contextBudgetChars) break;
    blocks.push(block);
    totalChars += block.length;
  }

  // Priority 2: Article excerpts and content
  for (const a of articles) {
    // Use excerpt first as a compact representation
    const content =
      (a.contentMarkdown ?? a.contentText ?? '').slice(0, 10_000) || (a.excerpt ?? '');
    const block = `[article:${a.id}] "${a.title}":\n${content}`;
    if (totalChars + block.length > contextBudgetChars) {
      // Full content doesn't fit — try with just excerpt
      const excerptBlock = `[article:${a.id}] "${a.title}":\n${a.excerpt ?? '(no excerpt)'}`;
      if (totalChars + excerptBlock.length <= contextBudgetChars) {
        blocks.push(excerptBlock);
        totalChars += excerptBlock.length;
      }
      continue;
    }
    blocks.push(block);
    totalChars += block.length;
  }

  return {
    articles,
    highlights,
    contextText: blocks.join('\n\n'),
    totalChars,
  };
}

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Builds conversation history for LLM context, applying a sliding window for long conversations.
 * @param messages - Array of message objects with role and content
 * @param budgetChars - Character budget for history (unused in current implementation, fixed window)
 * @returns Array of message parameters for API
 */
export function buildConversationHistory(
  messages: Pick<ChatMessage, 'role' | 'content'>[],
  budgetChars: number,
): MessageParam[] {
  if (messages.length <= 8) {
    // Short conversation: include everything
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  // Keep first 2 (establishes context) + last 6
  const first = messages.slice(0, 2);
  const last = messages.slice(-6);

  const result = [
    ...first.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: '[Earlier messages omitted for brevity]' },
    ...last.map((m) => ({ role: m.role, content: m.content })),
  ];

  // Trim from the back if over budget (conservative approach)
  let charCount = result.reduce((sum, m) => sum + m.content.length, 0);
  if (charCount > budgetChars) {
    // Remove from middle (keep first 2 + summary, keep last message)
    const toRemove = result.slice(3, -1).reverse();
    for (const msg of toRemove) {
      result.splice(result.indexOf(msg), 1);
      charCount -= msg.content.length;
      if (charCount <= budgetChars) break;
    }
  }

  return result;
}

/**
 * Formats retrieved context into a string suitable for inclusion in the LLM system prompt.
 * @param result - Retrieval result
 * @returns Formatted context string to append to system prompt
 */
export function formatContextForPrompt(result: RetrievalResult): string {
  if (!result.contextText) {
    return '\n\n## Retrieved Context\nNo relevant content found in the knowledge base for this query.';
  }
  const tokenEstimate = Math.round(result.totalChars / 4);
  return `\n\n## Retrieved Context (~${tokenEstimate} tokens)\n\n${result.contextText}`;
}

/**
 * Parses citation markers from LLM response text and validates them against the database.
 * @param text - LLM response text
 * @param sqlite - Database instance
 * @returns Array of validated citation objects
 */
export function parseCitations(text: string, sqlite: Database.Database): ChatCitation[] {
  const citations: ChatCitation[] = [];
  const pattern = /\[(article|highlight|thesis):(\d+)\]/g;

  let match;
  const seen = new Set<string>();

  while ((match = pattern.exec(text)) !== null) {
    const type = match[1] as 'article' | 'highlight' | 'thesis';
    const id = parseInt(match[2]!, 10);
    const key = `${type}:${id}`;

    if (seen.has(key)) continue;
    seen.add(key);

    if (type === 'article') {
      const article = sqlite.prepare('SELECT id, title FROM articles WHERE id = ?').get(id) as
        { id: number; title: string } | undefined;
      if (article) {
        citations.push({
          type: 'article',
          id: article.id,
          title: article.title,
        });
      }
    } else if (type === 'highlight') {
      const highlight = sqlite
        .prepare(
          `SELECT h.id, h.text, a.title AS article_title
           FROM highlights h
           JOIN articles a ON a.id = h.article_id
           WHERE h.id = ?`,
        )
        .get(id) as
        | {
            id: number;
            text: string;
            article_title: string;
          }
        | undefined;
      if (highlight) {
        citations.push({
          type: 'highlight',
          id: highlight.id,
          title: highlight.text.slice(0, 100),
          snippet: highlight.text,
        });
      }
    } else if (type === 'thesis') {
      const thesis = sqlite.prepare('SELECT id, title FROM theses WHERE id = ?').get(id) as
        { id: number; title: string } | undefined;
      if (thesis) {
        citations.push({
          type: 'thesis',
          id: thesis.id,
          title: thesis.title,
        });
      }
    }
  }

  return citations;
}
