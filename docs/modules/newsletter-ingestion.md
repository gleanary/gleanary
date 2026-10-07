# Module 11: Newsletter Email Ingestion

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `sources` (senderAddress, isBlocked, lastReceivedAt), `articles`
**Unimplemented sections**: none

## Purpose

Allow the user to receive email newsletters as articles in the app. Newsletters are sent (or forwarded) to a dedicated email address. The app polls the mailbox via IMAP, parses the email HTML, sanitizes it, and saves it as an article with source type `newsletter`.

## Architecture Overview

```
Newsletter sender
  → inbox@reader.example.com (OVH MX Plan)
  → OVH mail server stores the email
  → App polls via IMAP every 5 minutes (node-cron, same as RSS)
  → Fetches unread emails
  → New senders → pending state (articles hidden until approved)
  → Approved senders → articles saved to inbox
  → Blocked senders → emails marked as read, skipped
  → Parses email HTML → DOMPurify sanitization → saves as article
  → Marks email as read
```

### Allowlist Model

Instead of plus-addressing (not supported by OVH), the app uses an allowlist:

- **Pending** (`isBlocked: null`): New unknown senders. Articles saved but hidden from inbox.
- **Approved** (`isBlocked: false`): Trusted senders. Articles go directly to inbox.
- **Blocked** (`isBlocked: true`): Spam/unwanted. Emails skipped entirely.

Users manage senders via the `/newsletters` management page.

## Dependencies

- `imapflow` — Modern IMAP client (MIT, actively maintained, Promise-based)
- `mailparser` — Parse MIME email into structured data (from `nodemailer` ecosystem)
- `src/lib/sanitize.ts` — DOMPurify HTML sanitization (exists)
- `src/lib/article-parser.ts` — `parseArticleFromHtml()` for content extraction (exists)
- `src/lib/feed-scheduler.ts` — Cron pattern to follow (exists)
- `src/db/schema.ts` — sources table with `newsletter` type, articles table (exists)

## Setup (Manual — User)

1. In OVH Manager → Emails → Create account: `inbox@reader.example.com`
2. Note the IMAP credentials (server: `ssl0.ovh.net`, port: 993, SSL)
3. Configure IMAP credentials in the Settings UI (`/settings` → "Newsletter (IMAP)" section):
   - IMAP Host: `ssl0.ovh.net`
   - Port: `993`, Use TLS: checked
   - Username: `inbox@reader.example.com`
   - Password: your email password
4. Subscribe to newsletters using: `inbox@reader.example.com`
5. Or set up auto-forwarding from Gmail/Outlook to that address
6. New senders appear as "Pending" in `/newsletters` — approve to start receiving

## API Contract

### `GET /api/newsletters`

List all newsletter sources (senders the app has seen).

**Response (200):**

```json
{
  "newsletters": [
    {
      "id": 1,
      "name": "Stratechery by Ben Thompson",
      "senderAddress": "ben@stratechery.com",
      "articleCount": 23,
      "lastReceivedAt": "2026-03-05T08:00:00Z",
      "isBlocked": false
    }
  ]
}
```

### `POST /api/newsletters/poll`

Manually trigger an IMAP poll (same pattern as `POST /api/feeds/poll`).

**Response (200):**

```json
{
  "polled": true,
  "newArticles": 3,
  "errors": []
}
```

### `PATCH /api/newsletters/[id]`

Block/unblock a newsletter sender. Blocked senders' emails are ignored during polling.

**Request body:**

```json
{
  "isBlocked": true
}
```

**Response (200):** Updated newsletter source.

## Data Model Changes

### Source type extension

Add `newsletter` to the source type enum. Each unique sender email becomes a source:

```typescript
// When a new sender is seen for the first time:
// 1. Create a source with type: 'newsletter', name: sender display name
// 2. Store sender email in a new 'senderAddress' field
```

### Schema addition

Add to `sources` table:

- `sender_address` — TEXT, nullable (only used for newsletter sources)
- `is_blocked` — INTEGER (boolean), default 0 (only used for newsletter sources)
- `last_received_at` — TEXT (ISO datetime), nullable

## Email Processing Flow

