# Module 14: Knowledge Chat

**Status**: Done
**Last verified against code**: 2026-04 (docs session)
**Schema tables**: `chat_sessions`, `chat_messages`, `chat_messages_fts`; reads from `articles`, `articles_fts`, `highlights`, `highlights_fts`, `theses`, `thesis_highlights`, `thesis_research`, `tags`, `highlight_tags`
**Unimplemented sections**: none
**Dependencies**: Module 1 (Data Layer), Module 7 (AI Features), Module 13 (Thesis Tracker)

---

## Purpose

Chat with your entire reading knowledge base — articles, highlights, notes, theses, and research entries — in a single conversational interface. Unlike per-document chat (Readwise Reader), this module reasons across everything you've read and highlighted, with the ability to file insights back into theses, research entries, and highlight notes so that knowledge compounds over time.

Inspired by [Karpathy's LLM Knowledge Base](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern: instead of ephemeral Q&A, every good answer can be filed back into the structured knowledge base, making future queries richer.

---

## Core Concepts

### Knowledge retrieval (not RAG)

At personal scale (hundreds of articles, thousands of highlights), vector search is unnecessary. The module uses a two-stage retrieval pipeline:

1. **FTS5 keyword search** across `articles_fts` and `highlights_fts` to find candidate content
2. **LLM reranking + synthesis** — Claude reads the candidates and produces a grounded answer with citations

This mirrors Karpathy's approach: structured text + index files + LLM reasoning, no embeddings needed.

### Article concept index

Each article gets an LLM-generated **concept index** stored in a new `ai_index` column on the `articles` table. Unlike the narrative `ai_summary` (written for humans), the concept index is a structured, keyword-dense inventory designed for retrieval:

```
TOPICS: AI regulation, EU AI Act, compliance costs, innovation trade-offs, risk classification
ENTITIES: European Commission, OpenAI, Mistral, GDPR, Thierry Breton
ARGUMENTS FOR: regulation increases costs for startups; risk-based classification is unworkable at scale
ARGUMENTS AGAINST: large companies benefit from regulatory moats; harmonized rules reduce fragmentation
RELATED CONCEPTS: regulatory capture, precautionary principle, innovation policy, digital sovereignty
```

This serves as a **keyword bridge** for FTS5 retrieval. When the user asks about "regulatory capture" but the article only uses the phrase "incumbents lobbying for stricter rules," the concept index contains both terms, so FTS5 finds the match. It also captures argumentative structure — what the article supports and challenges — which plain text search misses entirely.

The index is generated asynchronously after article parsing (same pattern as `ai_summary`) using a fast, cheap Claude call (~200-300 tokens output per article). It gets included in the `articles_fts` virtual table so FTS5 searches it automatically alongside title and content.

For highlights, no separate index is needed — highlights are already short and concise, and the combination of highlight text + user note + tags + thesis role provides sufficient retrieval signal.

### Compounding loop

Chat outputs aren't ephemeral. The user can:

- Save an insight as a new thesis (flows into Thesis Tracker)
- Save a synthesis as a research entry on an existing thesis
- Annotate a highlight with the LLM's analysis
- Bookmark a message for later reference

Each action feeds structured data back into the knowledge base, making future chats more informed.

### Context scoping

Every chat session has an optional scope that controls what content the LLM can access:

| Scope           | Description                                            | Use case                           |
| --------------- | ------------------------------------------------------ | ---------------------------------- |
| `all`           | Entire knowledge base                                  | Open-ended exploration             |
| `thesis:{id}`   | A specific thesis + its linked highlights and research | Deep-dive on an argument           |
| `tag:{name}`    | All highlights/articles with a given tag               | Topic-focused research             |
| `article:{id}`  | Single article + its highlights                        | Per-document chat (Readwise-style) |
| `recent:{days}` | Articles saved in the last N days                      | "What have I been reading about?"  |

Default scope is `all`. The scope is set at session creation and displayed in the UI but can be changed mid-conversation.

---

## Data Model

### New tables

```sql
-- Chat sessions
CREATE TABLE chat_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL DEFAULT 'New chat',
  scope TEXT NOT NULL DEFAULT 'all',          -- 'all', 'thesis:5', 'tag:ml', 'article:12', 'recent:30'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chat messages
CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  citations TEXT,                              -- JSON array of {type, id, title, snippet} objects
  context_tokens INTEGER,                      -- tokens used for retrieval context (for debugging/cost tracking)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 for searching across chat history
CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
  content,
  content=chat_messages,
  content_rowid=id
);
```

### Modified existing tables

#### `articles` — new column

```sql
ALTER TABLE articles ADD COLUMN ai_index TEXT;  -- structured concept index for retrieval
```

#### `articles_fts` — add ai_index to FTS5

The existing `articles_fts` virtual table must be rebuilt to include the new `ai_index` column alongside `title` and `content_text`. This means FTS5 queries automatically search across article content, title, _and_ the concept index — no query changes needed.

```sql
-- Drop and recreate (FTS5 doesn't support ALTER)
DROP TABLE IF EXISTS articles_fts;
CREATE VIRTUAL TABLE articles_fts USING fts5(
  title,
  content_text,
  ai_index,                                    -- concept index: topics, entities, arguments, related concepts
  content=articles,
  content_rowid=id
);
-- Repopulate from existing data
INSERT INTO articles_fts(rowid, title, content_text, ai_index)
  SELECT id, title, content_text, ai_index FROM articles;
-- Rebuild sync triggers to include ai_index
```

### Drizzle schema additions (src/db/schema.ts)

#### Existing `articles` table — add column

```typescript
// Add to articles table definition:
aiIndex: text('ai_index'),  // structured concept index for retrieval (topics, entities, arguments)
```

#### New tables

```typescript
export const chatSessions = sqliteTable('chat_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().default(1),
  title: text('title').notNull().default('New chat'),
  scope: text('scope').notNull().default('all'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const chatMessages = sqliteTable('chat_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: integer('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  citations: text('citations'), // JSON string
  contextTokens: integer('context_tokens'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(datetime('now'))`),
});
```

### Type additions (src/types/index.ts)

```typescript
/** Chat session scoping */
export type ChatScope =
  'all' | `thesis:${number}` | `tag:${string}` | `article:${number}` | `recent:${number}`;

