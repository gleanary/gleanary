# Module 4: Reader View

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `articles`, `highlights`
**Unimplemented sections**: none

## Purpose

Clean, distraction-free article reading experience. Renders parsed article HTML with optimized typography, provides reading progress tracking, status management, and inline text highlighting.

## Dependencies

- **Module 1 (Data Layer)**: `GET /api/articles/[id]` (fetch article), `PATCH /api/articles/[id]` (update progress/status)
- **Module 2 (Article Parser)**: Sanitized HTML stored in `content_html`

## Components

### 1. Reader Page (`src/app/reader/[id]/page.tsx`)

Server component. Fetches article by ID from DB directly (no API call needed in RSC). Renders the reader layout.

### 2. Article Reader (`src/components/reader/article-reader.tsx`)

Client component. Wraps the article content and handles:

- Reading progress tracking (scroll → percentage → debounced PATCH)
- Auto-mark as "reading" when page loads (if status is "inbox")
- Keyboard shortcut: Escape to navigate back

### 3. Reader Toolbar (`src/components/reader/reader-toolbar.tsx`)

Client component. Fixed toolbar at top with:

- Back button (← to library/inbox)
- Status badge (inbox/reading/read/archived)
- Mark as read button
- Archive button
- Favorite toggle (heart icon)
- TTS listen button (when TTS is enabled)
- `…` overflow dropdown:
  - Reset reading progress
  - Open original (hidden for articles with internal-scheme URLs such as `newsletter://`)
  - Delete document

### 4. Article Content (`src/components/reader/article-content.tsx`)

Server component. Renders sanitized HTML via `dangerouslySetInnerHTML`. Safe because content is sanitized via DOMPurify at ingestion time (article-parser module).

#### Math rendering

After mount, `ArticleContent` lazily imports `renderMath()` from `src/lib/math-render.ts` (KaTeX auto-render, kept out of the initial bundle) and calls `onReady` once the pass completes, whether or not any math was found. The library's `HighlightCard` uses the same helper on its off-screen scratch element (`output: 'html'`), so the reader and the cards can't drift apart.

- `$$…$$` and `\[…\]` render as display math, `\(…\)` as inline math.
- Single `$…$` follows Pandoc's `tex_math_dollars` rule: the opening `$` must be immediately followed by a non-space character; the closing `$` must be immediately preceded by a non-space character and not followed by a digit; the span cannot cross a newline or another `$` (so in "costs $5, and later $x$" the currency `$` can't pair with the math). Escaped `\$` and `$$` are never paired. Valid spans are rewritten to `\(…\)` before auto-render runs, and single `$` is not an auto-render delimiter.
- Why: auto-render pairs _any_ two dollars in a text node, so prose such as "$1,578 for workers … and $966" rendered as italic math with its spaces stripped. With the Pandoc rule, `$5 and $10`, `$5-$10` and `$ 5 $` stay text, while `$E=mc^2$`, `$2x+1$` and `$x_i$` still render.
- Text inside `code`, `pre`, `script`, `style`, `textarea`, `noscript` and `option` is never touched.

### 5. Article Header (`src/components/reader/article-header.tsx`)

Server component. Displays:

- Article title
- Author + site name
- Published date (formatted)
- Word count + estimated reading time

## Design Spec (from architecture.md)

- **Font**: `Georgia, Charter, 'Libre Baskerville', serif` for body text
- **Body text**: 18-20px, line-height 1.7
- **Max-width**: 680px, centered
- **Light mode**: warm off-white `#FAFAF7` background, dark text `#1A1A1A`
- **Dark mode**: deep gray `#1A1A1A` background, soft white `#E8E6E3` text
- **No pure white or pure black**

## API Usage

- `GET /api/articles/[id]` — Direct DB query in server component (RSC)
- `PATCH /api/articles/[id]` — Client-side calls for:
  - `{ status: 'reading' }` — on initial load (if inbox)
  - `{ readingProgress: 0.42, readingAnchorBlock: 12, readingAnchorOffset: 0.3 }` — debounced scroll tracking (and the keepalive save on unload)
  - `{ status: 'archived' }` — archive button (sole finish action; stamps `readAt` on first archive)
  - `{ isFavorite: true/false }` — favorite toggle

## Reading Progress Tracking

- Track scroll position as percentage (0–1)
- Debounce PATCH calls (every 5 seconds while scrolling)
- Persist on page unload via `navigator.sendBeacon` or `fetch` with keepalive

## Edge Cases

| Scenario                    | Behavior                                                 |
| --------------------------- | -------------------------------------------------------- |
| Article not found           | Show 404 page with back link                             |
| Article has no content_html | Show title + metadata, "No content available" message    |
| Very long article           | Progress bar works normally, no virtualization needed    |
| User navigates away         | Last progress saved via debounce or beforeunload         |
| Dark mode                   | Auto-switch via `prefers-color-scheme`, no toggle needed |

## Highlighting

### Components