1. **Connect to IMAP** — Using `imapflow`, connect to OVH mail server with TLS
2. **Open INBOX** — Lock on the INBOX folder
3. **Fetch unread messages** — Search for `UNSEEN` messages
4. **For each email:**
   a. **Parse MIME** — Extract headers, HTML body, plain text body, attachments via `mailparser`
   b. **Validate recipient** — Check that the `To` or `Delivered-To` header contains the configured `+secret` token. Skip if invalid (prevents spam ingestion if address leaks without token).
   c. **Check sender block list** — Look up sender address in sources table. If `is_blocked = true`, mark as read and skip.
   d. **Find or create source** — Look up sender address. If new sender, create a source with `type: 'newsletter'`, name from sender display name.
   e. **Check duplicate** — Use `Message-ID` header as dedup key. If an article with this message ID already exists, skip.
   f. **Extract content** — Prefer HTML body. If no HTML, use plain text wrapped in `<p>` tags.
   g. **Sanitize** — Run through `sanitizeArticleHtml()` (DOMPurify). Same pipeline as article parser.
   h. **Extract metadata:**
   - `title` — From `Subject` header
   - `author` — From `From` header display name
   - `publishedAt` — From `Date` header
   - `url` — Generate a deterministic internal URL: `/newsletter/<message-id-hash>` (newsletters don't have a web URL)
   - `siteName` — From sender domain or display name
   - `excerpt` — First 300 chars of plain text
   - `wordCount` — From plain text content
     i. **Resolve relative URLs** — Convert relative `src` and `href` to absolute (using sender domain as base if possible)
     j. **Preserve images** — Keep `<img>` tags with remote `src` URLs. Don't download/proxy images (they load from the original server when reading).
     k. **Save article** — Insert via existing data layer with `sourceId` pointing to the newsletter source, `status: 'inbox'`
     l. **Store Message-ID** — Save in a new `external_id` field on articles for deduplication
     m. **Mark email as read** — Set `\Seen` flag via IMAP
5. **Disconnect** — Close IMAP connection
6. **Log results** — Structured log: `{ event: 'newsletter_poll', newArticles: N, skipped: N, errors: [] }`

## Scheduler

Same pattern as RSS feed poller:

```typescript
// In src/lib/newsletter-poller.ts
export async function pollNewsletter(): Promise<PollResult> { ... }

// In src/lib/newsletter-scheduler.ts
export function startNewsletterScheduler(): void {
  // Polls every 5 minutes via node-cron
  // Concurrency guard: skip tick if previous poll still running
}
```

Start/stop alongside the feed scheduler in the app initialization.

## Schema Changes

### Articles table

Add column:

- `external_id` — TEXT, nullable, unique. Stores email `Message-ID` for dedup. Also usable by RSS for GUID dedup in the future.

### Sources table

Add columns:

- `sender_address` — TEXT, nullable. Email address of the newsletter sender.
- `is_blocked` — INTEGER, default 0. Whether to ignore emails from this sender.
- `last_received_at` — TEXT, nullable. Timestamp of last received email.

## Edge Cases

1. **New sender (spam)** — Articles saved with `pending_review` status, hidden from inbox until approved.
2. **Duplicate email (same Message-ID)** — Skip silently, mark as read.
3. **Blocked sender** — Mark as read, skip processing.
4. **HTML-only email (no plain text)** — Extract plain text by stripping tags (same as article parser).
5. **Plain text-only email (no HTML)** — Wrap in `<p>` tags (with HTML entity escaping), treat as content.
6. **Multipart email with attachments** — Ignore attachments, only process the HTML/text body.
7. **Very large email (>5MB)** — Skip, log warning. Don't process to avoid memory issues.
8. **IMAP connection failure** — Log error, retry on next cron tick. Don't crash the app.
9. **Invalid email encoding** — `mailparser` handles charset detection. Fall back to UTF-8.
10. **Newsletter with "View in browser" link** — Don't follow the link. Use the email HTML directly.
11. **Forwarded email** — The original `From` is preserved. Sender goes through the allowlist flow.
12. **Multiple recipients in To/CC** — All emails in the inbox are processed regardless of recipients.

## Security

- **Spam prevention**: Allowlist model — new senders are held in pending state. Only approved senders' articles appear in the inbox.
- **XSS**: All email HTML sanitized via DOMPurify (same pipeline as article parser).
- **IMAP credentials**: Stored encrypted in the settings DB (AES-256-GCM), never logged, never exposed to client.
- **No outbound email**: The app never sends email. IMAP is read-only.
- **Image loading**: Images load from original servers when the user reads the article. No proxying. This means the newsletter sender can track opens — acceptable for a personal tool.

## Configuration

IMAP credentials are configured via the Settings UI at `/settings` → "Newsletter (IMAP)". No environment variables are required.

Fields: IMAP Host, Port (default 993), Username (encrypted), Password (encrypted), Use TLS (default on), Mailbox (default INBOX), Poll Interval in minutes (default 5).

If IMAP host is not set, the newsletter scheduler does not start (graceful disable).

## Files

| File                                            | Action                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `docs/modules/newsletter-ingestion.md`          | Create — this spec                                                     |
| `src/lib/newsletter-poller.ts`                  | Create — IMAP connect, fetch, parse, save                              |
| `src/lib/newsletter-scheduler.ts`               | Create — Cron scheduler (5-min interval)                               |
| `src/app/api/newsletters/route.ts`              | Create — GET (list), POST poll trigger                                 |
| `src/app/api/newsletters/[id]/route.ts`         | Create — PATCH (block/unblock)                                         |
| `src/lib/validators.ts`                         | Extend — newsletter schemas                                            |
| `src/types/index.ts`                            | Extend — NewsletterSource type                                         |
| `src/db/schema.ts`                              | Modify — add external_id, sender_address, is_blocked, last_received_at |
| `src/config/index.ts`                           | Modify — add IMAP config                                               |
| `.env.example`                                  | Modify — add IMAP vars                                                 |
| `drizzle/`                                      | New migration                                                          |
| `__tests__/unit/newsletter-poller.test.ts`      | Create                                                                 |
| `__tests__/integration/newsletter.test.ts`      | Create                                                                 |
| `__tests__/mocks/fixtures/newsletter-emails.ts` | Create — sample MIME fixtures                                          |