/** A citation in an assistant message */
export interface ChatCitation {
  type: 'article' | 'highlight' | 'thesis' | 'research';
  id: number;
  title: string; // article title, highlight text prefix, thesis title
  snippet?: string; // relevant excerpt used in the answer
}

/** Chat session summary for list view */
export interface ChatSessionListItem {
  id: number;
  title: string;
  scope: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
}

/** Chat message for display */
export interface ChatMessageDisplay {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations: ChatCitation[];
  createdAt: string;
}

/** Full chat session with messages */
export interface ChatSessionDetail {
  session: ChatSession;
  messages: ChatMessageDisplay[];
}

/** Action to file a message back into the knowledge base */
export type ChatFileAction =
  | { type: 'create_thesis'; title: string; claim: string; highlightIds: number[] }
  | { type: 'add_research'; thesisId: number; title: string; content: string }
  | { type: 'annotate_highlight'; highlightId: number; note: string }
  | { type: 'bookmark'; messageId: number };
```

---

## API Contract

### Article Concept Index

#### `POST /api/ai/index` — Generate concept index for an article

Generates a structured concept index and stores it in the article's `ai_index` column. Can be called after article parsing or on demand. Idempotent — regenerates if already present when `force: true`.

```typescript
// Request
{
  articleId: number;           // required
  force?: boolean;             // optional, default false — skip if ai_index already populated
}

