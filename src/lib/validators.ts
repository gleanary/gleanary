import { z } from 'zod';
import {
  HIGHLIGHT_COLORS,
  ANCHOR_STATUSES,
  SOURCE_TYPES,
  SETTING_KEYS,
  APPEARANCE_MODES,
  THESIS_STATUSES,
  THESIS_HIGHLIGHT_ROLES,
  THESIS_RESEARCH_SOURCES,
  LINT_CHECKS,
  DRAFT_STATUSES,
  TEMPLATE_IDS,
  SEARCH_ENTITY_TYPES,
} from '@/types';
import { ANTHROPIC_MODELS, DEFAULT_CHAT_MODEL, DRAFT_MODEL_IDS } from '@/lib/models';
import { MODEL_PRICING } from '@/lib/pricing';
import type { RouteContext } from '@/types';
import { ENCRYPTED_KEYS } from '@/lib/settings-schema';

// --- Shared ---

/** Highlight color Zod enum, derived from the single HIGHLIGHT_COLORS source of truth */
const highlightColorEnum = z.enum(HIGHLIGHT_COLORS);

/** Source type Zod enum, derived from the single SOURCE_TYPES source of truth */
const sourceTypeEnum = z.enum(SOURCE_TYPES);

/** Validates that an image URL uses http(s), preventing javascript: and data: XSS vectors */
const safeImageUrl = z
  .string()
  .url()
  .refine((url) => /^https?:\/\//i.test(url), { message: 'imageUrl must use http or https' })
  .optional();

/** Validates a route param ID (coerces string → positive integer) */
export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Parses the `id` route parameter from a Next.js dynamic route context.
 * @param context - Route context with `params` promise
 * @returns Validated positive integer ID
 */
export async function parseIdParam(context: RouteContext): Promise<number> {
  const { id } = idParamSchema.parse({ id: (await context.params).id });
  return id;
}

/**
 * Wraps a Zod object schema as `.partial()` with a refinement requiring
 * at least one field to be provided. Used for PATCH/update schemas.
 * @param schema - Zod object schema to make partial
 * @returns Partial schema with at-least-one-field validation
 */
export function partialWithAtLeastOne<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.partial().refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });
}

// --- Articles ---

/** Valid article status values, reused across schemas */
const articleStatusEnum = z.enum(['inbox', 'reading', 'archived']);

/** Validates POST /api/articles request body */
export const createArticleSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(2000),
  author: z.string().max(500).optional(),
  contentHtml: z.string().optional(),
  contentText: z.string().optional(),
  excerpt: z.string().max(5000).optional(),
  siteName: z.string().max(500).optional(),
  imageUrl: safeImageUrl,
  wordCount: z.number().int().nonnegative().optional(),
  sourceId: z.number().int().positive().optional(),
  publishedAt: z.string().optional(),
  status: articleStatusEnum.default('inbox'),
});

/** Validates PATCH /api/articles/[id] request body */
export const updateArticleSchema = partialWithAtLeastOne(
  z.object({
    status: articleStatusEnum,
    readingProgress: z.number().min(0).max(1),
    isFavorite: z.boolean(),
    title: z.string().min(1).max(2000),
    readAt: z.string(),
    ttsParagraph: z.number().int().min(0).nullable(),
    ttsTimeOffset: z.number().min(0).nullable(),
  }),
);

