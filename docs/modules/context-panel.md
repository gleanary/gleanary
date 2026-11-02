# Module: Context Panel

**Status**: Not started
**Last verified against code**: 2026-11-02 (spec revision 3, checked against `main` @ `d59f809`)
**Schema tables**: `articles`, `sources` (reads only — no schema change); `tags` is no longer written by `POST /api/ai/tag`
**Unimplemented sections**: full module

---

## 1. Purpose

A right-hand panel that shows information about the thing the current page is about. The left sidebar is for moving between pages. This panel is for context about the page you're on.

v1 ships on the reader view only (`/reader/[id]`). It shows the article's descriptive metadata, AI summary and AI tags. The shell supports tabs and is built from widgets from day one, so v2 can add more without rewrites: cross-references, the article's own highlights, panels on thesis, draft and chat pages, and inline edit.

**What it fixes**: `aiSummary` and `aiTags` are stored by `POST /api/ai/summarize` and `POST /api/ai/tag`, but **no UI displays or triggers them today**. The panel gives that data its first home.

---

## 2. Design decisions

- **One shell, page-specific composition.** A single `<ContextPanel>` is rendered by `AppShell`. Each page registers its own tabs and widgets. The shell owns open/close, layout, the mobile sheet and tab rendering.
- **Data is shaped as tabs; the tab bar appears only when needed.** Content is always `tabs: [{ id, label, sections }]`. When `tabs.length === 1`, the tab bar is hidden and sections render directly under their labels.
- **Two presentations, chosen by viewport width:**
  - **Desktop (≥ `md`, 768px): side sheet.** Slides in from the right and **pushes** the content, exactly like the left sidebar (`fixed` panel + content wrapper `margin-right`). It is not modal, so the article stays fully interactive. There is no slide-over mode.
  - **Mobile (< `md`): bottom sheet.** Slides up from the bottom and is **modal**: a backdrop blocks the rest of the app until it closes. It closes on a downward swipe, the X button, a backdrop tap, or Escape.