// Response 200
{
  articleId: number;
  indexed: boolean;            // true if index was generated, false if skipped (already exists + force=false)
}
```

#### `POST /api/ai/index/backfill` — Batch-generate indexes for all unindexed articles

Processes articles where `ai_index IS NULL` in batches. Streams progress via SSE. Intended for one-time backfill of existing articles.

```typescript
// Request
{
  batchSize?: number;          // optional, default 10, max 50 — articles per batch
  limit?: number;              // optional, max articles to process (default: all unindexed)
}

// SSE response stream
event: progress
data: { processed: number, total: number, current: string }  // current = article title

event: error
data: { articleId: number, title: string, error: string }     // non-fatal, continues

event: done
data: { indexed: number, skipped: number, errors: number }
```

#### Prompt for concept index generation

```
Given this article, produce a structured concept index for search retrieval.
This index is NOT for human reading — it will be searched by keywords.
Be comprehensive with synonyms and related terms.

Format (use exactly these headers):
TOPICS: [comma-separated concepts, themes, and keywords]
ENTITIES: [people, companies, organizations, technologies, places mentioned]
ARGUMENTS FOR: [key claims or positions the article supports]
ARGUMENTS AGAINST: [key claims or positions the article challenges or critiques]
RELATED CONCEPTS: [broader themes, synonyms, adjacent ideas not directly discussed but relevant for discovery]

Article title: {title}
Article content: {contentText, truncated to ~8K tokens}
```

#### Auto-generation trigger

The concept index should be generated automatically after article parsing, in the same async flow as `ai_summary` and `ai_tags`. The call is cheap (~300 input tokens for the prompt + ~8K for truncated content, ~200-300 output tokens) and can use Claude Haiku for speed and cost. If the Anthropic API key is not configured, the feature degrades gracefully — articles simply have `ai_index = NULL` and chat retrieval relies on title + content FTS5 alone.

For the backfill endpoint, use a concurrency limit of 3 parallel requests to avoid API rate limits, with 500ms delay between batches.

### Chat Sessions

#### `POST /api/chat` — Create session and send first message

Creates a new chat session and processes the first user message. Returns the assistant's response streamed via SSE.

```typescript
// Request
{
  message: string;            // required, 1-5000 chars
  scope?: string;             // optional, default 'all'
  title?: string;             // optional, auto-generated from first message if omitted
}

// SSE response stream
event: session
data: { id: number, title: string, scope: string }

event: citation
data: { type: string, id: number, title: string, snippet: string }

event: delta
data: { content: string }     // streaming text chunks

event: done
data: { messageId: number, contextTokens: number }
```

#### `POST /api/chat/[id]` — Send message in existing session

Appends a user message to an existing session and streams the assistant's response.

```typescript
// Request
{
  message: string;
} // required, 1-5000 chars

// SSE response: same event types as above (no session event)
```

#### `GET /api/chat` — List sessions

```typescript
// Query params
?limit=20                     // default 20, max 50
&offset=0                     // pagination
&q=search+term                // optional FTS5 search across message content

// Response 200
{
  sessions: ChatSessionListItem[];
  total: number;
}
```

#### `GET /api/chat/[id]` — Get session with messages

```typescript
// Response 200
{
  session: { id, title, scope, createdAt, updatedAt };
  messages: ChatMessageDisplay[];
}
```

#### `PATCH /api/chat/[id]` — Update session title/scope

```typescript
// Request (at least one field)
{ title?: string; scope?: string }

// Response 200
{ id, title, scope, updatedAt }
```

#### `DELETE /api/chat/[id]` — Delete session and all messages

```typescript
// Response 204
```

### Filing Actions

#### `POST /api/chat/[id]/file` — File a message back into the knowledge base

Takes an assistant message and converts it into a thesis, research entry, or highlight annotation.

```typescript
// Request
{
  messageId: number; // the assistant message to file
  action: ChatFileAction; // see type definition above
}

