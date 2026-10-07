import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// --- Sources ---

export const sources = sqliteTable('sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type', {
    enum: [
      'rss_feed',
      'browser_extension',
      'remarkable',
      'manual',
      'newsletter',
      'readwise',
      'upload',
    ],
  }).notNull(),
  name: text('name').notNull(),
  feedUrl: text('feed_url'),
  iconUrl: text('icon_url'),
  category: text('category'),
  pollInterval: integer('poll_interval').default(30),
  lastPolled: text('last_polled'),
  etag: text('etag'),
  lastModified: text('last_modified'),
  senderAddress: text('sender_address'),
  isBlocked: integer('is_blocked', { mode: 'boolean' }),
  lastReceivedAt: text('last_received_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// --- Articles ---

export const articles = sqliteTable(
  'articles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: integer('source_id').references(() => sources.id, { onDelete: 'set null' }),
    externalId: text('external_id').unique(),
    url: text('url').notNull().unique(),
    title: text('title').notNull(),
    author: text('author'),
    contentHtml: text('content_html'),
    contentText: text('content_text'),
    contentOriginalHtml: text('content_original_html'),
    originalFilePath: text('original_file_path'),
    contentHash: text('content_hash').unique(),
    contentMarkdown: text('content_markdown'),
    aiCleanedAt: text('ai_cleaned_at'),
    extractionTier: text('extraction_tier', { enum: ['pdfjs', 'jina', 'mistral', 'failed'] }),
    excerpt: text('excerpt'),
    siteName: text('site_name'),
    imageUrl: text('image_url'),
    wordCount: integer('word_count').default(0),
    pageCount: integer('page_count'),
    readingProgress: real('reading_progress').default(0),
    status: text('status', { enum: ['inbox', 'reading', 'archived', 'pending_review'] })
      .notNull()
      .default('inbox'),
    isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
    aiSummary: text('ai_summary'),
    aiTags: text('ai_tags'),
    aiIndex: text('ai_index'),
    ttsParagraph: integer('tts_paragraph'),
    ttsTimeOffset: real('tts_time_offset'),
    publishedAt: text('published_at'),
    savedAt: text('saved_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    readAt: text('read_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index('articles_status_idx').on(table.status),
    index('articles_saved_at_idx').on(table.savedAt),
    index('articles_source_idx').on(table.sourceId),
  ],
);

// --- Theses ---

export const theses = sqliteTable('theses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().default(1),
  title: text('title').notNull(),
  claim: text('claim'),
  counterarguments: text('counterarguments'),
  implications: text('implications'),
  status: text('status', {
    enum: ['nascent', 'developing', 'researched', 'ready', 'used'],
  })
    .notNull()
    .default('nascent'),
  notes: text('notes'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// --- Highlights ---

export const highlights = sqliteTable(
  'highlights',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    articleId: integer('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    thesisId: integer('thesis_id').references(() => theses.id, { onDelete: 'set null' }),
    externalId: text('external_id').unique(),
    text: text('text').notNull(),
    note: text('note'),
    color: text('color', { enum: ['yellow'] })
      .notNull()
      .default('yellow'),
    positionData: text('position_data'),
    // Keep in sync with ANCHOR_STATUSES in src/types/index.ts
    anchorStatus: text('anchor_status', { enum: ['anchored', 'orphaned'] })
      .notNull()
      .default('anchored'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    lastReviewed: text('last_reviewed'),
    reviewCount: integer('review_count').default(0),
    reviewInterval: integer('review_interval').default(0),
  },
  (table) => [
    index('highlights_article_idx').on(table.articleId),
    index('highlights_last_reviewed_idx').on(table.lastReviewed),
    index('highlights_review_interval_idx').on(table.reviewInterval),
  ],
);

// --- Tags ---

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  color: text('color'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// --- Highlight-Tag junction ---

export const highlightTags = sqliteTable(
  'highlight_tags',
  {
    highlightId: integer('highlight_id')
      .notNull()
      .references(() => highlights.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('highlight_tags_unique').on(table.highlightId, table.tagId),
    index('highlight_tags_tag_idx').on(table.tagId),
  ],
);

// --- Thesis-Highlight join table ---

export const thesisHighlights = sqliteTable(
  'thesis_highlights',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    thesisId: integer('thesis_id')
      .notNull()
      .references(() => theses.id, { onDelete: 'cascade' }),
    highlightId: integer('highlight_id')
      .notNull()
      .references(() => highlights.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['supporting', 'opposing', 'context'] })
      .notNull()
      .default('supporting'),
    note: text('note'),
    addedAt: text('added_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [uniqueIndex('thesis_highlights_unique').on(table.thesisId, table.highlightId)],
);

// --- Thesis Research ---

export const thesisResearch = sqliteTable(
  'thesis_research',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    thesisId: integer('thesis_id')
      .notNull()
      .references(() => theses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    source: text('source', { enum: ['deep_research', 'manual', 'ai_analysis'] }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index('thesis_research_thesis_idx').on(table.thesisId)],
);

// --- Settings ---

export const settings = sqliteTable(
  'settings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    key: text('key').notNull(),
    value: text('value').notNull(),
    isEncrypted: integer('is_encrypted', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [uniqueIndex('settings_user_key_idx').on(table.userId, table.key)],
);

// --- Audit Log ---

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().default(1),
  action: text('action', {
    enum: ['setting_updated', 'setting_deleted', 'api_key_tested', 'api_key_changed'],
  }).notNull(),
  key: text('key'),
  timestamp: text('timestamp')
    .notNull()
    .default(sql`(datetime('now'))`),
  ipAddress: text('ip_address'),
});

// --- Chat ---

export const chatSessions = sqliteTable('chat_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().default(1),
  title: text('title').notNull().default('New chat'),
  scope: text('scope').notNull().default('all'),
  model: text('model').notNull().default('claude-sonnet-4-6'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// --- Voice Profile ---

export const voiceProfile = sqliteTable(
  'voice_profile',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),
    profile: text('profile').notNull().default(''),
    extractedAt: text('extracted_at'),
    sampleCount: integer('sample_count').notNull().default(0),
    manualEditsAt: text('manual_edits_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [uniqueIndex('voice_profile_user_idx').on(table.userId)],
);

export const voiceSamples = sqliteTable(
  'voice_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    profileId: integer('profile_id')
      .notNull()
      .references(() => voiceProfile.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    content: text('content').notNull(),
    wordCount: integer('word_count').notNull().default(0),
    channelHint: text('channel_hint'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index('voice_samples_profile_idx').on(table.profileId)],
);

// --- Drafts ---

export const drafts = sqliteTable('drafts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().default(1),
  thesisId: integer('thesis_id')
    .notNull()
    .references(() => theses.id, { onDelete: 'cascade' }),
  // Keep in sync with TEMPLATE_IDS in src/types/index.ts
  templateId: text('template_id', { enum: ['blog', 'linkedin', 'youtube'] }).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  angle: text('angle'),
  contextSnapshot: text('context_snapshot'),
  // Keep in sync with DRAFT_MODEL_IDS in src/lib/models.ts
  model: text('model').notNull().default('claude-sonnet-4-6'),
  // Keep in sync with DRAFT_STATUSES in src/types/index.ts
  status: text('status', { enum: ['draft', 'published'] })
    .notNull()
    .default('draft'),
  generatedAt: text('generated_at'),
  lastEditedAt: text('last_edited_at'),
  publishedAt: text('published_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

// --- Chat ---

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: integer('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    citations: text('citations'),
    contextTokens: integer('context_tokens'),
    bookmarkedAt: text('bookmarked_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index('chat_messages_session_idx').on(table.sessionId)],
);

// --- AI Usage ---

export const aiUsage = sqliteTable(
  'ai_usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull().default(1),

    feature: text('feature', {
      enum: [
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
      ],
    }).notNull(),

    model: text('model').notNull(),
    status: text('status', { enum: ['success', 'error'] }).notNull(),
    errorKind: text('error_kind'),

    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    webSearchCount: integer('web_search_count').notNull().default(0),
    pagesProcessed: integer('pages_processed'),

    runId: text('run_id'),

    resourceType: text('resource_type'),
    resourceId: integer('resource_id'),

    durationMs: integer('duration_ms').notNull().default(0),

    createdAt: text('created_at')
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index('ai_usage_created_idx').on(table.createdAt),
    index('ai_usage_feature_idx').on(table.feature),
    index('ai_usage_run_idx').on(table.runId),
  ],
);