- **Presentation is chosen by viewport width, not pointer type.** `matchMedia('(min-width: 768px)')` matches the left sidebar's `md:` backdrop breakpoint. A landscape iPad gets the side sheet. `isMobileDevice` (coarse pointer) is _not_ used for this choice.
- **Only one side panel is open at a time.** On desktop, opening the context panel closes the left sidebar, and opening the left sidebar closes the context panel. Every way of opening the sidebar does this: the hamburger, `Cmd/Ctrl+\`, the left-edge swipe and the sidebar's own toggle. The reader column always has `viewport − 320px` (or `viewport − 280px`) to work with, never both.
- **The close is real, not a temporary hide.** Opening the right panel calls the sidebar's `close()`, which persists `sidebar-open=false` in localStorage as usual. Closing the right panel does **not** reopen the left one; the user reopens it if they want it. This keeps the rule simple and avoids a "remembered" state that would surprise after navigation.
- **Open state lives in memory and lasts for the session.** It sits in a React context at the `AppShell` level, so it survives client-side navigation between articles and resets to closed on a full reload. No localStorage. This deliberately differs from the left sidebar, which persists `sidebar-open` in localStorage across reloads.
- **Mobile always starts closed.** The session flag applies to the desktop side sheet only. On mobile, navigating to another article never re-opens the modal sheet.
- **The header loses its metadata.** `ArticleHeader` keeps only the H1. The byline (author · site) and the meta row (date · words · reading time) move to the panel. With the panel closed by default, reading is distraction-free and metadata is one click away. This is an accepted trade-off.
- **The trigger goes in the reader toolbar.** It sits immediately to the right of the `…` menu, as the last item of `ReaderToolbar`.
- **Widgets are read-only in v1, with one exception.** The summary and tags sections have a **Generate** action when empty. No `editable` / `onSave` / `onClick` props in v1. They are added with v2's inline edit.
- **Primitives are narrow.** `<Field>` takes single values only. `<TextBlock>` handles multi-line text and `<TagList>` handles tag arrays.
- **Colors follow the app chrome, not the reader.** The panel uses the left sidebar's token family (`bg-sidebar`, `text-sidebar-foreground`, `border-sidebar-border`), not `--reader-bg` / `--reader-text`. These tokens already follow the Appearance setting (`.dark` class via `THEME_BOOTSTRAP_SCRIPT`), so the panel needs no theme logic.

---

## 3. Schema changes

None.

---

## 4. API contract

No new routes. The Generate actions call existing endpoints. **`POST /api/ai/tag` changes** (see §4.1).

| Action           | Route                    | Body            | Response                                 |
| ---------------- | ------------------------ | --------------- | ---------------------------------------- |
| Generate summary | `POST /api/ai/summarize` | `{ articleId }` | `{ summary: string, cached: boolean }`   |
| Generate tags    | `POST /api/ai/tag`       | `{ articleId }` | `{ tags: string[] }` (**changed**, §4.1) |

Both return **422** (`ValidationError`) when the article has no content to analyze, **404** for an unknown article, and **503** when the AI provider fails. The panel shows the error message inline under the section with a Retry button.

### 4.1 `POST /api/ai/tag`: article tags stay out of the highlight tag list

**Decision**: article AI tags are a separate vocabulary from highlight tags. Today the route inserts any new suggested name into the `tags` table, which feeds the highlight tag picker (`highlight_tags`). That stops.

**New behavior**

1. Validate the input (unchanged) and load the article (404 if missing).
2. **Vocabulary hint**: the distinct tag names already present in other articles' `ai_tags` (JSON arrays, parsed with `parseAiTags`, de-duplicated case-insensitively). These are sent to the model as "Existing tags", replacing the highlight `tags` table. This keeps article tags consistent with each other without touching highlight tags.
3. Call the model with `AUTO_TAG_PROMPT` (unchanged), and parse the reply with `parseTagsResponse` (unchanged).
4. **Normalize** each suggestion to the existing spelling when it case-insensitively matches a name from step 2.
5. Write `articles.ai_tags = JSON.stringify(names)`. **No insert into, and no read from, the `tags` table.**
6. Respond `200 { tags: string[] }`. The `created` field and the `{id, name, color}` objects are removed. This is a breaking change with no aliases. Nothing in the UI calls the route today, so only tests and docs are affected.

**Existing data**: tags this route already inserted into `tags` stay where they are. They can't be told apart from tags you created on highlights, so no clean-up migration. Delete any you don't want from the highlight library.

**Files touched**

- `src/app/api/ai/tag/route.ts`
- `src/types/index.ts`: `AutoTagResponse`
- `__tests__/integration/ai.test.ts`:
  - Replace "reuses existing tags when matching" with "reuses existing article tag spellings".
  - Add "does not insert into the tags table".
  - Drop the `created` assertions.
- `docs/modules/ai-features.md`: update the `POST /api/ai/tag` response and behavior section.

---

## 5. Component contract

### 5.1 State — `ContextPanelProvider` (`src/components/layout/context-panel-context.tsx`)

Mounted inside `AppShell`, next to `SidebarProvider`.

```ts
interface ContextPanelContextValue {
  /** Desktop session flag. In-memory; resets on full reload. */
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** 'side' (≥ md) or 'bottom' (< md); derived from matchMedia, never stored. */
  presentation: 'side' | 'bottom';
  /** Tabs registered by the current page; null = page has no context panel. */
  content: ContextPanelTab[] | null;
  setContent: (tabs: ContextPanelTab[] | null) => void;
}
```

- The mobile sheet uses its own `isSheetOpen` state. That state resets to `false` when the route changes. The desktop `isOpen` flag is unaffected.
- `presentation` uses `useSyncExternalStore` over `matchMedia`. The server snapshot is `'side'` with `isOpen = false`, so nothing renders on the server and there is no hydration mismatch.
- If the viewport crosses `md` while the panel is open, the panel **closes** (both flags). A layout change should never pop up a modal.

### 5.2 Content registration — `useContextPanelContent(tabs)`

Pages call this hook. It registers content on mount and clears it on unmount. When `content` is null, the trigger is hidden and the panel is not rendered.

```ts
interface ContextPanelTab {
  id: string;
  label: string;
  sections: ContextPanelSection[];
}

