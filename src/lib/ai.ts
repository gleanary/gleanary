import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { logger } from '@/lib/logger';
import { ExternalServiceError, ValidationError } from '@/lib/errors';
import { getConfig } from '@/lib/settings';
import { trackAiCall } from '@/lib/ai-usage';
import { DEFAULT_FEATURE_MODEL } from '@/lib/models';
import type { ThesisSuggestion, HighlightSuggestion, ThesisHighlightRole } from '@/types';
import type { TrackingContext } from '@/lib/ai-usage';

/** Maximum content length sent to Claude (chars). ~100K chars ≈ ~25K tokens. */
export const MAX_CONTENT_LENGTH = 100_000;

/** Reformat-specific limit. Output token count scales with input length; 50K chars
 *  stays within the 300s Mistral timeout and 240s Haiku timeout at typical throughput. */
export const MAX_REFORMAT_LENGTH = 50_000;

// --- System Prompts ---

/** System prompt for article summarization */
export const SUMMARIZE_PROMPT =
  'You are a reading assistant. Summarize the following article in 2-3 concise sentences. Focus on the key points and main argument. Return only the summary text, no prefixes or labels.';

/** System prompt for auto-tagging articles */
export const AUTO_TAG_PROMPT =
  'You are a librarian. Given an article and a list of existing tags, suggest 2-5 tags that categorize this article. Prefer existing tags when they fit. For new tags, use lowercase kebab-case. Return ONLY a JSON array of tag name strings, e.g. ["tag-one", "tag-two"]. No other text.';

/** System prompt for explaining a highlighted passage */
export const EXPLAIN_PROMPT =
  'You are a reading assistant. Explain the following highlighted passage from an article, providing context and meaning. Be concise (2-4 sentences).';

/** System prompt for explaining why a passage is important */
export const IMPORTANCE_PROMPT =
  'You are a reading assistant. Explain why the following highlighted passage is important or noteworthy in the context of the article. Be concise (2-4 sentences).';

/** Maps explain mode to its system prompt. Add new modes here — validation and routing follow automatically. */
export const EXPLAIN_MODES = {
  explain: EXPLAIN_PROMPT,
  importance: IMPORTANCE_PROMPT,
} as const;

/** System prompt for suggesting theses from highlights */
export const THESIS_SUGGEST_PROMPT =
  'You are an intellectual assistant helping a knowledge worker form arguments from their reading highlights. Given a list of highlights and existing theses, suggest new theses that represent specific, arguable claims — not vague topics. A good thesis is a claim someone could disagree with. Return ONLY a JSON array of suggestion objects with keys: title (string, concise claim title), claim (string, 1-3 sentences), relevantHighlightIds (number[]), confidence (number 0-1). No other text.';

/** System prompt for suggesting relevant highlights for a thesis */
export const HIGHLIGHT_SUGGEST_PROMPT =
  'You are an intellectual assistant. Given a thesis and a list of available highlights, identify which highlights are most relevant to the thesis and explain their role. Return ONLY a JSON array of objects with keys: highlightId (number), suggestedRole (one of: "supporting", "opposing", "context"), reason (string, 1 sentence). No other text.';

// --- Knowledge Linting Prompts ---

/** System prompt for validating a pre-clustered set of highlights and proposing a thesis title. */
export const LINT_CONNECTIONS_PROMPT =
  'You are reviewing a cluster of highlights from different articles that appear to share a concept. ' +
  'Determine whether the cluster is genuinely coherent (the highlights all speak to the same claim or tension), ' +
  'and if so, propose a concise thesis title (8-15 words) that captures what they collectively argue. ' +
  'If any highlights are outliers that should be excluded, list their IDs. ' +
  'Return ONLY a JSON object: { "coherent": boolean, "thesisTitle"?: string, "excludedHighlightIds"?: number[] }. ' +
  'No markdown, no prose, no wrapping text.';