// Response 201
{
  filed: true;
  result: {
    type: 'thesis' | 'research' | 'highlight' | 'bookmark';
    id: number; // ID of the created/updated entity
  }
}
```

### Knowledge Linting (proactive suggestions)

#### `POST /api/chat/lint` — Run a knowledge health check

Runs an LLM pass over the knowledge base to find inconsistencies, gaps, and connection opportunities. Returns suggestions as a structured list.

```typescript
// Request
{
  check: 'connections' | 'contradictions' | 'gaps' | 'stale';
}

// Response 200 (streamed via SSE)
event: suggestion
data: {
  type: 'connection' | 'contradiction' | 'gap' | 'stale';
  description: string;
  relatedIds: { type: string; id: number }[];
  suggestedAction?: string;
}

event: done
data: { totalSuggestions: number }
```

---

## Retrieval Pipeline

### Overview

```
User question
    │
    ▼
┌─────────────────────────┐
│  1. Parse scope          │  Determine which tables/filters to search
│  2. Extract keywords     │  LLM or simple NLP extracts search terms
│  3. FTS5 search          │  Query articles_fts (now includes ai_index) + highlights_fts
│  4. Structured lookup    │  If scope is thesis/tag, also pull linked data
│  5. Rank + truncate      │  Select top-K results, fit within token budget
│  6. Build prompt         │  System prompt + context + conversation history
│  7. Stream response      │  Claude generates answer with citations
│  8. Save messages        │  Persist user + assistant messages to DB
└─────────────────────────┘
```

### Step details

**Step 1 — Parse scope**: Map the session's `scope` string to SQL filters.

- `all` → no filter, search everything
- `thesis:5` → pull thesis #5, its linked highlights (via `thesis_highlights`), its research entries, and the articles those highlights belong to
- `tag:ml` → find all highlights with that tag (via `highlight_tags` + `tags`), plus their parent articles
- `article:12` → pull article #12 content + all its highlights
- `recent:30` → filter `articles.saved_at` to last 30 days

**Step 2 — Extract keywords**: Use a fast Claude call (or simple heuristic) to extract 3-8 search terms from the user's question. Fall back to the raw question text for FTS5 if extraction fails.

**Step 3 — FTS5 search**: Run parallel queries against `articles_fts` and `highlights_fts` with the extracted keywords, applying scope filters. Because `articles_fts` now includes the `ai_index` column, FTS5 automatically matches against concept-level terms (topics, entities, arguments, related concepts) — not just words that appear in the article body. This closes the vocabulary mismatch gap: a query about "regulatory capture" matches even if the article only says "incumbents lobbying for stricter rules," because the concept index contains both phrasings. Return top 20 articles + top 30 highlights by relevance.

**Step 4 — Structured lookup**: For thesis/tag scopes, also pull:

- Thesis claim, counterarguments, implications, notes
- All linked highlights with their roles
- All research entries (title + truncated content)

**Step 5 — Rank + truncate**: Estimate token count of all candidates. If over budget (target: ~80K tokens for context, leaving ~20K for response), prioritize: highlights > article excerpts > full article content > research entries. Highlights are more valuable because they represent user-selected signal.

**Step 6 — Build prompt**: Assemble the Claude API call:

```
System: You are a research assistant with access to the user's reading
knowledge base. Answer questions by synthesizing information from the
provided articles, highlights, and theses. Always cite your sources
using [article:ID], [highlight:ID], or [thesis:ID] notation.
When you don't have enough information, say so.
Never fabricate sources.

Context: {retrieved content, formatted as structured blocks}

Conversation history: {previous messages in this session}