interface ContextPanelSection {
  id: string;
  label: string;
  content: ReactNode;
}
```

### 5.3 `<ContextPanel>` (`src/components/layout/context-panel.tsx`)

Rendered once by `AppShell`. It renders one of two presentations.

**Side sheet (desktop)**

- `<aside>`: `fixed inset-y-0 right-0 z-40`, width `CONTEXT_PANEL_WIDTH = 320`, `border-l`, chrome tokens. Slides with `translate-x` over `duration-250 ease-out`, the same as the sidebar.
- `AppShell`'s content wrapper adds `marginRight: CONTEXT_PANEL_WIDTH` when open and `presentation === 'side'`. The transition becomes `transition-[margin-left,margin-right]`.
- Header row: tab label (or "Details") and an X close button. The body scrolls on its own (`overflow-y-auto`).
- Not modal: no backdrop, no focus trap. When the panel opens via the keyboard, focus moves to the panel's close button. When it closes, focus returns to the trigger.

**Bottom sheet (mobile)**

- Built on the existing Radix `Dialog` primitive (`radix-ui`, already a dependency). That gives focus trap, Escape, backdrop-click and `aria-modal` for free. **No new dependency** (no `vaul`).
- Sheet: `fixed inset-x-0 bottom-0`, `max-h-[85dvh]`, rounded top corners, a grab handle at the top, an X button in the header, and a scrollable body. Padding includes `env(safe-area-inset-bottom)`.
- **Swipe to dismiss** uses pointer events on the handle and header. It also works on the body when the body's `scrollTop === 0` and the drag is downward. The sheet follows the finger (`translateY`). On release it closes if the drag is > 25% of the sheet height or the velocity is > 0.5 px/ms; otherwise it springs back.
- z-index: **above everything in the reader** (`z-[80]` for backdrop and sheet). It must sit above the highlight popover (`z-[70]`), the progress bar (`z-50`), the undo toast (`z-50`) and the TTS player (`z-20`).
- While the sheet is open, `AppShell`'s left-edge swipe gesture is ignored, so the sidebar can't open under a modal.

**Tabs**: render a tab bar only when `tabs.length > 1`. Otherwise render sections in order, each under a small uppercase label.

### 5.4 `<ContextPanelTrigger>` (`src/components/layout/context-panel-trigger.tsx`)

- A `TopBarButton` with the lucide `PanelRight` icon, mirroring `PanelLeft` on the left.
- `aria-label="Toggle details panel"`, `aria-expanded`, `aria-controls`. Shows the active state (`bg-secondary text-foreground`) while open.
- Tooltip: "Details (⌘⇧\\)" on Mac, "Details (Ctrl+Shift+\\)" elsewhere.
- On desktop it toggles `isOpen`. On mobile it opens the sheet.
- Hidden when `content === null`.

### 5.5 Widget primitives (`src/components/context-panel/`)

```ts
// Single values — author, site, source, dates, length
interface FieldProps {
  label: string;
  value: ReactNode | null; // null/'' → em-dash
}

// Multi-line plain text — AI summary
interface TextBlockProps {
  value: string | null;
  emptyState?: ReactNode; // rendered when value is null/empty
}