/** System prompt for per-thesis gap analysis. */
export const LINT_GAPS_PROMPT =
  "You are a critical reader reviewing a thesis in the user's knowledge base. " +
  'Look for ONE specific weakness: missing counterargument, missing research, vague claim, or imbalanced evidence. ' +
  'If the thesis is well-developed with no obvious gap, return { "hasGap": false }. ' +
  'Otherwise return { "hasGap": true, "gapType": "counterargument"|"research"|"vague_claim"|"imbalance", "description": string, "suggestedAction": string }. ' +
  'Descriptions should be specific and actionable (1-2 sentences), not generic. ' +
  'Return ONLY valid JSON. No markdown, no prose, no wrapping text.';

/** System prompt for detecting contradictions among user-written notes. */
export const LINT_CONTRADICTIONS_NOTES_PROMPT =
  "You are reviewing annotated highlights from a user's reading knowledge base. " +
  'Find pairs or small clusters of user notes that directly contradict each other — not merely unrelated, but actually in tension. ' +
  'Ignore notes that are complementary or neutral. ' +
  'Return ONLY a JSON array: [{ "highlightIds": number[], "description": string }]. ' +
  'Each description explains the contradiction in one sentence. Maximum 10 items. ' +
  'If no contradictions exist, return []. No markdown, no prose, no wrapping text.';

/** System prompt for explaining user-marked supporting/opposing highlight pairs. */
export const LINT_CONTRADICTIONS_TENSION_PROMPT =
  'You are explaining tensions in a thesis that has both supporting and opposing highlights. ' +
  'For each supporting/opposing pair below, write one sentence describing the specific tension — what claim they disagree on. ' +
  'Use the pair index (the leading [N]) as the identifier. ' +
  'Return ONLY a JSON array: [{ "pairIndex": number, "description": string }]. ' +
  'No markdown, no prose, no wrapping text.';

/** System prompt for generating a concept index from an article for FTS5 retrieval */
export const CONCEPT_INDEX_PROMPT =
  'Given this article, produce a structured concept index for search retrieval. ' +
  'This index is NOT for human reading — it will be searched by keywords. ' +
  'Be comprehensive with synonyms and related terms.\n\n' +
  'Format (use exactly these headers):\n' +
  'TOPICS: [comma-separated concepts, themes, and keywords]\n' +
  'ENTITIES: [people, companies, organizations, technologies, places mentioned]\n' +
  'ARGUMENTS FOR: [key claims or positions the article supports]\n' +
  'ARGUMENTS AGAINST: [key claims or positions the article challenges or critiques]\n' +
  'RELATED CONCEPTS: [broader themes, synonyms, adjacent ideas not directly discussed but relevant for discovery]';

/** System prompt for AI content cleanup / reformatting */
export const AI_CLEAN_PROMPT =
  'You are a content formatter. Reformat this article into clean, well-structured semantic HTML suitable for a reader application.\n\n' +
  'Rules:\n' +
  '- Preserve ALL text content, links, videos, and image URLs. Do not summarize or omit.\n' +
  '- Preserve all <iframe> and <video> elements exactly as-is (YouTube, Vimeo, and other video embeds). Do not remove, summarize, or convert them.\n' +
  '- Convert sequences of images (logos, partner grids) into a simple list or remove if they are decorative and not part of the article content.\n' +
  '- Convert carousel/slideshow content into clearly separated sections using blockquotes with attribution.\n' +
  '- Remove decorative/spacer elements.\n' +
  '- Ensure proper heading hierarchy (h1 > h2 > h3).\n' +
  '- Use semantic HTML: <section>, <blockquote>, <figure>, <figcaption>, <ul>/<ol>, <p>, <h1>-<h6>.\n' +
  '- Do not include <style>, <script>, or inline style attributes.\n' +
  '- Output only the HTML body content. No commentary, no wrapping <html> or <body> tags, no markdown code fences.';

/** Valid explain mode keys */
export type ExplainMode = keyof typeof EXPLAIN_MODES;

/** Claude model to use for all AI features */
const MODEL = DEFAULT_FEATURE_MODEL;

/** Default request timeout in milliseconds. */
const TIMEOUT_MS = 30_000;

