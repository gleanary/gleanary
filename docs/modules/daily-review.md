# Module 6: Daily Review (Spaced Repetition)

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `highlights` (reviewCount, reviewInterval, lastReviewed)
**Unimplemented sections**: none

## Purpose

Surface highlights for review using spaced repetition. Helps the user retain knowledge from articles they've read by periodically resurfacing their highlights.

## Algorithm

Simplified SM-2 spaced repetition using fields already on the `highlights` table:

- `last_reviewed` — timestamp of last review (null = never reviewed)
- `review_count` — number of times reviewed (default 0)
- `review_interval` — current interval in days (default 0)

### Scheduling

A highlight is **due** when:

- `last_reviewed IS NULL` (never reviewed), OR
- `last_reviewed + review_interval days <= today`

### Review Actions

- **"Got it"** — user remembers the highlight:
  - If first review (`reviewCount === 0`): set interval to 1 day
  - Otherwise: double the interval (`interval × 2`)
  - Increment `reviewCount`
  - Set `lastReviewed` to now

- **"Review again"** — user doesn't remember:
  - Reset interval to 1 day
  - Increment `reviewCount`
  - Set `lastReviewed` to now

### Session

- Max highlights per session: 15 (configurable via query param)
- Session is complete when all due highlights in the batch have been reviewed
- Due highlights are ordered randomly to avoid recency bias

## API Contract

### GET /api/review

Returns due highlights for review.

**Query params:**

- `limit` — max highlights to return (default 15, max 50)

**Response (200):**

```json
{
  "highlights": [
    {
      "id": 1,
      "articleId": 2,
      "text": "The highlight text...",
      "note": "Optional note",
      "color": "yellow",
      "lastReviewed": "2025-01-01T00:00:00",
      "reviewCount": 3,
      "reviewInterval": 8,
      "article": {
        "title": "Article Title",
        "url": "https://example.com/article",
        "siteName": "Example"
      },
      "tags": [{ "id": 1, "name": "tech", "color": "#3b82f6" }]
    }
  ],
  "totalDue": 42
}
```

### POST /api/review

Record a review action on a highlight.

**Body:**

```json
{
  "highlightId": 1,
  "action": "got_it"
}
```

`action` is one of: `"got_it"` | `"review_again"`

**Response (200):**

```json
{
  "highlight": {
    "id": 1,
    "lastReviewed": "2025-03-05T12:00:00",
    "reviewCount": 4,
    "reviewInterval": 16
  },
  "remaining": 14
}
```

## UI

### /review page

- Shows a card-based review session
- Each card shows the highlight text with a colored left border
- "Reveal" button shows the article title, source, and the highlight's note (if one exists) — notes are the user's own context and seeing them reinforces the association
- Two action buttons: "Got it" and "Review again"
- Progress indicator: "3 / 15 reviewed"
- Empty state when no highlights are due
- Completion state when all due highlights have been reviewed

## Dependencies

- `src/db/schema.ts` — highlights table (existing fields: lastReviewed, reviewCount, reviewInterval)
- `src/lib/highlight-utils.ts` — getTagsForHighlights for batch tag loading
- `src/types/index.ts` — HighlightWithContext type

## Edge Cases

- No highlights exist at all → show "Add some highlights first" message
- No highlights due → show "All caught up!" message
- Highlight's article was deleted → CASCADE handles this, highlight won't appear
- Very large review_interval (e.g., 256 days) → still works, just rare reviews