/** Validates GET /api/articles query params */
export const listArticlesSchema = z.object({
  status: z
    .string()
    .optional()
    .transform((val) => val?.split(',').filter(Boolean))
    .pipe(z.array(articleStatusEnum).optional()),
  sourceId: z.coerce.number().int().positive().optional(),
  sourceType: sourceTypeEnum.optional(),
  excludeSourceType: sourceTypeEnum.optional(),
  isFavorite: z.enum(['true', 'false']).optional(),
  sort: z.enum(['savedAt', 'title', 'readingProgress']).default('savedAt'),
  order: z.enum(['desc', 'asc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Highlights ---

/** Anchor status Zod enum, derived from the single ANCHOR_STATUSES source of truth */
const anchorStatusEnum = z.enum(ANCHOR_STATUSES);

/**
 * Validates a v2 text-quote anchor object (see TextQuoteAnchor in src/types).
 * Offsets index into the article root text stream; see highlight-anchoring.md §3.
 */
export const textQuoteAnchorSchema = z.object({
  v: z.literal(2),
  exact: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

/** Validates a legacy v1 child-index anchor object (transitional; dropped after backfill). */
const positionDataV1Schema = z.object({
  startContainerPath: z.array(z.number().int().nonnegative()),
  startOffset: z.number().int().nonnegative(),
  endContainerPath: z.array(z.number().int().nonnegative()),
  endOffset: z.number().int().nonnegative(),
  text: z.string(),
});

/** A parsed position_data payload is either a v2 anchor or a legacy v1 anchor. */
const positionDataUnion = z.union([textQuoteAnchorSchema, positionDataV1Schema]);

/**
 * Validates the `position_data` JSON string sent on highlight create/update.
 * Accepts a v2 text-quote anchor or (transitionally) a legacy v1 shape; rejects
 * anything else. position_data is stored opaquely as DATA (never evaluated), so this
 * returns the original string unchanged — it only guarantees the payload is well-formed.
 * Drop v1 acceptance once the backfill is confirmed (see highlight-anchoring.md §9).
 */
export const positionDataStringSchema = z.string().refine(
  (value) => {
    try {
      return positionDataUnion.safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  },
  { message: 'positionData must be a JSON v2 text-quote anchor or a legacy v1 anchor' },
);

/** Validates POST /api/highlights request body */
export const createHighlightSchema = z.object({
  articleId: z.number().int().positive(),
  text: z.string().min(1),
  note: z.string().optional(),
  color: highlightColorEnum.default('yellow'),
  positionData: positionDataStringSchema.optional(),
  tagIds: z.array(z.number().int().positive()).optional(),
});

/** Validates PATCH /api/highlights/[id] request body */
export const updateHighlightSchema = partialWithAtLeastOne(
  z.object({
    text: z.string().min(1),
    note: z.string(),
    positionData: positionDataStringSchema,
    anchorStatus: anchorStatusEnum,
    tagIds: z.array(z.number().int().positive()),
  }),
);

/** Validates GET /api/highlights query params */
export const listHighlightsSchema = z.object({
  articleId: z.coerce.number().int().positive().optional(),
  tagId: z.coerce.number().int().positive().optional(),
  color: highlightColorEnum.optional(),
  sourceId: z.coerce.number().int().positive().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  sort: z.enum(['createdAt', 'updatedAt']).default('createdAt'),
  order: z.enum(['desc', 'asc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Highlight Bulk Operations ---

/** Validates POST /api/highlights/bulk-delete request body */
export const bulkDeleteHighlightsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
});

/** Validates POST /api/highlights/bulk-tag request body */
export const bulkTagHighlightsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
  tagIds: z.array(z.number().int().positive()),
  mode: z.enum(['add', 'replace']).default('add'),
});

// --- Sources ---

/** Validates POST /api/sources request body */
export const createSourceSchema = z
  .object({
    type: sourceTypeEnum,
    name: z.string().min(1).max(500),
    feedUrl: z.string().url().optional(),
    iconUrl: safeImageUrl,
    category: z.string().max(200).optional(),
    pollInterval: z.number().int().min(1).max(1440).default(30),
  })
  .refine(
    (data) => data.type !== 'rss_feed' || (data.feedUrl !== undefined && data.feedUrl !== ''),
    { message: 'feedUrl is required for rss_feed sources', path: ['feedUrl'] },
  );

// --- Tags ---

/** Validates POST /api/tags request body */
export const createTagSchema = z.object({
  name: z.string().min(1).max(100),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color (e.g. #FF0000)')
    .optional(),
});

/** Validates PATCH /api/tags/[id] request body */
export const updateTagSchema = partialWithAtLeastOne(
  z.object({
    name: z.string().min(1).max(100),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color (e.g. #FF0000)')
      .nullable(),
  }),
);

// --- Review ---

/** Validates GET /api/review query params */
export const listReviewSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(15),
});

/** Validates POST /api/review request body */
export const submitReviewSchema = z.object({
  highlightId: z.number().int().positive(),
  action: z.enum(['got_it', 'review_again']),
});

// --- Article Parser ---

/** Validates POST /api/articles/parse request body */
export const parseArticleSchema = z.object({
  url: z.string().url(),
  html: z.string().optional(),
  sourceId: z.number().int().positive().optional(),
  status: articleStatusEnum.default('inbox'),
});

// --- Feed Polling ---

/** Validates POST /api/feeds/poll request body */
export const pollBodySchema = z.object({
  sourceId: z.number().int().positive().optional(),
});

// --- Search ---

/** Validates GET /api/search query params (spec §2) */
export const searchSchema = z.object({
  q: z.string().min(2),
  types: z
    .string()
    .optional()
    .transform((val) =>
      val
        ? val
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
        : [...SEARCH_ENTITY_TYPES],
    )
    .pipe(z.array(z.enum(SEARCH_ENTITY_TYPES)).min(1)),
  // status applies to article results only; pending_review is excluded from search entirely
  status: z.enum(['inbox', 'reading', 'archived']).optional(),
  sourceId: z.coerce.number().int().positive().optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).default(0),
  mode: z.enum(['palette', 'full']).default('full'),
});

// --- AI Features ---

/** Validates request body containing a single articleId (used by summarize and auto-tag) */
export const articleIdBodySchema = z.object({
  articleId: z.number().int().positive(),
});

/** Validates POST /api/ai/summarize request body */
export const summarizeSchema = articleIdBodySchema;

/** Validates POST /api/ai/clean request body */
export const cleanArticleSchema = articleIdBodySchema;

/** Validates POST /api/ai/revert request body */
export const revertArticleSchema = articleIdBodySchema;

/** Validates POST /api/ai/tag request body */
export const autoTagSchema = articleIdBodySchema;

/** Validates POST /api/ai/index request body */
export const indexSchema = z.object({
  articleId: z.number().int().positive(),
  force: z.boolean().optional().default(false),
});

/** Validates POST /api/ai/index/backfill request body */
export const backfillSchema = z.object({
  batchSize: z.number().int().min(1).max(50).optional().default(10),
  limit: z.number().int().positive().optional(),
});

/** Validates POST /api/ai/explain request body */
export const explainSchema = z.object({
  highlightId: z.number().int().positive(),
  mode: z.enum(['explain', 'importance']).default('explain'),
});

// --- TTS (Text-to-Speech) ---

/** Validates the `articleId` route param for GET /api/tts/[articleId] */
export const ttsArticleIdSchema = z.coerce.number().int().positive();

/** Validates GET /api/tts/[articleId] query params */
export const ttsStreamSchema = z.object({
  voiceId: z.string().optional(),
  speed: z.coerce.number().min(0.5).max(1.5).default(1.0),
  startParagraph: z.coerce.number().int().min(0).default(0),
});

/** Validates GET /api/tts/voices query params */
export const ttsVoicesSchema = z.object({
  language: z.string().min(2).max(10).optional(),
});

// --- Newsletters ---

/** Validates PATCH /api/newsletters/[id] request body */
export const updateNewsletterSchema = z.object({
  isBlocked: z.boolean(),
});

// --- Settings ---

/** Per-key value validation for known settings */
const settingValueValidators: Partial<Record<string, z.ZodType>> = {
  tts_default_speed: z.coerce.number().min(0.5).max(1.5).transform(String),
  daily_review_batch_size: z.coerce.number().int().min(5).max(50).transform(String),
  rss_poll_interval: z.coerce.number().int().min(5).max(1440).transform(String),
  appearance_mode: z.enum(APPEARANCE_MODES),
};

/**
 * Validate a single setting value against its known constraints.
 * Returns the validated (possibly coerced) string value.
 * @param key - The setting key
 * @param value - The raw value
 * @returns The validated string value
 */
export function validateSettingValue(key: string, value: string): string {
  const validator = settingValueValidators[key];
  if (validator) return validator.parse(value) as string;
  return value;
}

/** Validates PATCH /api/settings request body */
export const patchSettingsSchema = z
  .object({
    settings: z.record(z.string(), z.string()).refine((obj) => Object.keys(obj).length > 0, {
      message: 'At least one setting must be provided',
    }),
    confirm_password: z.string().optional(),
  })
  .refine(
    (data) => {
      const hasEncrypted = Object.keys(data.settings).some((k) =>
        ENCRYPTED_KEYS.has(k as (typeof SETTING_KEYS)[number]),
      );
      return !hasEncrypted || (data.confirm_password !== undefined && data.confirm_password !== '');
    },
    {
      message: 'confirm_password is required when updating encrypted settings',
      path: ['confirm_password'],
    },
  );

/** Validates POST /api/settings/test request body */
export const testSettingsSchema = z.object({
  service: z.enum(['inworld', 'anthropic', 'readwise', 'mistral']),
  api_key: z.string().min(1),
  confirm_password: z.string().min(1),
});

/** Validates POST /api/import/readwise query params */
export const startReadwiseImportSchema = z.object({
  mode: z.enum(['full', 'incremental']).default('full'),
});

/** Validates GET /api/settings/audit query params */
export const listAuditSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// --- Theses ---

const thesisStatusEnum = z.enum(THESIS_STATUSES);
const thesisRoleEnum = z.enum(THESIS_HIGHLIGHT_ROLES);
const thesisResearchSourceEnum = z.enum(THESIS_RESEARCH_SOURCES);

/** Validates POST /api/theses request body */
export const createThesisSchema = z.object({
  title: z.string().min(3).max(500),
  claim: z.string().max(5000).optional(),
  counterarguments: z.string().max(5000).optional(),
  implications: z.string().max(5000).optional(),
  notes: z.string().max(10000).optional(),
  status: thesisStatusEnum.default('nascent'),
  // Duplicates would violate the (thesis_id, highlight_id) unique index
  // mid-transaction and roll back the thesis insert. Dedupe at the boundary.
  highlightIds: z
    .array(z.number().int().positive())
    .max(50)
    .optional()
    .transform((arr) => (arr ? Array.from(new Set(arr)) : arr)),
});

/** Validates PATCH /api/theses/[id] request body */
export const updateThesisSchema = partialWithAtLeastOne(
  z.object({
    title: z.string().min(3).max(500),
    claim: z.string().max(5000),
    counterarguments: z.string().max(5000),
    implications: z.string().max(5000),
    notes: z.string().max(10000),
    status: thesisStatusEnum,
  }),
);

/** Validates GET /api/theses query params */
export const listThesesSchema = z.object({
  status: z
    .string()
    .optional()
    .transform((val) => val?.split(',').filter(Boolean))
    .pipe(z.array(thesisStatusEnum).optional()),
  search: z.string().optional(),
  sort: z.enum(['updatedAt', 'createdAt', 'title', 'status']).default('updatedAt'),
  order: z.enum(['desc', 'asc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Validates POST /api/theses/[id]/highlights request body */
export const linkHighlightsSchema = z.object({
  highlightIds: z.array(z.number().int().positive()).min(1).max(100),
  role: thesisRoleEnum.default('supporting'),
  note: z.string().max(2000).optional(),
});

/** Validates POST /api/theses/[id]/research request body */
export const addResearchSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1),
  source: thesisResearchSourceEnum.optional(),
});

/** Validates POST /api/theses/suggest request body */
export const suggestThesesSchema = z.object({
  limit: z.number().int().min(1).max(10).default(5),
  strategy: z.enum(['recent', 'random', 'diverse']).default('diverse'),
});

/** Validates POST /api/theses/[id]/suggest-highlights request body */
export const suggestHighlightsSchema = z.object({
  limit: z.number().int().min(1).max(20).default(10),
});

// --- Chat ---

/** Valid chat scope format: 'all', 'article:{id}', 'thesis:{id}', 'tag:{name}', or 'recent:{days}' */
const chatScopeSchema = z
  .string()
  .regex(
    /^(all|article:\d+|thesis:\d+|tag:.+|recent:\d+)$/,
    'Invalid scope format (use "all", "article:{id}", "thesis:{id}", "tag:{name}", or "recent:{days}")',
  );

const chatModelIds = ANTHROPIC_MODELS.map((m) => m.id) as [string, ...string[]];

/** Validates the model field for chat API requests */
export const chatModelSchema = z.enum(chatModelIds).default(DEFAULT_CHAT_MODEL);

/** Validates POST /api/chat (create session + first message) */
export const createChatSchema = z.object({
  message: z.string().min(1).max(5000),
  scope: chatScopeSchema.default('all'),
  model: chatModelSchema,
});

/** Validates POST /api/chat/[id] (send message in existing session) */
export const sendChatMessageSchema = z.object({
  message: z.string().min(1).max(5000),
});

/** Validates GET /api/chat query params */
export const listChatSessionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Validates PATCH /api/chat/[id] */
export const updateChatSessionSchema = partialWithAtLeastOne(
  z.object({
    title: z.string().min(1).max(200),
    scope: chatScopeSchema,
    model: chatModelSchema,
  }),
);

/** Validates a chat filing action (discriminated on type) */
export const chatFileActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_thesis'),
    title: z.string().min(3).max(500),
    claim: z.string().max(5000).optional(),
    highlightIds: z.array(z.number().int().positive()).max(50).optional(),
  }),
  z.object({
    type: z.literal('add_research'),
    thesisId: z.number().int().positive(),
    title: z.string().min(1).max(500),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal('annotate_highlight'),
    highlightId: z.number().int().positive(),
    note: z.string().min(1).max(5000),
  }),
  z.object({
    type: z.literal('bookmark'),
  }),
]);

/** Validates POST /api/chat/[id]/file request body */
export const chatFileSchema = z.object({
  messageId: z.number().int().positive(),
  action: chatFileActionSchema,
});

/** Validates POST /api/chat/lint request body */
export const lintChatSchema = z.object({
  check: z.enum(LINT_CHECKS),
});

// --- Drafts ---

/** Validates POST /api/drafts request body */
export const createDraftSchema = z.object({
  thesisId: z.number().int().positive(),
  templateId: z.enum(TEMPLATE_IDS),
  model: z.enum(DRAFT_MODEL_IDS).optional(),
  angle: z.string().max(500).optional(),
  includedHighlightIds: z.array(z.number().int().positive()).max(100),
  includedResearchIds: z.array(z.number().int().positive()).max(50),
});

/** Validates PATCH /api/drafts/[id] request body */
export const updateDraftSchema = partialWithAtLeastOne(
  z.object({
    title: z.string().min(1).max(300),
    content: z.string().max(50000),
    angle: z.string().max(500).nullable(),
    model: z.enum(DRAFT_MODEL_IDS),
    includedHighlightIds: z.array(z.number().int().positive()).max(100),
    includedResearchIds: z.array(z.number().int().positive()).max(50),
    status: z.enum(DRAFT_STATUSES),
  }),
);

/** Validates POST /api/drafts/[id]/generate request body */
export const generateDraftSchema = z.object({
  force: z.boolean().optional().default(false),
});

/** Validates GET /api/drafts query params */
export const listDraftsSchema = z.object({
  thesisId: z.coerce.number().int().positive().optional(),
  templateId: z.enum(TEMPLATE_IDS).optional(),
  status: z.enum(DRAFT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// --- Voice ---

/** Validates PUT /api/voice/profile request body */
export const updateVoiceProfileSchema = z.object({
  profile: z.string().min(100).max(10000),
});

/** Validates POST /api/voice/profile/extract request body */
export const extractVoiceProfileSchema = z.object({
  force: z.boolean().optional().default(false),
});

/** Validates POST /api/voice/samples request body */
export const createVoiceSampleSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(100).max(50000),
  channelHint: z.string().max(200).optional(),
});

/** Validates PATCH /api/voice/samples/[id] request body */
export const updateVoiceSampleSchema = partialWithAtLeastOne(
  z.object({
    title: z.string().min(1).max(200),
    channelHint: z.string().max(200).nullable(),
  }),
);

/** Validates POST /api/auth/login request body */
export const loginSchema = z.object({
  password: z.string().min(1),
});

// --- Usage ---

/** Shared AI-usage time-range enum (day|week|month|all) reused across usage query schemas */
const usageRangeEnum = z.enum(['day', 'week', 'month', 'all']);

/** Validates GET /api/usage/summary query params */
export const usageSummaryQuerySchema = z.object({
  range: usageRangeEnum.default('month'),
});

/** Validates GET /api/usage/breakdown query params */
export const usageBreakdownQuerySchema = z.object({
  range: usageRangeEnum.default('month'),
  groupBy: z.enum(['feature', 'model']).default('feature'),
});

/** Validates GET /api/usage/top-calls query params */
export const usageTopCallsQuerySchema = z.object({
  range: usageRangeEnum.default('month'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Model id enum derived from the MODEL_PRICING rate card (single source of truth) */
const modelIdEnum = z.enum(Object.keys(MODEL_PRICING) as [string, ...string[]]);

/** Validates GET /api/usage/estimate query params */
export const usageEstimateQuerySchema = z.object({
  model: modelIdEnum,
  maxInputTokens: z.coerce.number().int().min(0),
  minOutputTokens: z.coerce.number().int().min(0),
  maxOutputTokens: z.coerce.number().int().min(0),
  maxWebSearches: z.coerce.number().int().min(0).default(0),
});

/** Validates PATCH /api/usage/budget request body */
export const updateBudgetSchema = z.object({
  budgetUsd: z.number().nonnegative().nullable(),
});

// --- Upload ---

/** Validates the optional `title` field of the POST /api/upload multipart form */
export const uploadFormSchema = z.object({
  title: z
    .string()
    .trim()
    .max(500)
    .transform((s) => s || undefined)
    .optional(),
});
