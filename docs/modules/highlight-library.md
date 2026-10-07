# Module 5: Highlight Library

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `highlights`, `articles`, `tags`, `highlight_tags`
**Unimplemented sections**: none

## Purpose

Browse, search, filter, and manage all highlights across all sources. Provides a dedicated `/library` page where users can view highlights with article context, filter by multiple dimensions, perform bulk operations, and manage tags.

## Dependencies

- Module 1 (Data Layer + API) — highlights, tags, highlightTags CRUD, FTS5 search
- Module 4 (Reader View) — highlight color scheme, article rendering

## Architecture Overview

### Backend Enhancements

The existing highlights API (GET/POST/PATCH/DELETE) and tags API (GET/POST) handle single-item CRUD. Module 5 adds:

1. **Enhanced GET /api/highlights** — return article context (title, URL) and tags with each highlight
2. **POST /api/highlights/bulk-delete** — delete multiple highlights by ID array
3. **POST /api/highlights/bulk-tag** — add/replace tags on multiple highlights
4. **DELETE /api/tags/[id]** — delete a tag (with cascade on highlight_tags)
5. **PATCH /api/tags/[id]** — update tag name/color

### Frontend

Server component page at `/library` with client-side interactivity for filtering, selection, and bulk actions.

## API Contracts

### Enhanced GET /api/highlights

Add query params:

- `sourceId` (number, optional) — filter by article's source
- `dateFrom` (ISO date string, optional) — highlights created on or after
- `dateTo` (ISO date string, optional) — highlights created on or before

Response shape change — each highlight now includes article context and tags:

```typescript
interface HighlightWithContext {
  id: number;
  articleId: number;
  text: string;
  note: string | null;
  color: HighlightColor;
  createdAt: string;
  updatedAt: string;
  article: {
    title: string;
    url: string;
    siteName: string | null;
  };
  tags: Array<{ id: number; name: string; color: string | null }>;
}

// Response
{ highlights: HighlightWithContext[], total: number }
```

### POST /api/highlights/bulk-delete

```typescript
// Request
{ ids: number[] }  // 1-100 highlight IDs

// Response 200
{ deleted: number }  // count of actually deleted highlights
```

### POST /api/highlights/bulk-tag

```typescript
// Request
{
  ids: number[];           // 1-100 highlight IDs
  tagIds: number[];        // tag IDs to apply
  mode: 'add' | 'replace'; // add = merge, replace = overwrite
}

// Response 200
{ updated: number }
```

### DELETE /api/tags/[id]

```typescript
// Response 200
{
  deleted: true;
}

// Response 404
{
  error: 'Tag with id X not found';
}
```

### PATCH /api/tags/[id]

```typescript
// Request
{ name?: string; color?: string }  // at least one field

// Response 200
{ tag: Tag }

// Response 409 (duplicate name)
{ error: "Tag with this name already exists" }
```

## Validation Schemas

```typescript
// Enhanced list highlights
listHighlightsSchema — add:
  sourceId: z.coerce.number().int().positive().optional()
  dateFrom: z.string().datetime({ offset: true }).or(z.string().date()).optional()
  dateTo: z.string().datetime({ offset: true }).or(z.string().date()).optional()

// Bulk delete
bulkDeleteHighlightsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
})

// Bulk tag
bulkTagHighlightsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
  tagIds: z.array(z.number().int().positive()).min(0),
  mode: z.enum(['add', 'replace']).default('add'),
})

// Update tag
updateTagSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
}).refine(data => Object.values(data).some(v => v !== undefined))
```

## Frontend Components

### Page: `/library`

Server component that fetches initial highlights and tags, renders the library shell.

### Components

1. **`HighlightCard`** — displays a single highlight with:
   - Colored left border (matching highlight color)
   - Highlight text (truncated with expand)
   - Note (if present, shown below in muted text)
   - Source article title + site name (linked to reader view)
   - Tags as badges
   - Checkbox for bulk selection

   **Highlight text escaping:** `highlight.text` is stored unsanitized (Readwise import copies
   `doc.content` verbatim; `POST /api/highlights` validates with `z.string().min(1)` only), so the
   card renders it as **plain React text on first paint** — never `dangerouslySetInnerHTML`. The
   card injects HTML only after the async KaTeX pass resolves, and that HTML is derived from a
   `textContent`-escaped scratch element, so raw text is already HTML-escaped before any math
   markup is added. This prevents stored XSS from a malicious highlight body. The
   truncated and expanded states both go through the same escaped render. The separate `snippet`
   prop (search results) is server-escaped `<mark>` HTML and is out of scope here.

2. **`LibraryFilters`** — filter bar with:
   - Color filter (toggle buttons — currently yellow only; future: green/blue/pink)
   - Tag filter (dropdown/multi-select from available tags)
   - Date range (from/to date inputs)
   - Sort by: created date, article title
   - Clear filters button

3. **`BulkActions`** — appears when highlights are selected:
   - Tag selected (opens tag picker)
   - Delete selected (with confirmation)
   - Deselect all

4. **`TagManager`** — inline tag management:
   - List of tags with highlight counts
   - Create new tag
   - Edit tag (name, color)
   - Delete tag (with confirmation)

## Edge Cases

- Bulk delete with IDs that don't exist: silently skip, return count of actually deleted
- Bulk tag with nonexistent tag IDs: return 404 for invalid tags
- Date range: `dateFrom` > `dateTo` returns empty results (no error)
- Empty highlight library: show helpful empty state message
- Tag deletion: cascade removes highlight_tags rows, doesn't delete highlights
- Duplicate tag links: `highlight_tags` has a UNIQUE index on (highlight_id, tag_id) (migration 0021); tag writers dedupe repeated tag ids in a request rather than erroring

## Test Plan

### Integration Tests

1. **GET /api/highlights with context** — verify article title/url/siteName and tags in response
2. **GET /api/highlights with sourceId filter** — create articles with different sources, verify filter
3. **GET /api/highlights with date range** — create highlights at different times, verify dateFrom/dateTo
4. **POST /api/highlights/bulk-delete** — delete multiple, verify count, verify nonexistent IDs skipped
5. **POST /api/highlights/bulk-tag (add mode)** — verify tags are merged (not replaced)
6. **POST /api/highlights/bulk-tag (replace mode)** — verify tags are fully replaced
7. **POST /api/highlights/bulk-tag validation** — empty ids, too many ids, invalid mode
8. **DELETE /api/tags/[id]** — delete tag, verify highlight_tags cascade
9. **DELETE /api/tags/[id] 404** — nonexistent tag
10. **PATCH /api/tags/[id]** — update name, color, both
11. **PATCH /api/tags/[id] 409** — duplicate name
12. **PATCH /api/tags/[id] 422** — empty body

### Unit Tests

1. **Date filtering logic** — validate date comparison edge cases
2. **Bulk operation size limits** — validate max 100 IDs