// --- Singleton client ---

let _client: Anthropic | null = null;
let _clientConfigKey: string = '';

/**
 * Returns the Anthropic SDK client singleton.
 * Recreates the client if the configured API key has changed.
 * @returns Anthropic client instance
 */
function getClient(): Anthropic {
  const apiKey = getConfig('anthropic_api_key');
  if (!_client || _clientConfigKey !== apiKey) {
    _client = new Anthropic({
      apiKey: apiKey || undefined,
      timeout: TIMEOUT_MS,
      ...(process.env.NODE_ENV === 'test' && { maxRetries: 0 }),
    });
    _clientConfigKey = apiKey;
  }
  return _client;
}

/**
 * Resets the Anthropic client singleton. Used in tests to pick up env changes.
 */
export function resetClient(): void {
  _client = null;
  _clientConfigKey = '';
}

/**
 * Truncates content to a length limit, appending a notice if truncated.
 * @param content - The article content to potentially truncate
 * @param limit - Maximum character length (defaults to MAX_CONTENT_LENGTH)
 * @returns Content within the length limit
 */
export function truncateContent(content: string, limit = MAX_CONTENT_LENGTH): string {
  if (content.length <= limit) return content;
  const suffix = '\n\n[Content truncated]';
  return content.slice(0, limit - suffix.length) + suffix;
}

/**
 * Parses Claude's tag suggestion response into a clean array of lowercase tag names.
 * Handles JSON embedded in surrounding text, deduplicates, and filters invalid entries.
 * @param response - Raw text response from Claude
 * @returns Array of cleaned, deduplicated tag name strings
 */
export function parseTagsResponse(response: string): string[] {
  if (!response) return [];

  // Extract JSON array from response (may be surrounded by text)
  const match = response.match(/\[[\s\S]*?\]/);
  if (!match) return [];

  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    const seen = new Set<string>();
    const result: string[] = [];

    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const cleaned = item.trim().toLowerCase();
      if (!cleaned) continue;
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      result.push(cleaned);
    }

    return result;
  } catch {
    return [];
  }
}

/** Valid thesis-highlight role values (inline to avoid circular imports with types) */
const VALID_ROLES: ThesisHighlightRole[] = ['supporting', 'opposing', 'context'];

/**
 * Extracts the first JSON object substring from a possibly noisy LLM response.
 * Strips markdown code fences before matching so responses like ```json {...} ``` work.
 * @param response - Raw text response from Claude
 * @returns The matched JSON object string, or null if none found
 */
function extractJsonObject(response: string): string | null {
  if (!response) return null;
  const cleaned = response.replace(/```json\s*/gi, '').replace(/```/g, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

/**
 * Extracts the first JSON array substring from a possibly noisy LLM response.
 * Strips markdown code fences before matching.
 * @param response - Raw text response from Claude
 * @returns The matched JSON array string, or null if none found
 */
function extractJsonArray(response: string): string | null {
  if (!response) return null;
  const cleaned = response.replace(/```json\s*/gi, '').replace(/```/g, '');
  const match = cleaned.match(/\[[\s\S]*\]/);
  return match ? match[0] : null;
}

/**
 * Parses Claude's thesis suggestion response into a structured array.
 * Extracts JSON from surrounding text, filters invalid entries.
 * @param response - Raw text response from Claude
 * @returns Array of thesis suggestions
 */
export function parseThesisSuggestions(response: string): ThesisSuggestion[] {
  const json = extractJsonArray(response);
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ThesisSuggestion => {
      if (typeof item !== 'object' || item === null) return false;
      const r = item as Record<string, unknown>;
      return typeof r.title === 'string' && Array.isArray(r.relevantHighlightIds);
    });
  } catch {
    return [];
  }
}

/**
 * Parses Claude's highlight suggestion response into a structured array.
 * Extracts JSON from surrounding text, filters invalid entries.
 * @param response - Raw text response from Claude
 * @returns Array of highlight suggestions with roles and reasoning
 */
