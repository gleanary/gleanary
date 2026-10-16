/**
 * LLM models configuration and budget management.
 *
 * ALL_CLAUDE_MODELS is the single source of truth for every Claude model: its API call ID,
 * pricing, context window, and which selectors it appears in. Adding a new model requires
 * one entry here — pricing.ts derives its Claude rate card from this registry automatically.
 *
 * To add a model:
 *   1. Append an entry to ALL_CLAUDE_MODELS (include 'chat' and/or 'draft' in features).
 *   2. That's it — ANTHROPIC_MODELS, DRAFT_MODELS, and CLAUDE_PRICING all update automatically.
 *
 * Historical entries (features: []) are kept so computeCost can price old ai_usage rows.
 */

/** Rough chars-to-tokens ratio (4 chars ≈ 1 token) */
const CHARS_PER_TOKEN = 4;

/** Fraction of context window reserved for retrieved knowledge-base context */
const CONTEXT_FRACTION = 0.4;

/** Fraction of context window reserved for conversation history */
const HISTORY_FRACTION = 0.075;

/** Fraction of context window reserved for model response */
const RESPONSE_FRACTION = 0.02;

export interface TokenPricing {
  /** USD per million input tokens */
  input: number;
  /** USD per million output tokens */
  output: number;
  /** USD per million cache-read tokens */
  cacheRead: number;
  /** USD per million cache-write tokens (5-min TTL rate) */
  cacheWrite: number;
}

interface ClaudeModelSpec {
  /**
   * Normalized model ID — used as the pricing key and in MODEL_PRICING.
   * For models with a date-snapshot suffix required by the API (e.g. Haiku),
   * set apiId to the full dated form and id to the normalized base.
   */
  readonly id: string;
  /** Full API call ID when it differs from id (e.g. 'claude-haiku-4-5-20251001'). */
  readonly apiId?: string;
  readonly name: string;
  readonly contextWindow: number;
  readonly pricing: TokenPricing;
  /** Selector membership. Empty array = historical entry (pricing only, not in UI). */
  readonly features: ReadonlyArray<'chat' | 'draft'>;
}

// Prices per million tokens, in USD. Source: https://www.anthropic.com/pricing
// Verified June 2026. Update when Anthropic changes rates.
const ALL_CLAUDE_MODELS = [
  // ── Active models (appear in selectors) ──────────────────────────────────
  {
    id: 'claude-haiku-4-5',
    apiId: 'claude-haiku-4-5-20251001',
    name: 'Haiku 4.5',
    contextWindow: 200_000,
    pricing: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    features: ['chat', 'draft'],
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    contextWindow: 1_000_000,
    pricing: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    features: ['chat', 'draft'],
  },
  {
    // 'claude-sonnet-5' is the full dateless API id — no apiId needed.
    // Standard pricing entered deliberately: Anthropic's intro pricing ($2/$10 through
    // 2026-08-31) is not modeled because computeCost prices rows at read time, so the
    // rate card must reflect the steady-state price, not a temporary promotion.
    id: 'claude-sonnet-5',
    name: 'Sonnet 5',
    contextWindow: 1_000_000,
    pricing: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    features: ['chat', 'draft'],
  },
  {
    id: 'claude-opus-4-8',
    name: 'Opus 4.8',
    contextWindow: 1_000_000,
    pricing: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    features: ['chat', 'draft'],
  },
  // ── Historical (pricing only — for cost records on old ai_usage rows) ────
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    contextWindow: 1_000_000,
    pricing: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    features: [],
  },
  {
    id: 'claude-opus-4-6',
    name: 'Opus 4.6',
    contextWindow: 1_000_000,
    pricing: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    features: [],
  },
  {
    id: 'claude-sonnet-4',
    name: 'Sonnet 4',
    contextWindow: 200_000,
    pricing: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
    features: [],
  },
] as const satisfies readonly ClaudeModelSpec[];

/** Union of all known Claude pricing keys (normalized model IDs). */
export type ClaudeModelId = (typeof ALL_CLAUDE_MODELS)[number]['id'];

/**
 * Pricing map for all Claude models, keyed by normalized model ID.
 * Imported by pricing.ts to build MODEL_PRICING — do not duplicate entries there.
 */
export const CLAUDE_PRICING = Object.fromEntries(
  ALL_CLAUDE_MODELS.map((m) => [m.id, m.pricing]),
) as { [K in ClaudeModelId]: TokenPricing };

export interface AnthropicModel {
  /** API call ID (may include date suffix, e.g. 'claude-haiku-4-5-20251001') */
  id: string;
  name: string;
  contextWindow: number;
}

/** All Anthropic models available for chat — derived from ALL_CLAUDE_MODELS. */
export const ANTHROPIC_MODELS: AnthropicModel[] = ALL_CLAUDE_MODELS.filter((m) =>
  m.features.some((f) => f === 'chat'),
).map((m) => ({ id: 'apiId' in m ? m.apiId : m.id, name: m.name, contextWindow: m.contextWindow }));

/** Default model for new chat sessions */
export const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6';

/** Model IDs available for draft generation — keep in sync with DB schema default */
export const DRAFT_MODEL_IDS = ALL_CLAUDE_MODELS.filter((m) =>
  m.features.some((f) => f === 'draft'),
).map((m) => ('apiId' in m ? m.apiId : m.id)) as unknown as readonly [string, ...string[]];

export type DraftModelId = string;

export const DEFAULT_DRAFT_MODEL: DraftModelId = 'claude-sonnet-4-6';

/** Display metadata for each draft model — derived from ALL_CLAUDE_MODELS. */
export const DRAFT_MODELS: Array<{ id: DraftModelId; name: string }> = ALL_CLAUDE_MODELS.filter(
  (m) => m.features.some((f) => f === 'draft'),
).map((m) => ({ id: 'apiId' in m ? m.apiId : m.id, name: m.name }));

/**
 * Default model for non-chat AI features (summarize, tag, explain, thesis/highlight suggest,
 * concept index, voice extraction). Must be an active (non-historical) registry entry —
 * retired model ids are rejected by the Anthropic API with 404 not_found_error.
 */
export const DEFAULT_FEATURE_MODEL = 'claude-sonnet-4-6';

/** Model used for utility calls: keyword extraction, chat title generation, lint, ai-clean fallback */
export const UTILITY_MODEL = 'claude-haiku-4-5-20251001';

export interface ModelBudget {
  /** Max chars of retrieved context to include (~40% of context window) */
  contextBudgetChars: number;
  /** Max chars of conversation history to include (~7.5% of context window) */
  historyBudgetChars: number;
  /** Max tokens for model response (~2% of context window, capped at 4096) */
  maxResponseTokens: number;
}

/**
 * Returns token/char budgets for a given model based on its context window.
 * Falls back to 200k window size if the model ID is not recognized.
 * @param modelId - Anthropic model ID (API call form or normalized)
 * @returns Budget values scaled to the model's context window
 */
export function getModelBudget(modelId: string): ModelBudget {
  const model = ALL_CLAUDE_MODELS.find(
    (m) => ('apiId' in m ? m.apiId : m.id) === modelId || m.id === modelId,
  );
  const contextWindow = model?.contextWindow ?? 200_000;

  return {
    contextBudgetChars: Math.floor(contextWindow * CONTEXT_FRACTION * CHARS_PER_TOKEN),
    historyBudgetChars: Math.floor(contextWindow * HISTORY_FRACTION * CHARS_PER_TOKEN),
    maxResponseTokens: Math.min(4096, Math.floor(contextWindow * RESPONSE_FRACTION)),
  };
}
