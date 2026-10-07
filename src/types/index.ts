import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type {
  sources,
  articles,
  highlights,
  tags,
  highlightTags,
  settings,
  auditLog,
  theses,
  thesisHighlights,
  thesisResearch,
  chatSessions,
  chatMessages,
  voiceProfile,
  voiceSamples,
  drafts,
  aiUsage,
} from '@/db/schema';

// --- Select types (reading from DB) ---

export type Source = InferSelectModel<typeof sources>;
export type Article = InferSelectModel<typeof articles>;
export type Highlight = InferSelectModel<typeof highlights>;
export type Tag = InferSelectModel<typeof tags>;
export type HighlightTag = InferSelectModel<typeof highlightTags>;

// --- Insert types (writing to DB) ---

export type NewSource = InferInsertModel<typeof sources>;
export type NewArticle = InferInsertModel<typeof articles>;
export type NewHighlight = InferInsertModel<typeof highlights>;
export type NewTag = InferInsertModel<typeof tags>;
export type NewHighlightTag = InferInsertModel<typeof highlightTags>;
export type Setting = InferSelectModel<typeof settings>;
export type NewSetting = InferInsertModel<typeof settings>;
export type AuditLogEntry = InferSelectModel<typeof auditLog>;
export type NewAuditLogEntry = InferInsertModel<typeof auditLog>;
export type Thesis = InferSelectModel<typeof theses>;
export type NewThesis = InferInsertModel<typeof theses>;
export type ThesisHighlight = InferSelectModel<typeof thesisHighlights>;
export type NewThesisHighlight = InferInsertModel<typeof thesisHighlights>;
export type ThesisResearch = InferSelectModel<typeof thesisResearch>;
export type NewThesisResearch = InferInsertModel<typeof thesisResearch>;
export type VoiceProfile = InferSelectModel<typeof voiceProfile>;
export type NewVoiceProfile = InferInsertModel<typeof voiceProfile>;
export type VoiceSample = InferSelectModel<typeof voiceSamples>;
export type NewVoiceSample = InferInsertModel<typeof voiceSamples>;
export type AiUsage = InferSelectModel<typeof aiUsage>;
export type NewAiUsage = InferInsertModel<typeof aiUsage>;

// --- AI Usage types ---

export const AI_USAGE_FEATURES = [
  'research_plan',
  'research_subagent',
  'research_synthesis',
  'chat',
  'chat_keyword_expansion',
  'chat_title_generation',
  'draft_generation',
  'summarize',
  'tag',
  'explain',
  'ai_index',
  'ai_clean',
  'ai_clean_pdf',
  'voice_extraction',
  'lint_connections',
  'lint_contradictions',
  'lint_gaps',
  'thesis_suggest',
  'highlight_suggest',
] as const;
export type AiUsageFeature = (typeof AI_USAGE_FEATURES)[number];

export const AI_USAGE_RESOURCE_TYPES = [
  'article',
  'thesis',
  'thesis_research',
  'draft',
  'chat_session',
  'highlight',
] as const;
export type AiUsageResourceType = (typeof AI_USAGE_RESOURCE_TYPES)[number];

// --- Enums ---

