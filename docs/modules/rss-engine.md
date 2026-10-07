# Module 3: RSS Feed Engine

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `sources`, `articles`
**Unimplemented sections**: none

## Purpose

Poll RSS/Atom feeds on a configurable schedule, detect new entries, parse them into articles, and store them with `status=inbox`. Provides both automated cron-based polling and a manual poll API.

## Dependencies

- **Module 1 (Data Layer)**: `sources` table (CRUD), `articles` table (insert)
- **Module 2 (Article Parser)**: `parseArticleFromUrl()` for fetching + parsing feed item links
- **External**: `rss-parser` (RSS/Atom/JSON Feed parsing), `node-cron` (scheduling)

## Components

### 1. Feed Poller (`src/lib/feed-poller.ts`)

Core polling logic. Stateless functions that operate on the database.

#### `pollFeed(source: Source): Promise<PollResult>`

Polls a single RSS feed source:

1. Validate source is `type=rss_feed` with valid `feedUrl`
2. Fetch feed URL with conditional headers (`If-None-Match: etag`, `If-Modified-Since: lastModified`)
3. If 304 Not Modified → return early, update `lastPolled`
4. Parse response with `rss-parser`
5. **Batch dedup**: Query all item URLs at once via `inArray()` to check which already exist in `articles` table (more efficient than per-item dedup)
6. For each new feed item:
   - Extract canonical URL from `item.link`; skip items with no link
   - Resolve relative URLs against feed link
   - If new (not in batch dedup results): call `parseArticleFromUrl(url)` → insert article with `sourceId` and `status=inbox`
   - If article parser fails for an item: log warning, continue to next item
7. Update source: `lastPolled`, `etag`, `lastModified` from response headers

#### `pollAllFeeds(): Promise<PollResult[]>`

Polls all feeds that are due:

1. Query sources where `type='rss_feed'` AND (`lastPolled` is null OR `lastPolled + pollInterval` ≤ now)
2. Poll each due feed sequentially (avoid overwhelming external servers)
3. Return array of results

### 2. Feed Scheduler (`src/lib/feed-scheduler.ts`)

Cron-based scheduling for automated polling.

#### `startFeedScheduler(): void`

- Registers a `node-cron` job that runs every minute
- Each tick calls `pollAllFeeds()` (which internally filters for due feeds)
- **Concurrency guard**: Uses node-cron's `noOverlap: true` task option to prevent overlapping polls (if a poll takes longer than 1 minute, the next tick is blocked and an `execution:overlap` listener logs a `feed_scheduler_skip` debug event). node-cron's internal logs are routed to pino via the `cronLogger` adapter (`src/lib/cron-logger.ts`)
- Logs start/stop events

#### `stopFeedScheduler(): void`

- Stops the cron job
- Used for graceful shutdown and testing

### 3. API Route (`POST /api/feeds/poll`)

Manual trigger for feed polling.

**Request body** (optional):

```json
{ "sourceId": 123 }
```

**Response (200)**:

```json
{
  "results": [
    {
      "feedId": 1,
      "feedName": "Hacker News",
      "newArticles": 3,
      "skipped": 12,
      "errors": []
    }
  ]
}
```

**Errors**:

- 422: Invalid sourceId
- 404: Source not found or not an RSS feed
- 502: Feed fetch failed (all feeds unreachable)

## Types

```typescript
interface PollResult {
  feedId: number;
  feedName: string;
  newArticles: number;
  skipped: number;
  errors: string[];
}
```

## Edge Cases

| Scenario                          | Behavior                                            |
| --------------------------------- | --------------------------------------------------- |
| Feed URL returns non-XML          | Log error, return PollResult with error             |
| Feed item has no `link`           | Skip item, increment `skipped`                      |
| Feed item URL already in DB       | Skip (dedup by URL), increment `skipped`            |
| Article parser fails for one item | Log warning, continue to next item, add to `errors` |
| Feed is unreachable / timeout     | Log error, do NOT update `lastPolled`               |
| Feed returns 304 Not Modified     | Update `lastPolled` only, return 0 new articles     |
| Feed item link is relative        | Resolve against feed's `<link>` element             |
| Empty feed (no items)             | Valid — update `lastPolled`, return 0 new articles  |
| Source is not type `rss_feed`     | Return error in PollResult                          |
| Source has no `feedUrl`           | Return error in PollResult                          |
| Duplicate GUID but different URL  | Dedup is by URL, not GUID — treated as new article  |

## Security Considerations

- Feed URLs are fetched via `safeFetchText()` which validates URLs internally (SSRF prevention)
- Article content is sanitized by the article parser (DOMPurify)
- Feed XML parsing uses rss-parser (no raw XML eval)
- Poll intervals have min/max bounds (1–1440 minutes, enforced by validator)