export function parseHighlightSuggestions(response: string): HighlightSuggestion[] {
  const json = extractJsonArray(response);
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is HighlightSuggestion =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).highlightId === 'number' &&
        VALID_ROLES.includes(
          (item as Record<string, unknown>).suggestedRole as ThesisHighlightRole,
        ),
    );
  } catch {
    return [];
  }
}

/** Result of the per-cluster connection-validation call. */
export interface LintConnectionValidation {
  coherent: boolean;
  thesisTitle?: string;
  excludedHighlightIds?: number[];
}

/**
 * Parses the LLM response for the connection-cluster validation step.
 * Despite explicit instructions, Haiku occasionally wraps JSON in markdown fences.
 * This function strips them and tolerates trailing prose. Returns a default (incoherent)
 * object if JSON is malformed, ensuring the caller always gets a valid result.
 * @param response - Raw text response from Claude
 * @returns A LintConnectionValidation object (never null)
 */
export function parseLintConnectionValidation(response: string): LintConnectionValidation {
  const json = extractJsonObject(response);
  if (!json) return { coherent: false };
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.coherent !== 'boolean') return { coherent: false };
    const result: LintConnectionValidation = { coherent: parsed.coherent };
    if (typeof parsed.thesisTitle === 'string' && parsed.thesisTitle.trim().length > 0) {
      result.thesisTitle = parsed.thesisTitle.trim();
    }
    if (Array.isArray(parsed.excludedHighlightIds)) {
      result.excludedHighlightIds = parsed.excludedHighlightIds.filter(
        (n): n is number => typeof n === 'number' && Number.isInteger(n),
      );
    }
    return result;
  } catch {
    return { coherent: false };
  }
}

/** Valid gap-type values returned by the gap-analysis LLM call. */
const GAP_TYPES = ['counterargument', 'research', 'vague_claim', 'imbalance'] as const;

/** Result of the per-thesis gap analysis call. */
export interface LintGap {
  hasGap: boolean;
  gapType?: (typeof GAP_TYPES)[number];
  description?: string;
  suggestedAction?: string;
}

/**
 * Parses the LLM response for per-thesis gap analysis.
 * Despite explicit instructions, Haiku occasionally wraps JSON in markdown fences.
 * This function strips them and tolerates trailing prose. Returns a default (no gap)
 * object if JSON is malformed, ensuring the caller always gets a valid result.
 * @param response - Raw text response from Claude
 * @returns A LintGap object (never null)
 */
export function parseLintGaps(response: string): LintGap {
  const json = extractJsonObject(response);
  if (!json) return { hasGap: false };
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (typeof parsed.hasGap !== 'boolean') return { hasGap: false };
    const result: LintGap = { hasGap: parsed.hasGap };
    if (!parsed.hasGap) return result;
    if (typeof parsed.description === 'string') result.description = parsed.description;
    if (typeof parsed.suggestedAction === 'string') {
      result.suggestedAction = parsed.suggestedAction;
    }
    if (
      typeof parsed.gapType === 'string' &&
      (GAP_TYPES as readonly string[]).includes(parsed.gapType)
    ) {
      result.gapType = parsed.gapType as LintGap['gapType'];
    }
    return result;
  } catch {
    return { hasGap: false };
  }
}

/** A single contradiction cluster identified among user-written notes. */
export interface LintContradictionItem {
  highlightIds: number[];
  description: string;
}

/**
 * Parses the LLM response for note-contradictions detection.
 * Degrades gracefully: returns an empty array on any parse failure — never throws.
 * @param response - Raw text response from Claude
 * @returns An array of contradiction items (possibly empty)
 */
export function parseLintContradictions(response: string): LintContradictionItem[] {
  const json = extractJsonArray(response);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const result: LintContradictionItem[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const r = item as Record<string, unknown>;
      if (!Array.isArray(r.highlightIds)) continue;
      if (typeof r.description !== 'string' || r.description.trim().length === 0) continue;
      const ids = r.highlightIds.filter(
        (n): n is number => typeof n === 'number' && Number.isInteger(n),
      );
      if (ids.length < 2) continue;
      result.push({ highlightIds: ids, description: r.description.trim() });
    }
    return result;
  } catch {
    return [];
  }
}