User: {current question}
```

**Step 7 — Stream**: Use the Anthropic SDK streaming API (same pattern as existing `callClaude()` in `src/lib/ai.ts`). Parse citation markers from the response text and resolve them to full citation objects.

**Step 8 — Save**: After streaming completes, persist both the user message and the full assistant response (with parsed citations as JSON) to `chat_messages`.

### Token budget management

| Component            | Budget         | Notes                             |
| -------------------- | -------------- | --------------------------------- |
| System prompt        | ~500 tokens    | Fixed                             |
| Retrieved context    | ~80,000 tokens | Adaptive based on scope           |
| Conversation history | ~15,000 tokens | Sliding window, keep recent turns |
| Response             | ~4,000 tokens  | Max generation length             |

For conversations that grow long, use a sliding window: keep the first 2 messages (establishes topic) + the last 6-8 messages. Summarize dropped middle messages into a brief context note.

---

## UI Pages

### `/chat` — Session list + new chat

- List of past chat sessions (title, scope badge, last message preview, timestamp)
- "New chat" button → opens chat interface with empty session
- Search bar to find past conversations (FTS5 on message content)
- Scope selector shown when creating a new chat (defaults to "All")
- Quick-start buttons: "What have I been reading about?", "Find connections in my highlights", "Summarize my theses"

### `/chat/[id]` — Chat interface

- Standard chat layout: messages scrolling up, input at bottom
- Assistant messages render markdown (same pipeline as article content)
- Citations appear as inline chips: clicking opens the source in a side panel or navigates to it
- Each assistant message has a "..." menu with filing actions:
  - "Save as thesis" → opens a pre-filled thesis creation form
  - "Add to thesis" → dropdown of existing theses, saves as research entry
  - "Annotate highlight" → if the message discusses a specific highlight, adds the insight as a note
  - "Bookmark" → marks the message for later reference (just a flag, no separate table needed)
- Scope badge shown at top; clicking allows scope change
- Auto-generated session title after first exchange (LLM picks a short title from the content)

### Sidebar integration

- "Chat" item in sidebar navigation (below Theses, above Settings)
- Badge showing number of recent sessions (last 7 days)

### Thesis page integration

- "Chat about this thesis" button on `/theses/[id]` → creates a new session with `scope: thesis:{id}`

### Highlight library integration

- "Chat about this" action on highlight cards → creates a session with `scope: article:{articleId}` and pre-fills a question about the highlight text

### Daily review integration

- "Ask a question" button on review cards → opens chat scoped to the highlight's article

---

## Knowledge Linting

Run on-demand from a collapsible "Knowledge Health" panel above the session list on `/chat`. All four checks share one streaming endpoint that emits SSE `suggestion` events as findings appear, then a `done` event. A global empty-KB gate (≥3 articles, ≥5 highlights) emits a dedicated `empty` event before any check runs. All LLM calls use Haiku (`UTILITY_MODEL`) to keep cost and latency low.

The route is a thin orchestrator (`src/app/api/chat/lint/route.ts`) that dispatches on `check` to one of four async-generator helpers in `src/lib/lint/`. Each helper yields `Suggestion` objects with shape `{ type, description, relatedIds, suggestedAction? }`.

### Check types

**Connections** (`POST /api/chat/lint` with `check: 'connections'`) — `src/lib/lint/connections.ts`

Hybrid topic clustering followed by per-cluster Haiku validation:

1. Pull up to 500 unlinked highlights (`NOT IN (SELECT highlight_id FROM thesis_highlights)`) joined with their parent article's `aiIndex`
2. Parse the `TOPICS:`/`ENTITIES:` lines from each `aiIndex`, build a term → highlight inverted index, drop stop-topics (terms appearing in >30% of highlights, floored at the minimum cluster size)
3. Pick seed clusters of 3-10 highlights from ≥2 distinct articles, merge seeds whose highlight sets overlap ≥50%, cap at 20 clusters
4. For each cluster, one Haiku call validates coherence and proposes a thesis title
5. Quorum: needs ≥10 unlinked highlights from ≥3 distinct articles, otherwise yields one informational suggestion

**Contradictions** (`check: 'contradictions'`) — `src/lib/lint/contradictions.ts`

Two independent passes:

- **Pass A — note contradictions**: pull up to 60 highlights with non-empty user notes, send to Haiku in one call to detect contradicting note clusters
- **Pass B — supporting/opposing tensions**: self-join `thesis_highlights` to find pairs where the user has marked both `supporting` and `opposing` highlights for the same thesis, send up to 30 pairs to Haiku in one call to explain each tension in one sentence

**Gaps** (`check: 'gaps'`) — `src/lib/lint/gaps.ts`

For each thesis in `developing` or `researched` status (cap 30, ordered by `updatedAt DESC`), build a per-thesis dossier (claim, counterarguments, linked highlights grouped by role, research entries) and ask Haiku to identify ONE specific gap: missing counterargument, missing research, vague claim, or imbalanced evidence. Sequential per-thesis calls so suggestions stream progressively and one malformed response doesn't tank the run.

**Stale** (`check: 'stale'`) — `src/lib/lint/stale.ts`

Pure SQL — no LLM. Three category queries, each capped at 10 rows:

- Theses: `status != 'used' AND updatedAt < 30 days ago` (oldest first)
- Articles: `status = 'reading' AND updatedAt < 14 days ago`
- Highlights: `reviewInterval > 30 AND overdue` (mature memories slipping; uses the same date-math pattern as `src/lib/spaced-repetition.ts`)

### SSE event format

```
event: suggestion
data: { "type": "connection" | "contradiction" | "gap" | "stale",
        "description": string,
        "relatedIds": [{ "type": "article"|"highlight"|"thesis", "id": number }],
        "suggestedAction"?: string }

