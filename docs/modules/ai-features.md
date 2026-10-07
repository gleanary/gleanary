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
- 502: Claude API error (ExternalServiceError)

### POST /api/ai/tag

Auto-tag an article based on its content. Uses existing tag vocabulary when possible.

**Request:**

```json
{ "articleId": 42 }
```

**Response (200):**

```json
{
  "tags": [
    { "id": 1, "name": "typescript", "color": null },
    { "id": 12, "name": "testing", "color": "#00FF00" }
  ],
  "created": ["new-suggested-tag"]
}
```

**Behavior:**

1. Validate input with Zod (articleId: positive integer)
2. Fetch article from DB (404 if not found)
3. Fetch existing tags from DB to provide vocabulary
4. Send article content + existing tag names to Claude with auto-tag system prompt
5. Parse Claude's response as JSON array of tag names
6. For each suggested tag:
   - If it matches an existing tag name (case-insensitive), use it
   - Otherwise create a new tag
7. Store the tag names as JSON in `articles.ai_tags`
8. Return tag list

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
- Claude API timeout: 30s timeout, return 502
- Claude API rate limit: return 502 with retry-after hint
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