/** An explanation of a single supporting/opposing tension pair. */
export interface LintTension {
  pairIndex: number;
  description: string;
}

/**
 * Parses the LLM response for supporting/opposing tension explanation.
 * Degrades gracefully: returns an empty array on any parse failure — never throws.
 * @param response - Raw text response from Claude
 * @returns An array of pair-tension explanations (possibly empty)
 */
export function parseLintTensions(response: string): LintTension[] {
  const json = extractJsonArray(response);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const result: LintTension[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const r = item as Record<string, unknown>;
      if (typeof r.pairIndex !== 'number' || !Number.isInteger(r.pairIndex)) continue;
      if (typeof r.description !== 'string' || r.description.trim().length === 0) continue;
      result.push({ pairIndex: r.pairIndex, description: r.description.trim() });
    }
    return result;
  } catch {
    return [];
  }
}

/** Result returned by callClaudeWithMeta, including stop reason for truncation detection. */
export interface ClaudeCallResult {
  text: string;
  stopReason: Anthropic.Message['stop_reason'];
}

/** Shared implementation for callClaudeWithMeta and related callers. */
async function callClaudeBase(
  systemPrompt: string,
  userContent: Anthropic.MessageParam['content'],
  ctx: TrackingContext,
  model: string,
  maxTokens: number,
  timeoutMs?: number,
  maxRetries?: number,
): Promise<ClaudeCallResult> {
  const client = getClient();
  try {
    return await trackAiCall({ ...ctx, model }, async () => {
      const response = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
        },
        timeoutMs || maxRetries !== undefined
          ? {
              ...(timeoutMs && { timeout: timeoutMs }),
              ...(maxRetries !== undefined && { maxRetries }),
            }
          : undefined,
      );
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
      return {
        result: { text, stopReason: response.stop_reason },
        usage: {
          model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
          webSearchCount: response.usage.server_tool_use?.web_search_requests ?? 0,
        },
      };
    });
  } catch (error) {
    logger.error(
      { err: error, event: 'ai_call_failed', feature: ctx.feature },
      'Claude API call failed',
    );
    throw new ExternalServiceError(
      'Claude API',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}

/**
 * Sends a message to Claude and returns text plus stop_reason.
 * Use this when the caller needs to detect truncation (stop_reason === 'max_tokens').
 * @param systemPrompt - System instructions for Claude
 * @param userMessage - User message content
 * @param ctx - Tracking context: feature label, optional runId and resource reference
 * @param model - Optional model override (defaults to Sonnet)
 * @param maxTokens - Optional max tokens for response (defaults to 2048)
 * @param timeoutMs - Optional per-request timeout override (defaults to client timeout)
 * @param maxRetries - Optional retry count override (defaults to SDK default of 2)
 * @returns { text, stopReason }
 * @throws ExternalServiceError if the API call fails
 */
export async function callClaudeWithMeta(
  systemPrompt: string,
  userMessage: string,
  ctx: TrackingContext,
  model: string = MODEL,
  maxTokens: number = 2048,
  timeoutMs?: number,
  maxRetries?: number,
): Promise<ClaudeCallResult> {
  return callClaudeBase(systemPrompt, userMessage, ctx, model, maxTokens, timeoutMs, maxRetries);
}

/**
 * Sends a message to Claude and returns the text response.
 * Records the call in ai_usage via trackAiCall (both success and error).
 * @param systemPrompt - System instructions for Claude
 * @param userMessage - User message content
 * @param ctx - Tracking context: feature label, optional runId and resource reference
 * @param model - Optional model override (defaults to Sonnet)
 * @param maxTokens - Optional max tokens for response (defaults to 2048)
 * @param timeoutMs - Optional per-request timeout override (defaults to client timeout)
 * @returns Claude's text response
 * @throws ExternalServiceError if the API call fails
 */
export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  ctx: TrackingContext,
  model: string = MODEL,
  maxTokens: number = 2048,
  timeoutMs?: number,
): Promise<string> {
  const { text } = await callClaudeWithMeta(
    systemPrompt,
    userMessage,
    ctx,
    model,
    maxTokens,
    timeoutMs,
  );
  return text;
}