event: empty               (only when global quorum fails)
data: { "reason": string, "counts": { "articles": number, "highlights": number } }

event: done
data: { "totalSuggestions": number }
```

### Daily Review integration

Each review card has an "Explore" button that links to `/chat/new?scope=article:{articleId}&prefill=...`, opening a new chat scoped to the highlight's parent article with a question pre-filled about the passage. Highlight text is truncated to 300 chars to keep the URL safe.

---

## Edge Cases

1. **Empty knowledge base**: If the user has no articles/highlights, show an onboarding message explaining the feature works best with a reading history. Suggest saving some articles first.

2. **Very large context**: If scope is `all` and the user has thousands of highlights, FTS5 search is essential for narrowing. Never try to load everything. The token budget system ensures we stay within limits.

3. **Citation hallucination**: The LLM might fabricate a `[highlight:999]` that doesn't exist. The citation parser must validate all IDs against the DB and silently drop invalid ones. Include a note in the system prompt: "Only cite sources from the provided context. Never invent citations."

4. **Streaming failures**: If the Claude API stream fails mid-response, save what was received so far (with a `[truncated]` marker) and show an error to the user with a retry button.

5. **Scope changes mid-conversation**: When the user changes scope, insert a system message noting the context shift. Previous messages remain visible but new retrieval uses the updated scope.

6. **Filing conflicts**: If the user tries to "Save as thesis" with a title that already exists, show the existing thesis and offer to add as research instead.

7. **Long conversations**: After ~20 messages, the sliding window kicks in. The UI doesn't change (all messages remain visible), but the LLM context only includes recent turns + a summary of earlier ones.

8. **Concurrent sessions**: Multiple sessions can exist simultaneously. Each has independent scope and history. No cross-session state.

---

## Security Considerations

- **Input validation**: All message content validated with Zod (string, 1-5000 chars). Scope strings validated against a regex pattern.
- **No HTML in chat messages**: Messages stored and rendered as markdown only. No `dangerouslySetInnerHTML` for chat content — use a markdown renderer with sanitization.
- **Citation IDs validated**: All cited IDs checked against DB before being included in the response. Prevents the LLM from being tricked into referencing non-existent or unauthorized content (not relevant for single-user, but good practice).
- **Token budget enforcement**: Hard cap on context size prevents accidental API cost spikes.
- **API key**: Uses the same `anthropic_api_key` from Settings (already encrypted with AES-256-GCM).
- **Rate limiting**: Chat messages throttled to prevent accidental rapid-fire (e.g., max 1 request per 2 seconds per session).

---

## Implementation Order

### Phase 1: Core chat (MVP)

1. Schema migration: `chat_sessions`, `chat_messages`, `ai_index` column on `articles`, rebuild `articles_fts` to include `ai_index`
2. Article concept index: `POST /api/ai/index` route, index generation prompt, auto-trigger after article parsing, `POST /api/ai/index/backfill` for existing articles
3. Retrieval pipeline: FTS5 search (now including concept index) → context assembly → Claude streaming
4. API routes: `POST /api/chat`, `POST /api/chat/[id]`, `GET /api/chat`, `GET /api/chat/[id]`, `DELETE /api/chat/[id]`
5. Chat UI: `/chat` list page, `/chat/[id]` conversation page
6. Sidebar navigation item
7. Scope: `all` and `article:{id}` only

### Phase 2: Scoping + filing

7. Additional scopes: `thesis:{id}`, `tag:{name}`, `recent:{days}`
8. Filing actions API: `POST /api/chat/[id]/file`
9. Filing UI: action menu on assistant messages
10. Thesis/highlight page integration ("Chat about this" buttons)
11. Auto-title generation for sessions

### Phase 3: Knowledge linting (done)

12. Lint API: `POST /api/chat/lint` (SSE) — dispatches to four async-generator helpers in `src/lib/lint/`
13. Lint UI: collapsible "Knowledge Health" panel on `/chat` (`src/components/chat/knowledge-health-panel.tsx`)
14. Integration with daily review: "Explore" button on review cards links to a prefilled `/chat/new`
15. Pure types `LINT_CHECKS`, `LintCheck`, `LintSuggestion`, `LintRelatedRef` in `src/types/index.ts` shared between server, client, and the Zod validator

---

## Relation to Karpathy's Architecture

| Karpathy's component           | Reader equivalent                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `raw/` directory (source docs) | `articles` table (content_html, content_text)                                            |
| Obsidian Web Clipper           | Browser extension, RSS engine, Readwise import                                           |
| LLM compilation → wiki         | Thesis Tracker + **article concept index** (structured metadata from highlights and LLM) |
| Wiki `.md` files               | Theses + research entries + highlight notes                                              |
| Wiki index files               | **`ai_index` column** (concept inventory per article for FTS5 retrieval)                 |
| Q&A against wiki               | **Knowledge Chat (this module)**                                                         |
| Output filing back to wiki     | **Filing actions (this module)**                                                         |
| Linting / health checks        | **Knowledge linting (this module)**                                                      |
| Search (web UI + CLI)          | FTS5 search (existing, now enhanced with concept index)                                  |
| Obsidian IDE                   | Reader UI (existing)                                                                     |

The key architectural difference: Karpathy's wiki is a flat collection of markdown files maintained by the LLM. Your system has a richer relational structure (articles → highlights → theses → research) which gives the LLM _more_ to work with — it knows not just what you read, but what you found important (highlights), how you organized it (tags, theses), and what roles different evidence plays (supporting/opposing/context).

---

## Future Explorations (out of scope for initial build)

- **Embedding-based retrieval**: If the corpus grows past ~500 articles, add SQLite vector search as a third retrieval path alongside FTS5 and structured lookup
- **Multi-modal context**: Include article images in the chat context (Claude vision)
- **Export conversations**: Export a chat session as a markdown document for use in external tools
- **Scheduled linting**: Run knowledge health checks on a cron (weekly) and surface suggestions in the daily review
- **Fine-tuning**: Generate synthetic Q&A pairs from the knowledge base for potential model fine-tuning (Karpathy's "further explorations" idea)