export const SOURCE_TYPES = [
  'rss_feed',
  'browser_extension',
  'remarkable',
  'manual',
  'newsletter',
  'readwise',
  'upload',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const EXTRACTION_TIERS = ['pdfjs', 'jina', 'mistral', 'failed'] as const;
export type ExtractionTier = (typeof EXTRACTION_TIERS)[number];
export type ArticleStatus = 'inbox' | 'reading' | 'archived' | 'pending_review';

/** Filter tab values: article statuses + special 'favorites' filter */
export type ArticleFilterTab = ArticleStatus | 'favorites' | null;
export const HIGHLIGHT_COLORS = ['yellow'] as const;
export type HighlightColor = 'yellow';

/**
 * Anchor resolution status for a highlight.
 * `anchored` — the highlight's text-quote anchor resolves to a range in the current content.
 * `orphaned` — the anchor no longer resolves (content changed beyond fuzzy tolerance); the
 * highlight is preserved in the library but not rendered in the reader.
 * Keep in sync with the `anchor_status` enum in src/db/schema.ts.
 */
export const ANCHOR_STATUSES = ['anchored', 'orphaned'] as const;
export type AnchorStatus = (typeof ANCHOR_STATUSES)[number];

/**
 * Durable text-quote + text-position anchor (`position_data` v2), per the W3C Web
 * Annotation model. Combines a TextQuoteSelector (`exact`/`prefix`/`suffix`, durable
 * across re-rendering) with a TextPositionSelector (`start`/`end`, fast path). Offsets
 * index into the article's root text stream (in-document-order concatenation of every
 * text node within the content root, no whitespace normalization).
 * See docs/modules/highlight-anchoring.md §3-§5.
 */
export interface TextQuoteAnchor {
  /** Version discriminant. Absence (or any other value) means a legacy v1 anchor. */
  v: 2;
  /** The highlighted text, verbatim from the root text stream. */
  exact: string;
  /** Up to ANCHOR_CONTEXT_LEN chars immediately before `exact`. */
  prefix: string;
  /** Up to ANCHOR_CONTEXT_LEN chars immediately after `exact`. */
  suffix: string;
  /** Char offset of `exact` start into the root text stream. */
  start: number;
  /** Char offset of `exact` end into the root text stream (exclusive). */
  end: number;
}

/** Known setting keys */
export const SETTING_KEYS = [
  'inworld_api_key',
  'inworld_voice_en',
  'inworld_voice_fr',
  'anthropic_api_key',
  'mistral_api_key',
  'tts_default_speed',
  'daily_review_batch_size',
  'rss_poll_interval',
  'appearance_mode',
  'readwise_api_token',
  'readwise_last_import',
  'imap_host',
  'imap_port',
  'imap_user',
  'imap_password',
  'imap_tls',
  'imap_mailbox',
  'imap_poll_interval',
  'monthly_budget_usd',
  'reformat_provider',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Valid appearance mode values */
export const APPEARANCE_MODES = ['automatic', 'dark', 'light'] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

/** Audit log action types */
export const AUDIT_ACTIONS = [
  'setting_updated',
  'setting_deleted',
  'api_key_tested',
  'api_key_changed',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Article summary for list views (excludes large content fields) */
export interface ArticleListItem {
  id: number;
  url: string;
  title: string;
  siteName: string | null;
  excerpt: string | null;
  wordCount: number | null;
  pageCount: number | null;
  originalFilePath: string | null;
  extractionTier: ExtractionTier | null;
  readingProgress: number | null;
  status: ArticleStatus;
  savedAt: string;
  isFavorite: boolean;
}

// --- UI Types ---

/** Tag summary for UI display (distinct from HighlightTag which is the join table row) */
export interface TagInfo {
  id: number;
  name: string;
  color: string | null;
}

/** Tag with usage count for filter/management UIs */
export interface TagWithCount extends TagInfo {
  highlightCount: number;
}

/** Highlight with article context and tags for library display */
export interface HighlightWithContext {
  id: number;
  articleId: number;
  text: string;
  note: string | null;
  color: HighlightColor;
  positionData: string | null;
  anchorStatus: AnchorStatus;
  createdAt: string;
  updatedAt: string;
  lastReviewed: string | null;
  reviewCount: number | null;
  reviewInterval: number | null;
  article: {
    title: string;
    url: string;
    siteName: string | null;
  };
  tags: TagInfo[];
}

// --- API Route Helpers ---

/** Context for dynamic [id] route segments in Next.js App Router */
export type RouteContext = { params: Promise<{ id: string }> };

// --- Global Search ---

export const SEARCH_ENTITY_TYPES = ['article', 'highlight', 'thesis', 'draft'] as const;
export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export interface SearchResultArticle {
  id: number;
  title: string;
  siteName: string | null;
  status: ArticleStatus;
  /** Escaped HTML containing only <mark> tags — see docs/modules/global-search.md §6.1 */
  snippet: string;
  savedAt: string;
}

export interface SearchResultHighlight {
  id: number;
  articleId: number;
  articleTitle: string;
  /** Escaped HTML containing only <mark> tags — see docs/modules/global-search.md §6.1 */
  snippet: string;
}

export interface SearchResultThesis {
  id: number;
  title: string;
  status: ThesisStatus;
  /** Escaped HTML containing only <mark> tags — see docs/modules/global-search.md §6.1 */
  snippet: string;
}

export interface SearchResultDraft {
  id: number;
  title: string;
  templateId: TemplateId;
  thesisId: number;
  /** Escaped HTML containing only <mark> tags — see docs/modules/global-search.md §6.1 */
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: {
    articles: SearchResultArticle[];
    highlights: SearchResultHighlight[];
    theses: SearchResultThesis[];
    drafts: SearchResultDraft[];
  };
  /** Unpaginated match counts per type */
  totals: Record<SearchEntityType, number>;
}

// --- Global Search raw query rows (snake_case from raw SQLite, incl. FTS snippet) ---

/** Raw row from articles_fts JOIN articles for global search */
export interface SearchArticleRow {
  id: number;
  title: string;
  site_name: string | null;
  status: string;
  saved_at: string;
  raw_snippet: string;
}

/** Raw row from highlights_fts JOIN highlights JOIN articles for global search */
export interface SearchHighlightRow {
  id: number;
  article_id: number;
  article_title: string;
  raw_snippet: string;
}

/** Raw row from theses_fts JOIN theses for global search */
export interface SearchThesisRow {
  id: number;
  title: string;
  status: string;
  raw_snippet: string;
}

/** Raw row from drafts_fts JOIN drafts for global search */
export interface SearchDraftRow {
  id: number;
  title: string;
  template_id: string;
  thesis_id: number;
  raw_snippet: string;
}

// --- Review ---

/** Review action the user can take on a highlight */
export type ReviewAction = 'got_it' | 'review_again';

// --- Feed Polling ---

/** Result of polling a single RSS feed */
export interface PollResult {
  feedId: number;
  feedName: string;
  newArticles: number;
  skipped: number;
  errors: string[];
}

// --- Newsletter Polling ---

/** Result of polling the newsletter mailbox */
export interface NewsletterPollResult {
  newArticles: number;
  skipped: number;
  errors: string[];
}

/** Newsletter source approval status: null=pending, false=approved, true=blocked */
export type NewsletterApprovalStatus = 'pending' | 'approved' | 'blocked';

/**
 * Derives the approval status string from the isBlocked tri-state.
 * @param isBlocked - null=pending, false=approved, true=blocked
 * @returns Status string for the UI
 */
export function deriveNewsletterStatus(isBlocked: boolean | null): NewsletterApprovalStatus {
  if (isBlocked === null) return 'pending';
  return isBlocked ? 'blocked' : 'approved';
}

// --- TTS (Text-to-Speech) ---

/** TTS playback status state machine */
export type TTSStatus = 'idle' | 'loading' | 'playing' | 'paused';

/** TTS playback position for save/restore */
export interface TTSPosition {
  paragraph: number;
  timeOffset: number;
}

/** A prepared paragraph ready for TTS synthesis */
export interface PreparedParagraph {
  index: number;
  text: string;
  wordCount: number;
}

/** Word position mapping from TTS word to character offset in source text */
export interface WordPosition {
  word: string;
  startOffset: number;
  endOffset: number;
}

/** A chunk of TTS audio with word timestamp alignment */
export interface TTSChunk {
  paragraphIndex: number;
  audioContent: string;
  words: string[];
  startTimes: number[];
  endTimes: number[];
}

/** Metadata about a TTS stream session */
export interface TTSMetadata {
  totalParagraphs: number;
  articleTitle: string;
  language: string;
}

/** An available TTS voice */
export interface TTSVoice {
  voiceId: string;
  name: string;
  language: string;
}

/** Options for the Inworld TTS API */
export interface TTSOptions {
  voiceId: string;
  modelId: string;
  speed: number;
  audioEncoding: string;
  sampleRateHertz: number;
}

/** A raw chunk from the Inworld streaming API */
export interface InworldChunk {
  audioContent: string;
  words: string[];
  wordStartTimes: number[];
  wordEndTimes: number[];
}

/** Route context for TTS article routes (uses `articleId` instead of `id`) */
export interface TTSRouteContext {
  params: Promise<{ articleId: string }>;
}

/** Event emitted during article synthesis */
export type SynthesisEvent =
  { type: 'chunk'; data: TTSChunk } | { type: 'paragraph-complete'; paragraphIndex: number };

/** Metadata stored in each article's TTS cache directory */
export interface TTSCacheMeta {
  totalParagraphs: number;
  optionsHash: string;
}

/** Per-paragraph cache data (stored as JSON alongside the .mp3) */
export interface TTSCacheParagraphData {
  paragraphIndex: number;
  words: string[];
  startTimes: number[];
  endTimes: number[];
}

/** TTS cache statistics */
export interface TTSCacheStats {
  totalSize: number;
  articleCount: number;
  oldestAccess: string | null;
}

/** Newsletter source for management UI */
export interface NewsletterListItem {
  id: number;
  name: string;
  senderAddress: string | null;
  isBlocked: boolean | null;
  lastReceivedAt: string | null;
  articleCount: number;
  status: NewsletterApprovalStatus;
}

// --- Thesis Tracker ---

/** Valid thesis status values */
export const THESIS_STATUSES = ['nascent', 'developing', 'researched', 'ready', 'used'] as const;
export type ThesisStatus = (typeof THESIS_STATUSES)[number];

/** Valid thesis-highlight role values */
export const THESIS_HIGHLIGHT_ROLES = ['supporting', 'opposing', 'context'] as const;
export type ThesisHighlightRole = (typeof THESIS_HIGHLIGHT_ROLES)[number];

/** Valid thesis research source values */
export const THESIS_RESEARCH_SOURCES = ['deep_research', 'manual', 'ai_analysis'] as const;
export type ThesisResearchSource = (typeof THESIS_RESEARCH_SOURCES)[number];

/** Thesis summary for list views (with linked-content counts) */
export interface ThesisListItem {
  id: number;
  title: string;
  claim: string | null;
  status: ThesisStatus;
  highlightCount: number;
  researchCount: number;
  createdAt: string;
  updatedAt: string;
}

/** A highlight linked to a thesis (with article context and link metadata) */
export interface ThesisLinkedHighlight {
  id: number;
  text: string;
  note: string | null;
  role: ThesisHighlightRole;
  linkNote: string | null;
  article: {
    id: number;
    title: string;
    siteName: string | null;
  };
}

/** A research entry summary (without full content) */
export interface ThesisResearchSummary {
  id: number;
  title: string;
  source: ThesisResearchSource | null;
  wordCount: number;
  createdAt: string;
}

/** Full thesis detail response */
export interface ThesisDetailResponse {
  thesis: Thesis;
  highlights: ThesisLinkedHighlight[];
  research: ThesisResearchSummary[];
}

/** AI-suggested thesis based on unlinked highlights */
export interface ThesisSuggestion {
  title: string;
  claim: string;
  relevantHighlightIds: number[];
  confidence: number;
}

/** AI-suggested highlight for a thesis */
export interface HighlightSuggestion {
  highlightId: number;
  suggestedRole: ThesisHighlightRole;
  reason: string;
}

// --- Chat ---

export type ChatSession = InferSelectModel<typeof chatSessions>;
export type NewChatSession = InferInsertModel<typeof chatSessions>;
export type ChatMessage = InferSelectModel<typeof chatMessages>;
export type NewChatMessage = InferInsertModel<typeof chatMessages>;

/** Chat session scoping */
export type ChatScope =
  'all' | `article:${number}` | `thesis:${number}` | `tag:${string}` | `recent:${number}`;

/** A citation in an assistant message */
export interface ChatCitation {
  type: 'article' | 'highlight' | 'thesis';
  id: number;
  title: string;
  snippet?: string;
}

/** Chat session summary for list view */
export interface ChatSessionListItem {
  id: number;
  title: string;
  scope: string;
  model: string;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

/** Chat message for display */
export interface ChatMessageDisplay {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  citations: ChatCitation[];
  createdAt: string;
  bookmarkedAt?: string | null;
}

/** Action to file a message back into the knowledge base */
export type ChatFileAction =
  | { type: 'create_thesis'; title: string; claim?: string; highlightIds?: number[] }
  | { type: 'add_research'; thesisId: number; title: string; content: string }
  | { type: 'annotate_highlight'; highlightId: number; note: string }
  | { type: 'bookmark' };

export type ChunkOutcome =
  | { status: 'success'; provider: 'mistral' | 'anthropic'; html: string }
  | { status: 'skipped'; html: string };

/** Pure result of the chunked reformat pipeline (no DB/HTTP side effects). */
export interface ChunkedReformatResult {
  /** Per-chunk outcomes in chunk order. */
  outcomes: ChunkOutcome[];
  /** Sanitized, reassembled article HTML. */
  assembledHtml: string;
  /** Markdown rendered from `assembledHtml`. */
  contentMarkdown: string;
  /** Number of chunks that were successfully reformatted. */
  successCount: number;
  /** Number of chunks that fell through to keeping the original. */
  skippedCount: number;
  /** Total number of chunks the content was split into. */
  chunksTotal: number;
  /** True if at least one chunk succeeded via Mistral. */
  usedMistral: boolean;
  /** True if at least one chunk succeeded via Anthropic (Haiku). */
  usedAnthropic: boolean;
  /** Shared run identifier used to correlate per-chunk usage rows. */
  runId: string;
}

/** Pure result of the single-shot reformat pipeline (no DB/HTTP side effects). */
export interface SingleShotReformatResult {
  /** Sanitized, reformatted article HTML. */
  contentHtml: string;
  /** Markdown rendered from `contentHtml`. */
  contentMarkdown: string;
  /** Provider that produced the final output. */
  provider: 'mistral' | 'anthropic';
  /** True when the output came from the Haiku fallback (or Mistral was unavailable). */
  usedFallback: boolean;
}

// --- Knowledge Linting ---

/**
 * The canonical list of knowledge-health check identifiers.
 * Single source of truth for: Zod validation, the LintCheck type,
 * the route dispatch, and the client-side check registry.
 */
export const LINT_CHECKS = ['connections', 'contradictions', 'gaps', 'stale'] as const;
export type LintCheck = (typeof LINT_CHECKS)[number];

/** Reference to a related entity attached to a lint suggestion. */
export interface LintRelatedRef {
  type: 'article' | 'highlight' | 'thesis';
  id: number;
}

/** A single lint finding streamed from the server to the client. */
export interface LintSuggestion {
  type: 'connection' | 'contradiction' | 'gap' | 'stale';
  description: string;
  relatedIds: LintRelatedRef[];
  suggestedAction?: string;
}

// --- Content Templates (Module 16) ---

export const DRAFT_STATUSES = ['draft', 'published'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const TEMPLATE_IDS = ['blog', 'linkedin', 'youtube'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export type Draft = InferSelectModel<typeof drafts>;
export type NewDraft = InferInsertModel<typeof drafts>;

/** Typed shape of the JSON stored in drafts.context_snapshot */
export interface DraftContextSnapshot {
  highlightIds: number[];
  researchIds: number[];
}

export interface ContentTemplate {
  id: TemplateId;
  name: string;
  description: string;
  targetLength: { min: number; max: number };
  channelHint: string;
  instructions: string;
}