- **Highlight Layer** (`src/components/reader/highlight-layer.tsx`) — Client component wrapping article content. Manages highlight state, renders `<mark>` elements from position data, handles creation/editing/deletion/merging.
- **Selection Handles** (`src/components/reader/selection-handles.tsx`) — Draggable handles at start/end of highlight in edit mode. Supports auto-scroll when dragging near viewport edges.
- **Highlight Popover** (`src/components/reader/highlight-popover.tsx`) — Shown during edit mode alongside selection handles. Positioned to the right of the highlight mark element, clamped to viewport. Allows editing a note or deleting the highlight.
- **Undo Toast** (`src/components/reader/undo-toast.tsx`) — Fixed-position toast at bottom-center for merge undo. Auto-dismisses after 5 seconds.

### Highlight Creation

Highlights are created **automatically on text selection**. The flow is:

1. User selects text in the article (mouseup on desktop, native selection on mobile)
2. A yellow highlight is created immediately (via `POST /api/highlights`)
3. The reader enters **edit mode** — selection handles and popover appear
4. User can adjust highlight boundaries by dragging handles
5. Click outside or press Escape to save changes (via `PATCH /api/highlights/[id]`)

**Double-click** (desktop) on a paragraph highlights the entire block with yellow, then enters edit mode.

**Double-tap** (mobile) on a paragraph selects the block text natively; the `selectionchange` handler auto-creates the highlight after a 400ms debounce.

**Clicking an existing highlight** enters edit mode for that highlight, allowing boundary adjustment.

**Note:** Only yellow highlighting is supported.

### Highlight Merging

When a user drags handles to extend a highlight so it overlaps with an adjacent highlight:

1. Overlap is detected using character offsets (strict inequality — touching does NOT merge)
2. The surviving highlight is PATCHed with the union range and combined notes (separator: `\n---\n`)
3. The absorbed highlight is DELETEd
4. An undo toast appears for 5 seconds
5. Clicking "Undo" re-creates the deleted highlight and restores the survivor's original state

### Anchoring Strategy

Highlights are anchored using child-index paths relative to the article content root:

```json
{
  "startContainerPath": [0, 0],
  "startOffset": 10,
  "endContainerPath": [0, 0],
  "endOffset": 19,
  "text": "brown fox"
}
```

- **Path**: Array of child node indices from root to the text node (e.g., `[0, 1, 0]` = root → 1st child → 2nd child → 1st child)
- **Offset**: Character offset within the text node
- **Text**: Stored for verification
- **Library**: `src/lib/highlight-anchoring.ts` — `serializeRange()`, `deserializeRange()`, `getNodePath()`, `getNodeFromPath()`

Article content is immutable after save, so child-index paths are stable.

### Additional Components (not in original spec)

- **`ReadingProgressBar`** (`src/components/reader/reading-progress-bar.tsx`) — Visual progress indicator at the top of the reader; exposed to assistive tech as `role="progressbar"` with `aria-valuenow` (0–100)
- **`ArchiveFooterButton`** (`src/components/reader/archive-footer-button.tsx`) — Archive/unarchive toggle at the bottom of the article
- **`ArticleStatusContext`** (`src/components/reader/article-status-context.tsx`) — React context provider for sharing article status across reader components

### API Usage

- `POST /api/highlights` — Create highlight with `positionData` JSON
- `PATCH /api/highlights/[id]` — Update `text`, `positionData` (boundary adjustment), or `note`
- `DELETE /api/highlights/[id]` — Delete highlight
- Client helpers in `src/lib/article-api.ts`: `createHighlight()`, `updateHighlight()`, `deleteHighlight()`

## Reading Progress

- Track scroll position as percentage (0–1)
- **Monotonic**: progress only increases, never decreases when scrolling back up (both client-side and server-side enforcement)
- Debounce PATCH calls (every 5 seconds while scrolling)
- Persist on page unload via `fetch` with `keepalive: true`
- **Content anchor**: each save also sends a `ReadingAnchor` (`src/lib/reading-anchor.ts`), captured when progress last advanced: the index of the first block element (`BLOCK_SELECTORS`, shared with the TTS word highlighter) in `.article-content` whose bottom is below the viewport top, plus the fraction (0–1) of that block scrolled past. Stored as `reading_anchor_block` / `reading_anchor_offset`; cleared by a reset to 0.
- **Restore**: on open, `ArticleReader` scrolls to the saved anchor (`anchorToScrollY`). It falls back to `readingProgress × scrollable height` for legacy articles without an anchor, when the anchored block no longer exists (content re-parsed or AI-cleaned), or when there is no `.article-content` (PDF original view). The ratio alone overshot because images without dimensions and async KaTeX had not laid out yet one frame after mount.
- **Restore window**: for up to 3 s after the first restore, a `ResizeObserver` on the content and `<html>` re-applies the same target whenever late layout (image loads, KaTeX) changes the size, so browsers without scroll anchoring (Safari) do not drift. The first `wheel`, `touchstart`, `keydown` or `pointerdown` ends the window, and so does a progress reset.
- The saved `readingProgress` stays rounded to whole percent and still drives the progress bar.

## Security

- `dangerouslySetInnerHTML` is used ONLY on `content_html` which is sanitized at ingestion via `sanitizeArticleHtml()` (DOMPurify). Every code path that stores HTML runs through sanitization first.
- External links in articles open in new tab with `rel="noopener noreferrer"` via CSS/component wrapper.
- Highlight `<mark>` elements are created via safe DOM APIs (`document.createElement`, `setAttribute`), not raw HTML insertion.