// Tag array — AI tags
interface TagListProps {
  tags: string[];
  emptyState?: ReactNode;
}
```

`<TextBlock>` renders **plain text** through React (auto-escaped), with `whitespace-pre-line`. `SUMMARIZE_PROMPT` asks for plain sentences, so v1 needs no HTML path. **Rule**: if summaries are ever rendered as markdown or HTML, they must go through `renderMarkdown()` → `sanitizeArticleHtml()` (DOMPurify) before `dangerouslySetInnerHTML`. Never inject raw model output as HTML.

### 5.6 `<GenerateAction>` (`src/components/context-panel/generate-action.tsx`)

The empty state for the summary and tags sections.

- Idle: a short muted hint and a "Generate" `Button` (`variant="outline" size="sm"`, `Sparkles` icon).
- Pending: button disabled with a spinner and the label "Generating…". Navigating away during the request leaves the server work running; the result is cached on the article.
- Success: the parent updates the article through `ArticleContext.updateArticle({ aiSummary })` / `({ aiTags })`. The section re-renders with the content. No full page refresh.
- Error: the error message inline in `text-destructive` with a Retry button.
- Unavailable: if no Anthropic key is configured (`!getConfig('anthropic_api_key')`, passed from the server page as `aiAvailable`), show the hint "Add an Anthropic API key in Settings to generate" linking to `/settings`. No button.

---

## 6. v1 widget catalog (reader page)

`src/components/reader/reader-context-panel.tsx` composes one tab, **Details**:

1. **About**: one `<Field>` row per item:
   - **Author**: `article.author`
   - **Site**: `article.siteName`
   - **Source**: `source.name`, shown only when `article.sourceId` is set. Covers RSS feed and newsletter names.
   - **Published**: `formatDate(article.publishedAt)`
   - **Saved**: `formatDate(article.savedAt)`
   - **Read**: `formatDate(article.readAt)`, shown only when set (stamped on first archive)
   - **Length**:
     - Web and newsletter articles: `"{wordCount} words · {readingTime(wordCount)}"`
     - PDFs (`pageCount` set): `readingTime(wordCount, pageCount)` → `"42 pages"`
     - `readingTime()` already exists in `src/lib/text-utils.ts` (238 WPM, `max(1, round(words/238))`). Reuse it. Don't recompute.
2. **Summary**: `<TextBlock value={article.aiSummary} emptyState={<GenerateAction kind="summary" />} />`
3. **Tags**: `<TagList tags={parseAiTags(article.aiTags)} emptyState={<GenerateAction kind="tags" />} />`
   - `parseAiTags(raw: string | null): string[]` goes in `src/lib/text-utils.ts`. It does `JSON.parse` in a try/catch, validates with `z.array(z.string())`, and returns `[]` (plus a logged warning) on malformed input.

**Data plumbing**: `ReaderPage` already loads `source`. It passes `sourceName` and `aiAvailable` down. `ArticleContext` already holds the full article row (including `aiSummary`, `aiTags`, `savedAt`, `readAt`), so no new query is needed.

**Header change**: `ArticleHeader` renders the H1 only. Remove the `article-byline` and `article-meta` blocks. Update the E2E assertions in `e2e/save-and-read.spec.ts` and `e2e/pdf-import.spec.ts` to open the panel and assert on the panel fields instead.

---

## 7. Layout and keeping your place

### 7.1 Push layout (desktop)

The content wrapper in `AppShell` gets `margin-left` (sidebar) and `margin-right` (panel). The reader column keeps `max-w-[680px] mx-auto`, so it is centered in whatever space remains and narrows below 680px when it has to.

Since only one side panel is open at a time, the content width is `viewport − 320` when the context panel is open:

- 1440px → 1120px
- 1024px → 704px
- 768px → 448px (the narrowest desktop case, still a usable column)

### 7.2 Keeping the current paragraph anchored

Opening or closing the side sheet changes the column width. Text reflows, the page height changes, and without correction the reader loses their place. Correct it this way:

1. **Before** the toggle, capture an anchor for the top of the viewport:
   - HTML articles (`.article-content` present): `computeReadingAnchor(container, window.scrollY)` from `src/lib/reading-anchor.ts`. This is the same helper reading-progress restore already uses.
   - PDFs: `{ page, offset }`, where `page` is the page element under the viewport top and `offset` is the fraction into its height.
2. **During** the 250ms transition, re-apply the anchor on each `ResizeObserver` callback (the same pattern as the restore window in `ArticleReader`).
3. **After** `transitionend`, re-apply once more, then stop observing. Cancel early if the user scrolls, wheels or touches (the same `RESTORE_CANCEL_EVENTS`).

Two related protections:

- **Reading progress must ignore reflow.** Closing the panel widens the column and shortens the page, which can push the scroll _ratio_ up without the user reading anything. `ArticleReader`'s scroll handler must skip progress updates while a panel transition is in flight. Expose `isTransitioning` from the context, or reuse the `isResettingProgress` guard pattern.
- **TTS auto-scroll.** While TTS is playing, it owns the scroll position. Skip the anchor restore.

The mobile bottom sheet overlays the content and never changes layout, so no anchoring is needed there.

### 7.3 PDF and newsletter-original views (item 8, now resolved)

These two views don't render as a fluid 680px text column, so a width change affects them differently:

- **PDF (`PdfViewer`)** measures its container with an **undebounced** `ResizeObserver` and passes `width` to every rendered `<Page>`. During the 250ms push animation the width changes every frame, which re-renders every visible page canvas around 15 times. Fix: **debounce `setContainerWidth` by 150ms** (trailing). The PDF then re-renders once, after the panel settles, and the §7.2 page anchor restores the position. The skeleton heights (`width × 1.414`) follow the new width.
- **Newsletter original view** renders the raw email HTML, which is often a fixed 600px table. If the column narrows below that, the email overflows horizontally. Fix: give the original-view container `overflow-x: auto` (the same treatment `globals.css` already gives tables and `pre`). The email scrolls inside its own box instead of breaking the page.

Both are covered in Session 1. The panel itself is the same in every view.

---

## 8. Keyboard

| Shortcut                          | Action                                                 |
| --------------------------------- | ------------------------------------------------------ |
| `Cmd/Ctrl+Shift+\`                | Toggle the context panel (or open the sheet on mobile) |
| `Escape` (focus inside the panel) | Close the panel and return focus to the trigger        |

- The shortcut mirrors the left sidebar's `Cmd/Ctrl+\`, with Shift for the other side. Match on **`e.code === 'Backslash'`**, not `e.key`, because Shift turns `e.key` into `|` on QWERTY. No browser binds this combination.
- It is handled in `AppShell`'s existing keydown listener and ignored when `content === null`.
- **Escape conflict**: `ArticleReader` binds Escape to `router.back()`. The panel's Escape handler runs in the **capture** phase and calls `preventDefault()`. `ArticleReader`'s handler must return early when `e.defaultPrevented`. Without this, closing the panel also navigates away.
- **Escape scope**: the panel's Escape handler closes the desktop panel only when focus is inside it. Escape from the article keeps its current meaning (back). On mobile, Radix Dialog owns Escape.
- **AZERTY note**: on French layouts `\` sits on AltGr/Option combinations, so both the existing left shortcut and this one are awkward there. Out of scope for v1 (it affects both panels). Tracked in §11.

---

## 9. Edge cases

- **Null metadata**: `<Field>` renders the label with an em-dash. "Read" and "Source" are skipped rather than dashed when they don't apply.
- **Malformed `aiTags`**: `parseAiTags` returns `[]`. The Tags section shows its Generate empty state.
- **Article with no extractable content** (e.g. a scanned PDF before OCR): Generate returns 422. Show the message inline with a Retry button.
- **Double-click on Generate**: disable the button while the request is pending. The summarize route is idempotent anyway (it returns the cached value).
- **Navigating between articles with the panel open (desktop)**: it stays open, and the new page's `setContent` replaces the tabs. Pending Generate requests from the previous article must not write into the new article's context. Check `articleId` before calling `updateArticle`.
- **Viewport crosses `md` while open**: the panel closes (§5.1).
- **Mutual exclusion and reload**: after a reload, the right panel starts closed (in-memory) and the left sidebar comes back from localStorage. If the right panel was open before the reload, the sidebar was persisted closed, so the user sees neither panel. That is expected.
- **Mobile**: the sheet is modal, so the left sidebar can't be opened while it is up. Opening the sheet while the mobile sidebar overlay is open closes the sidebar first.
- **Shortcut spam**: pressing `Cmd/Ctrl+\` then `Cmd/Ctrl+Shift+\` quickly swaps panels. Each transition re-applies the §7.2 anchor, and a newer transition cancels the previous restore.
- **Mobile sheet + highlight edit mode**: opening the sheet exits highlight edit mode (saving, as click-outside already does), so the popover and drag handles don't linger under the backdrop.
- **Mobile sheet + body scroll**: lock background scroll while the sheet is open (Radix `Dialog` does this).
- **Pages without a panel**: the trigger is hidden, the shortcut does nothing, and the content wrapper has no right margin, even if `isOpen` is still true from an earlier reader visit.
- **Reduced motion**: under `prefers-reduced-motion`, the slide and sheet transitions drop to opacity only, and the swipe-to-dismiss follow is kept.

---

## 10. Build plan

Three `module-build` sessions, all Sonnet.

### Session 1: Shell, desktop side sheet, place-keeping (Sonnet, high effort)

**Files**

- `src/types/index.ts`: `ContextPanelTab`, `ContextPanelSection`
- `src/components/layout/context-panel-context.tsx`: provider, `useContextPanel`, `useContextPanelContent`
- `src/components/layout/context-panel.tsx`: side-sheet presentation and tab rendering
- `src/components/layout/context-panel-trigger.tsx`
- `src/components/layout/app-shell.tsx`: provider, right margin, `Cmd/Ctrl+Shift+\`, swipe suppression hook point, mutual exclusion (opening either panel closes the other)
- `src/components/layout/sidebar-context.tsx`: expose an `onOpen` hook (or let the shell wrap `open`/`toggle`) so every sidebar entry point closes the context panel
- `src/components/reader/article-reader.tsx`: `defaultPrevented` Escape guard, progress-tracking pause during transitions
- `src/lib/panel-anchor.ts`: capture/restore around transitions (HTML via `reading-anchor.ts`, PDF by page)
- `src/components/reader/pdf-viewer.tsx`: debounce the width update
- Newsletter original view container: `overflow-x: auto`
- Reader toolbar: trigger after the `…` menu, with a placeholder tab

**Acceptance**

- The trigger toggles the panel, and so does the shortcut.
- Content pushes. Opening the context panel closes the left sidebar, and every way of opening the sidebar (hamburger, `Cmd/Ctrl+\`, swipe, its own toggle) closes the context panel.
- The state survives client navigation between two articles and resets on reload.
- The paragraph at the top of the viewport stays put (±1 line) when toggling mid-article, for HTML and PDF.
- Toggling never advances `readingProgress`.
- Escape inside the panel closes it without navigating back.

### Session 2: Mobile bottom sheet (Sonnet, high effort)

**Files**

- `src/components/layout/context-panel.tsx`: bottom-sheet presentation (Radix Dialog)
- `src/hooks/use-sheet-drag.ts`: pointer-driven drag and dismiss thresholds

**Acceptance**

- Below 768px, the trigger opens a modal sheet.
- The X button, a backdrop tap and a downward swipe each close it.
- A swipe inside a scrolled body scrolls instead of dismissing.
- The sheet sits above the highlight popover and the TTS player.
- The left-edge swipe is inert while the sheet is open.
- The sheet is closed after navigating to another article.
- Crossing 768px while open closes the panel.

### Session 3: Widgets, reader composition, Generate, header slimming (Sonnet, medium effort)

**Files**

- `src/components/context-panel/field.tsx`, `text-block.tsx`, `tag-list.tsx`, `generate-action.tsx`
- `src/components/reader/reader-context-panel.tsx`
- `src/lib/text-utils.ts`: `parseAiTags`
- `src/app/reader/[id]/page.tsx`: pass `sourceName` and `aiAvailable`
- `src/app/api/ai/tag/route.ts`, `src/types/index.ts`, `__tests__/integration/ai.test.ts`: the §4.1 route change (write the integration tests first)
- `src/components/reader/article-header.tsx`: H1 only

**Tests**

- Unit: `parseAiTags`; null/empty states for each primitive; `GenerateAction` idle / pending / error / unavailable.
- E2E:
  - Open the panel and verify the fields for a web article and for a PDF ("N pages").
  - Generate a summary with the AI mock (MSW) and see it render without a reload.
  - Navigate to another article: the panel is still open.
  - Hard refresh: the panel is closed.
  - Mobile viewport: the sheet opens and swipe-dismisses.
- Update `e2e/save-and-read.spec.ts` and `e2e/pdf-import.spec.ts` for the removed header metadata.

**Docs**

- `CHANGELOG.md`
- `CLAUDE.md` Module Registry: add row 22, Context Panel. Also fix the stale "Sidebar collapses to icon while reading" line: the sidebar is either 280px or hidden.
- `docs/modules/reader-view.md`: the header now carries the H1 only.
- `docs/modules/ai-features.md`: `POST /api/ai/tag` response and behavior (§4.1).

---

## 11. Open questions

1. **Keyboard on AZERTY.** Revisit both panel shortcuts together, for example by adding a layout-independent alternative.

### Resolved in revision 3

- Narrow desktop with both panels open: **only one side panel at a time** (§2, §7.1).
- Article AI tags vs highlight tags: **separate vocabularies**; the route no longer writes `tags` (§4.1).

---

## 12. Out of scope for v1

- The panel on inbox, library, theses, thesis detail, chat, drafts, settings
- Tab bar UI (appears automatically when v2 adds a second tab)
- Inline edit; `editable` / `onSave` / `onClick` props (v2)
- Cross-references (theses linked to this article's highlights), the highlights mini-list, related articles
- Regenerating an existing summary or tags (v1 only fills empty ones)
- Hero image (if introduced, it goes in the article body)
- The global header refactor that would unify the left and right triggers