/** Parameters for streaming Claude calls */
export interface StreamParams {
  /** System instructions */
  system: string;
  /** Conversation messages */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Callback for each text delta */
  onText: (delta: string) => void;
  /** Anthropic model ID to use */
  model: string;
  /** Max tokens to generate (default 4096) */
  maxTokens?: number;
  /** Tracking context for ai_usage recording */
  ctx: TrackingContext;
  /** Optional AbortSignal to cancel the in-flight request */
  abortSignal?: AbortSignal;
}

/** Result of a streaming Claude call */
export interface StreamResult {
  /** Complete accumulated text */
  text: string;
  /** Token usage */
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Sends a streaming message to Claude and invokes onText for each text delta.
 * Returns the complete response text and usage after the stream finishes.
 * @param params - System prompt, messages, and text callback
 * @returns Complete text and token usage
 * @throws ExternalServiceError if the API call fails
 */
export async function callClaudeStreaming(params: StreamParams): Promise<StreamResult> {
  const client = getClient();

  try {
    return await trackAiCall({ ...params.ctx, model: params.model }, async () => {
      const stream = client.messages.stream(
        {
          model: params.model,
          max_tokens: params.maxTokens ?? 4096,
          system: params.system,
          messages: params.messages,
        },
        params.abortSignal ? { signal: params.abortSignal } : undefined,
      );

      stream.on('text', params.onText);

      const finalMessage = await stream.finalMessage();

      const text = finalMessage.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const streamResult: StreamResult = {
        text,
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
        },
      };

      return {
        result: streamResult,
        usage: {
          model: params.model,
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
          cacheReadTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
          webSearchCount: finalMessage.usage.server_tool_use?.web_search_requests ?? 0,
        },
      };
    });
  } catch (error) {
    logger.error(
      { err: error, event: 'ai_stream_call_failed', feature: params.ctx.feature },
      'Claude streaming call failed',
    );
    throw new ExternalServiceError(
      'Claude API',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}

/**
 * Generates a structured concept index for an article and returns it as a string.
 * The index is keyword-dense (topics, entities, arguments, related concepts) and
 * designed for FTS5 retrieval — not for human reading.
 * @param article - Article with title and content fields
 * @returns The raw concept index string to store in articles.ai_index
 * @throws ValidationError if the article has no content to index
 */
export async function generateConceptIndex(article: {
  id: number;
  title: string;
  contentMarkdown: string | null;
  contentText: string | null;
  contentHtml: string | null;
}): Promise<string> {
  const content = article.contentMarkdown ?? article.contentText ?? article.contentHtml;
  if (!content?.trim()) {
    throw new ValidationError('Article has no content to index');
  }
  const input = `Article title: ${article.title}\n\nArticle content:\n${truncateContent(content)}`;
  return callClaude(CONCEPT_INDEX_PROMPT, input, {
    feature: 'ai_index',
    resourceType: 'article',
    resourceId: article.id,
  });
}

/**
 * Fire-and-forget concept index generation. Non-blocking — errors are logged, not thrown.
 * @param articleId - Article ID for the DB update
 * @param articleRow - Article data passed to generateConceptIndex
 */
export function scheduleConceptIndex(
  articleId: number,
  articleRow: Parameters<typeof generateConceptIndex>[0],
): void {
  generateConceptIndex(articleRow)
    .then((aiIndex) => {
      db.update(articles).set({ aiIndex }).where(eq(articles.id, articleId)).run();
      logger.info({ event: 'ai_index_generated', articleId }, 'Concept index generated');
    })
    .catch((err) => {
      logger.warn({ err, event: 'ai_index_failed', articleId }, 'Concept index generation failed');
    });
}
