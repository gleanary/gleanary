# Module 7: AI Features

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `articles` (aiSummary, aiTags), `highlights`, `theses`
**Unimplemented sections**: none

## Purpose

Integrate Claude API for article summarization, auto-tagging, and highlight explanations. All AI features are on-demand (user-triggered), with results cached in the database.

## API Contract

### POST /api/ai/summarize

Summarize an article's content using Claude.

**Request:**

```json
{ "articleId": 42 }
```

**Response (200):**

```json
{
  "summary": "A 2-3 sentence summary of the article.",
  "cached": false
}
```

The `cached` field indicates whether the result was returned from the database cache (`true`) or freshly generated via Claude API (`false`).

**Behavior:**

1. Validate input with Zod (articleId: positive integer)
2. Fetch article from DB (404 if not found)
3. If `ai_summary` already exists, return cached value
4. Send `contentText` (or `contentHtml` fallback) to Claude API with summarization system prompt
5. Store result in `articles.ai_summary`
6. Return summary

**Error cases:**

- 404: Article not found
- 422: Invalid input
- 503: Claude API error (ExternalServiceError)
- 503: No Anthropic API key configured — `error` is `"Claude API: API key not configured. Add your Anthropic API key in Settings → Integrations."` (thrown before any request is sent)

### POST /api/ai/tag

Auto-tag an article based on its content. Article AI tags are their own vocabulary: the highlight `tags` table is never read or written (see `context-panel.md` §4.1). Migration `0023_drop_auto_tag_leftovers` removed the leftovers of the earlier behavior that inserted every suggestion into `tags`: unlinked tags whose name (trimmed, case-insensitive) is also some article's AI tag.

**Request:**

```json
{ "articleId": 42 }
```

**Response (200):**

```json
{ "tags": ["typescript", "Testing"] }
```

**Behavior:**

1. Validate input with Zod (articleId: positive integer)
2. Fetch article from DB (404 if not found, 422 if it has no content)
3. Build the vocabulary from the other articles' `ai_tags` with `getArticleTagVocabulary` (`src/lib/db-helpers.ts`): one SQLite `json_each` aggregate counts the names (only that column is read; malformed values are skipped without logging). Names are trimmed and grouped case-insensitively (first spelling wins; a JS pass also merges non-ASCII case variants), and only the 200 most frequent are kept (a name counts once per article), ties broken by first use
4. Send article content + the vocabulary to Claude with the auto-tag system prompt
5. Parse Claude's response as a JSON array of tag names (`parseTagsResponse` trims, lower-cases and de-duplicates)
6. Replace each suggestion that matches the vocabulary case-insensitively with the existing spelling, so "testing" and "Testing" both become one "Testing"
7. Store the names as JSON in `articles.ai_tags` (nothing is stored when the model suggests none)
8. Return `{ tags }`

### POST /api/ai/explain

Explain a highlight in context using Claude.

**Request:**

```json
{
  "highlightId": 7,
  "mode": "explain"
}
```

**Response (200):**

```json
{
  "explanation": "This passage discusses..."
}
```

**Modes:** `"explain"` (explain this passage) | `"importance"` (why is this important)

**Behavior:**

1. Validate input with Zod
2. Fetch highlight + parent article from DB
3. Send highlight text with article context to Claude
4. Return explanation (not cached — always fresh)

## Dependencies

- `@anthropic-ai/sdk` (already installed)
- `src/db/schema.ts` — articles table (ai_summary, ai_tags columns)
- `src/lib/errors.ts` — ExternalServiceError
- `src/lib/validators.ts` — shared validation patterns

## System Prompts

Stored as constants in `src/lib/ai.ts`:

- **SUMMARIZE_PROMPT**: "You are a reading assistant. Summarize the following article in 2-3 concise sentences. Focus on the key points and main argument."
- **AUTO_TAG_PROMPT**: "You are a librarian. Given an article and a list of existing tags, suggest 2-5 tags that categorize this article. Prefer existing tags when they fit. Return a JSON array of tag name strings."
- **EXPLAIN_PROMPT**: "You are a reading assistant. Explain the following highlighted passage from an article, providing context and meaning."
- **IMPORTANCE_PROMPT**: "You are a reading assistant. Explain why the following highlighted passage is important or noteworthy in the context of the article."

## Edge Cases

- Article with no content (only URL/title): return error "Article has no content to analyze"
- Very long articles: truncate content to ~100K chars before sending to Claude
- No Anthropic API key (neither the `anthropic_api_key` setting nor `ANTHROPIC_API_KEY`): every Claude call (summarize, tag, explain, chat SSE `error` event, …) fails fast with 503 "API key not configured" instead of the raw SDK auth error. The missing key is not cached, so saving a key in Settings takes effect on the next call. `POST /api/ai/clean` checks this up front when Haiku is the only reformat provider (provider `anthropic`, or no Mistral key), so a chunked reformat returns 503 rather than 422 "All chunks failed"; with Mistral configured as the provider, no Anthropic key is required.
- Claude API timeout: 30s timeout, return 503
- Claude API rate limit: return 503
- Empty tag suggestions: return empty array, don't update ai_tags
- Duplicate tag suggestions: deduplicate before creating

## Types

```typescript
/** Validates POST /api/ai/summarize */
export const summarizeSchema = z.object({
  articleId: z.number().int().positive(),
});

/** Validates POST /api/ai/tag */
export const autoTagSchema = z.object({
  articleId: z.number().int().positive(),
});

/** Validates POST /api/ai/explain */
export const explainSchema = z.object({
  highlightId: z.number().int().positive(),
  mode: z.enum(['explain', 'importance']).default('explain'),
});
```
