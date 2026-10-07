# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- **Public-release prep**: repo URLs point at `gleanary/gleanary`; references to private issue/PR numbers removed from docs, skills, the changelog, CI config and code comments; personal-tooling (RTK) mentions dropped; new `docs/ai-first-development.md` explains the AI-first development setup, linked from the README. Two gitleaks false positives (a test dummy key, a placeholder `curl -u` example) are annotated `gitleaks:allow`.

- **Infra: dropped the unused `ovh/ovh` provider** and its `ovh_application_key` / `ovh_application_secret` / `ovh_consumer_key` variables; every resource is OpenStack-managed, so OVH API credentials are no longer needed.
- **Infra: `tofu plan` no longer replaces the server** — `lifecycle.ignore_changes` on the keypair and instance stops pre-rename names, the unresolvable image name, and `user_data` drift from forcing a destroy/recreate that would wipe the SQLite DB.
- **Migrated shadcn UI primitives to per-primitive subpath imports** — the nine shadcn UI components in `src/components/ui/` now import from `radix-ui/<primitive>` instead of the `radix-ui` umbrella. Pattern A (7 files: popover, tooltip, dialog, separator, checkbox, dropdown-menu, select) switched `import { X as XPrimitive } from 'radix-ui'` to `import * as XPrimitive from 'radix-ui/<kebab-primitive>'`. Pattern B (button, badge) switched `import { Slot } from 'radix-ui'` to `import * as Slot from 'radix-ui/slot'` (usage stays Slot.Root). Subpaths resolve via radix-ui 1.6.4's `./*` export map under tsconfig `moduleResolution: bundler`. Exactly one import line changed per file; all call sites and public exports are byte-identical.
- **KaTeX bumped to 0.18.1** — 0.18's breaking change prefixed only KaTeX's previously-unprefixed internal classes (`base`->`katex-base`, etc.); the classes the reader depends on (`katex`, `katex-mathml`, `katex-html`, `katex-display`, `katex-error`) and the `annotation[encoding="application/x-tex"]` element are unchanged, so no selectors in `highlight-anchoring.ts`, `article-content.tsx`, or `globals.css` moved. Added unit tests that pin this class-name contract against real KaTeX output, an `e2e/math-article.spec.ts` covering inline + display rendering and a highlight spanning a display-math block surviving reload, and a "KaTeX class dependency" note to the highlight-anchoring spec so future bumps re-verify the load-bearing names.

### Fixed

- **A highlight spanning a display-math block could be permanently orphaned on reload** — `HighlightLayer`'s mount effect resolves stored anchors against `contentRef.current.textContent` synchronously, before `ArticleContent`'s async KaTeX import/render has run; on a fresh page load the content still contains the raw `$...$`/`$$...$$` delimiters, so a v2 anchor captured against the _rendered_ math text fails to fuzzy-match and got persisted as `orphaned` before KaTeX ever got a chance to finish. `ArticleContent`'s `onReady` callback now fires unconditionally once its render pass completes (previously gated on `.querySelector('.katex')`, so a math-free article never got a "content settled" signal at all), and `HighlightLayer` defers persisting newly-computed `orphaned`/`drifted` status until `contentVersion` has advanced past its initial value — deferring by exactly one guaranteed re-run, never skipping it. To avoid the unconditional `onReady` turning into a wasted full mark teardown/rebuild on every article (which was destabilizing live selection state in unrelated drag-handle interactions), the mount effect now caches the last full DOM-application result keyed on the highlights array reference + `root.textContent` and reuses it when a `contentVersion` bump didn't actually change the rendered text.

### Added

- **Claude Sonnet 5 as a chat + draft model option** — new `ALL_CLAUDE_MODELS` entry (`claude-sonnet-5`, 1M context, standard $3/$15 rate card; Anthropic's intro pricing deliberately not modeled since `computeCost` prices rows at read time). Defaults stay on Sonnet 4.6.

### Documentation

- **Public-release punch list, phase 1** — `.env.example` now ships the dev `DATABASE_URL` (`file:./data/gleanary.db`) with the Docker path as a comment, drops the unused `SENTRY_DSN` (also removed from README and the Caddyfile CSP), and documents `REFORMAT_PROVIDER`, `PDF_DATA_DIR`, `APP_BIND`. CONTRIBUTING.md and the PR template rewritten to the no-contributions policy (source-available, PRs closed without review; bug/security reports welcome); README contributions sentence aligned. Deleted internal maintainer docs (`docs/day-0-checklist.md`, `docs/publish-checklist.md`, `docs/handovers/`) and the unused create-next-app SVGs in `public/`. Renamed `readwise-clone` infra resources to `gleanary` and genericized the SSH key path in `infra/outputs.tf`. PRODUCT.md product name is now Gleanary. Added `package.json` metadata (description + placeholder repo URLs), `.nvmrc` (22), `extension/README.md` (load-unpacked install), and README screenshots (reader / highlight library / daily review, light + dark, theme-adaptive).

- **architecture.md reconciled with the actual app** — §6 API surface is now a full 64-route grouped index pointing at module specs as the contract source of truth; §7/§17 list the real 19 pages (`feeds/page.tsx` removed); §5 documents FK on-delete behaviors and the `['yellow']` color lock; §9 CI/CD rewritten as prose with `.github/workflows/` as source of truth (parallel jobs, real-auth E2E, `workflow_run` deploy gated on `DEPLOY_ENABLED`, full secrets table); §11 test-pyramid numbers and coverage section updated (coverage now enforced); phantom `docs/runbooks/` references removed, `docs/adr/` → `docs/adrs/`, §12 subsections renumbered. `data-layer.md` updated (five FTS tables, `pending_review` isolation, `{ article }` POST response, `sourceType` filters, list projection note, bulk-delete/bulk-tag contracts). Misspelled spec files renamed to `newsletter-ingestion.md` / `text-to-speech-immersion-reading.md` (CLAUDE.md registry updated); fixed broken ADR-007 link in `content-pipeline.md`.

### Testing

- **Coverage is now collected and enforced** — new `npm run test:coverage` script (`@vitest/coverage-v8`), baseline thresholds in `vitest.config.ts` (statements 78 / branches 70 / functions 78 / lines 80, measured 2026-07-15) that fail the build on regression, and the CI test job now runs coverage and uploads the report as an artifact.

### Security

- **Stored XSS in the highlight library fixed + baseline CSP added** — `HighlightCard` now renders unsanitized `highlight.text` as plain React text on first paint (previously `dangerouslySetInnerHTML` injected the raw text as HTML before the async KaTeX pass ran), and `next.config.ts` now serves a baseline `Content-Security-Policy` on every route (per `architecture.md` §16.2). The two inline bootstrap scripts (theme/FOUC + service-worker) moved to `src/lib/inline-scripts.ts` and are allowlisted in production via their sha256 hashes; dev relaxes `script-src` to `'unsafe-eval' 'unsafe-inline'` for HMR.

### Added

- **Integration test coverage for the 4 previously-uncovered API routes** — new `ai-index.test.ts`, `ai-index-backfill.test.ts`, `settings-test.test.ts`, and `health.test.ts` complete integration test coverage for all 64 route files, each testing the handler directly against a fresh in-memory DB with external HTTP mocked via setupHandlers, covering edge cases (404/422/500) and success paths.
- **Test coverage for four high-risk untested src/lib modules** — Added dedicated test coverage for four high-risk untested src/lib modules: markdown-renderer.ts, audit.ts, lint/contradictions.ts, and lint/gaps.ts. Four new test files, 27 new test cases, all passing on first run. markdown-renderer got mandatory XSS/hostile-input cases (script tags, img onerror, javascript: hrefs, inline onclick) plus benign-markdown rendering, using the jsdom docblock so DOMPurify has a DOM. audit.ts filed as integration (server-only import aliased to a stub under vitest, real Drizzle DB via createTestDb) covering userId/ipAddress defaults, explicit values, the never-store-value invariant, most-recent-first ordering, and the limit param. contradictions.ts and gaps.ts mirror the sibling lint tests: hoisted @/db getter mock + createTestDb, LintContext {db, rawDb}, generator output drained via for-await, and callClaude stubbed through a partial vi.mock('@/lib/ai') (keeping the real prompts/parsers) — the established repo idiom from thesis-ai.test.ts. Covered pass-A skip with no AI call, invalid-ID filtering, thrown-call recovery, supporting/opposing tension shape, out-of-range pairIndex, fallback suggestion, candidate-status exclusion, per-thesis continue-on-throw, hasGap=false/missing-description skips, title-prefixed descriptions, and the 'Review thesis' suggestedAction default. No product code was modified; all four mutation checks confirmed a test can go red then were reverted. Full suite (114 files / 1598 tests), tsc, and ESLint all green.
- **Sign out button** in Settings → General → Account: calls `POST /api/auth/logout` (previously UI-less) and returns to `/login`. Only shown when auth is active — `GET /api/settings` now reports `authActive`.

### Changed

- **Test-hygiene batch: fetch hygiene, fake timers, E2E hardening** — PART A (fetch hygiene): `fetch-utils.test.ts` no longer assigns `global.fetch` directly (converted both sites to `vi.stubGlobal('fetch', …)`) and gained `afterAll(() => vi.unstubAllGlobals())`; `draft-api.test.ts` and `browser-extension.test.ts`, whose per-`describe` stubGlobal was only paired with `vi.restoreAllMocks()` (which does NOT undo stubGlobal), each gained one file-level `afterAll(() => vi.unstubAllGlobals())` so the fetch stub can no longer leak past the file and exempt later suites from the MSW tripwire. PART B (fake timers): assessed every listed site; only `highlight-library.test.ts:128` was genuinely boundary-sensitive. Because `highlights.createdAt` defaults to SQLite `datetime('now')` (real clock, which `vi.setSystemTime` cannot pin), I did NOT introduce fake timers — instead I derived the 'tomorrow' calendar boundary from the seeded highlight's own `createdAt` so both sides use the same DB clock (the self-consistent SQL-only resolution). All other sites (auth:47 has a 1000ms margin; review:97 a 30-day margin; feed-poller:399/feed-poll:170/content-generation:443 have no boundary comparison; all lint-stale + chat-lint staleness sites seed AND compare via `sql`datetime('now','-N days')`) were left unchanged. PART C (E2E hardening): new `e2e/utils.ts`exports`waitForApiResponse(page, pathname, method)`matching on`new URL(res.url()).pathname`(string exact or RegExp), never`includes()`; migrated the four hand-rolled copies in `draft-flow`, `save-and-read`, `review`, and `highlights`specs (including highlights' local`waitForHighlightCreate` and the DELETE regex helper), preserving the wait-before-click ordering at every site.
- **Migrate inline @/db mock boilerplate to createDbMock() and module-level process.env writes to vi.stubEnv across the test suite** — centralized repeated `getDb()` and `vi.spyOn(process, 'env', 'get')` mocking patterns into a reusable `createDbMock()` helper, and replaced scattered `process.env.<key> = <value>` statements in test files with `vi.stubEnv()` calls for cleaner test isolation and consistent mock teardown across the suite.
- **Test taxonomy + coverage** — the six DB-using tests in `__tests__/unit/` (`feed-poller`, `readwise-import`, `newsletter-poller`, `reader-view`, `content-generation`, `lint-stale`) moved to `__tests__/integration/` where they belong per the "unit = pure logic, no I/O" rule (`readwise-import.test.ts` renamed to `readwise-importer.test.ts` to avoid colliding with the existing route test); only the `createTestDb` import path changed in each. New characterization tests for `src/lib/db-helpers.ts` (all fetch-or-throw helpers, membership assertions, `getThesisDetail`, draft summaries, `toChatMessageDisplay`, `autoAdvanceThesisOnResearch`, source-type subquery builders), `src/lib/models.ts` (rate-card pinning + selector/pricing consistency + `getModelBudget`), and `src/lib/usage-events.ts`. No source changes.
- **Single-shot ai/clean Mistral→Haiku fallback unified onto shared reformat-pipeline code** — unified the single-shot ai/clean Mistral→Haiku fallback onto shared reformat-pipeline code. Extracted two private shared attempt helpers in src/lib/reformat-pipeline.ts — attemptMistralReformat (catches provider errors, returns a discriminated {ok|validation|error} result, calls callMistralChat with the timeoutMs option only when provided) and attemptHaikuReformat (does NOT catch; returns {ok|max_tokens|validation}) — each owning the call → stripCodeFences → sanitizeArticleHtml → validateCleanOutput sequence exactly once. reformatChunk was rebuilt as a thin fail-open composition (minRatio 0.4, timeoutMs 150_000, Haiku wrapped in try/catch → skipped) and a new exported runSingleShotReformat (minRatio 0.6, default Mistral timeout, fail-closed: Haiku errors propagate, moved refuseOverwrite into the pipeline) mirrors runChunkedReformat. The route branch shrank to call + DB write + ai_article_cleaned log + response shaping. Behavior-preserving: all log events, 422/503 paths, response JSON shapes (provider, conditional fallback:true), and the CHUNK_THRESHOLD re-export are unchanged.
- **AI-clean business logic and inline Zod schemas extracted into `src/lib`**: `src/app/api/ai/clean/route.ts` shrinks to its HTTP/DB shell — the pure `runWithConcurrency` moves to a new `src/lib/concurrency.ts`, `stripCodeFences` moves to `src/lib/text-utils.ts`, and the whole chunked-reformat pipeline (`CHUNK_THRESHOLD`, `reformatChunk`, and a new pure `runChunkedReformat` orchestrator returning `ChunkedReformatResult`) moves to a new `src/lib/reformat-pipeline.ts`; the route re-exports `CHUNK_THRESHOLD` so its tests stay byte-untouched. Seven routes' inline query/body schemas (usage summary/breakdown/top-calls/estimate/budget, upload, tts articleId) move into `src/lib/validators.ts` under new `// --- Usage ---` / `// --- Upload ---` sections with one shared `usageRangeEnum`. `src/lib/usage-query.ts` gains `queryUsageRows(range)` absorbing the identical range-filter + `status === 'success'` block shared by the summary and breakdown routes. Behavior-preserving — schema shapes/defaults/coercions, provider fallback order, log events, DB writes, response shapes, and status codes are all unchanged; new characterization tests cover `runWithConcurrency` and `stripCodeFences`.
- **FTS query extraction into a shared lib helper**: the four near-identical FTS query blocks from `src/app/api/search/route.ts` are now in a new server-only `src/lib/search-query.ts` helper with a private generic `runFtsQuery()` executor capturing the shared shape (rawDb.prepare().all() bm25-ordered/paginated row query with snippet(fts, colIdx, char(1), char(2), '…', 12) plus a separate unpaginated COUNT(*) query reusing the same WHERE and params without cap/off); four thin typed functions `searchArticles/searchHighlights/searchTheses/searchDrafts` each return `{ results, total }` with per-type config (articles keep the always-on pending_review exclusion, weighted bm25, and snippet col 1 plus palette-skipped status/sourceId/date filters; highlights keep the extra articles JOIN for article_title; theses/drafts stay uniform, snippet col -1, unweighted bm25). Row-to-camelCase mapping and `buildSnippet()` moved into the four functions. The route now only does `searchSchema.parse` (throwing, inside `withRoute`), escape/prefix-star, PALETTE_CAP, cap/off, the four type-gated calls, and the `{ query, results, totals } satisfies SearchResponse` assembly. SQL tokens, condition order, param order, bm25 weights, snippet column indices, and char(1)/char(2) sentinels preserved. Behavior-preserving; no new functionality.
- **Repeated API-route try/catch shell folded into a `withRoute` wrapper**: the new server-only `withRoute(route, handler)` HOF in `src/lib/api-error-handler.ts` awaits a handler and funnels any thrown error through the unchanged `handleApiError(error, route)`, replacing the identical `try { … } catch (error) { return handleApiError(error, '<label>') }` boilerplate across 75 plain-shape route handlers in 53 files. Behavior-preserving — route label strings are byte-identical, response shapes/status codes on success and error paths are unchanged, and `handleApiError` itself is untouched; streaming/divergent handlers (chat POST, drafts generate, parse/upload, TTS, etc.) keep their bespoke shells. New characterization tests in `__tests__/unit/api-error-handler.test.ts` cover pass-through, error mapping, and route-label forwarding.
- **Duplicated API-route helpers consolidated**: the two local `sseEvent` copies in the TTS and Readwise-import routes (which returned a `string` then got wrapped in `encoder.encode(...)`) now use the canonical `sseEvent`/`SSE_HEADERS` from `@/lib/sse` (already used by the chat route), and their hand-rolled SSE response headers collapse to `...SSE_HEADERS`; the three identical `rangeToSqlFilter` copies in the usage summary/breakdown/top-calls routes move verbatim into a new server-only `src/lib/usage-query.ts`. Behavior-preserving — the lib `sseEvent` emits byte-identical `event: <type>\ndata: <json>\n\n` output (now locked by a new `__tests__/unit/sse.test.ts` characterization test); no wire-output, query-result, response-shape, or status-code change.
- **Client/server boundary guarded in `src/lib`**: 19 server-only lib modules now start with `import 'server-only';` so any accidental import from a client component fails the build instead of leaking server code (DB, secrets, provider SDKs) into the browser bundle. The pure `SETTINGS_SCHEMA`/`ENCRYPTED_KEYS`/`SettingKey`/`SettingMeta` definitions moved out of the now server-only `settings.ts` into a new dependency-free `src/lib/settings-schema.ts` (re-exported from `settings.ts` for back-compat); `validators.ts` (isomorphic) imports `ENCRYPTED_KEYS` from `settings-schema` to break the weld. `vitest.config.ts` aliases `server-only` to its empty stub so tests (plain node) treat the marker as a no-op. Purely structural, no behavior change; typecheck, lint, all 1474 unit/integration tests, and the production build all pass.
- **Reader scroll-progress formula extracted to a shared helper**: `src/lib/scroll-progress.ts` now owns the docHeight/progress math (`getScrollableHeight`, `computeScrollProgress`, `getScrollProgress`, `progressToScrollY`); the visible progress bar, the persisted `readingProgress`, and the scroll-position restore all consume it instead of three divergent inline copies. Rounding stays a caller concern (bar unrounded, persistence 2-decimal) — no behavior change. New node-env unit test `scroll-progress.test.ts` covers the pure math.
- **Reading-progress-bar unit test now exercises the real component**: `__tests__/unit/reading-progress-bar.test.tsx` renders `ReadingProgressBar` through `ArticleProvider` with React Testing Library + jsdom (first RTL component test; `@testing-library/react`/`@testing-library/dom` added as devDeps, vitest include widened to `.test.tsx`) instead of asserting an inline copy of the scroll/reset logic; the bar now also exposes `role="progressbar"` + `aria-valuenow`, which the test uses as its query seam.
- **Test hygiene sweep**: vitest no longer sets `passWithNoTests` (an include-glob restructure that matches zero tests now fails CI instead of staying green); CI E2E runs against the production build (`npm run start` after `npm run build` — the Docker standalone artifact stays deploy-only, see TECH_DEBT.md) instead of the dev server, with a new `prestart` migrate script mirroring `predev`; a new FTS5 drift-guard test (`fts-schema-sync.test.ts`) discovers all FTS tables from `sqlite_master` and asserts their columns/sync triggers stay in sync with `schema.ts`; `mobile-save.spec.ts` no longer depends on real external network (parse API stubbed via `page.route`, with `serviceWorkers: 'block'` set config-wide since `sw.js` bypasses route stubs); `docs/architecture.md` §11 E2E journey table updated to the 11 actual specs.
- **Hardened the E2E suite (test-hygiene)** — (1) Removed every `waitForTimeout` from `e2e/` (4 in `highlights.spec.ts`) and replaced each with a condition-based wait: the dblclick-on-existing-highlight "no duplicate" case now waits for the edit-mode popover (which sets the guard that suppresses auto-create); Escape now waits on popover-not-visible before the about:blank skip check; delete now waits on the specific DELETE `/api/highlights/:id` response and asserts `toHaveCount(0)`; mobile double-tap now asserts no POST `/api/highlights` fires. (2) Click→GET read-back races now wait on the mutating response: save-and-read archive (PATCH `/api/articles/:id`) and draft-flow publish (PATCH `/api/drafts/:id`) wrap the click with `waitForResponse` and assert `ok()` before the API read-back. (3) Non-deterministic flow removed: global-search's up-to-10-`ArrowDown` loop with silent fallback is now a deterministic locate-by-testid + hover + Enter that fails if the option is missing; review.spec.ts's conditional reveal `isVisible()` is now an unconditional assert+click, and its three-way post-"Got it" `.or()` is a single deterministic advance (seeds a second due highlight so a next card is guaranteed). (4) review.spec.ts migrated fully to `data-testid` (off `.border-l-yellow-400`, regex-text, and hasText selectors); partial violators fixed in save-and-read, highlights, global-search, pdf-import, selection-handles. Root-caused the intermittent "multiple highlights" flake — the second `dblclick` fired before edit-mode teardown (editingRef guard) so it no-oped — and fixed it by waiting for the selection handles to disappear (plus creation-response waits). Product code touched with additive `data-testid` attributes ONLY (no logic/style/prop changes): article-content, article-header (title/byline/meta), review-card/review-session, selection-handles (grip/line), search palette (listbox/options/footer).
- **CI: Playwright E2E now runs on pull requests**: the `e2e` job's main-only gate is removed, so a broken critical journey fails CI before merge; on non-cancelled runs the job uploads `playwright-report/` and `test-results/` (traces) as a 7-day `playwright-artifacts` artifact for debugging failures. `docs/architecture.md` §9/§11 updated to match.
- **Schedulers: manual `isPolling` re-entrancy flags replaced by node-cron's built-in `noOverlap` option**: feed and newsletter schedulers now pass `{ noOverlap: true }` and log their skip events from the `execution:overlap` task event; node-cron's internal console logging is routed to pino via a new `cronLogger` adapter, and scheduler restarts now `destroy()` the old task (a plain `stop()` leaked it in node-cron's global registry).
- **Tests: shared MSW server is now a global network tripwire**: `__tests__/mocks/server.ts` (zero default handlers — the canned `handlers.ts` is deleted) is wired into vitest `setupFiles` with `onUnhandledRequest: 'error'`, so any unmocked request in any test file is rejected instead of silently hitting the real network (tests must still assert on the code path that consumes the response). All 15 per-file `setupServer` instances migrated to the new `setupHandlers(...)` helper; a tripwire unit test guards the setup. Already caught one real leak: `upload.test.ts`'s Jina Reader fallback used to reach the live `r.jina.ai`.

### Fixed

- **CI-only E2E mass failure fixed; production CSP now allows Next.js App Router hydration** — the production CSP branch in `next.config.ts` script-src allowlisted only the two hand-written bootstrap scripts via sha256 hashes (`script-src 'self' 'sha256-...' 'sha256-...'`), but Next.js hydrates every page through its own dynamic inline `self.__next_f.push(...)` blocks which cannot be hash-allowlisted. With no nonce and no `'unsafe-inline'`, the browser blocked them, React never hydrated in production, and the `/login` password onChange never fired so the submit button stayed permanently disabled (`disabled={submitting || !password}`). Changed production scriptSrc to `script-src 'self' 'unsafe-inline'` and removed both hashes (CSP subtlety: any hash/nonce present makes the browser ignore `'unsafe-inline'`, so the hashes had to be removed, not merely accompanied). Also removed the now-unused `scriptHash` helper and the `createHash` / `THEME_BOOTSTRAP_SCRIPT` / `SERVICE_WORKER_SCRIPT` imports from `next.config.ts` (src/lib/inline-scripts.ts is untouched — layout.tsx still imports it). Dev branch and every other CSP directive left exactly as-is. This matches the accepted CSP posture already in `docker/Caddyfile`.
- **Data layer: stale duplicate FTS definition removed; `highlight_tags` uniqueness + hot-path indexes added**: `scripts/migrate.mjs` no longer carries its own (already-drifted) copy of the FTS5 DDL — `initFts()` in `src/db/fts.ts` is now the sole owner of FTS shape, and its rebuild predicate compares the full `articles_fts` column set instead of probing only for `ai_index`, so any future column drift triggers a rebuild. Migration `0021` adds a UNIQUE index on `highlight_tags(highlight_id, tag_id)` (deduping existing rows first) plus secondary indexes on `articles(status, saved_at, source_id)`, `highlights(article_id, last_reviewed, review_interval)`, `highlight_tags(tag_id)`, `chat_messages(session_id)`, `voice_samples(profile_id)`, and `thesis_research(thesis_id)`. Tag writers (`linkHighlightTags`/`replaceHighlightTags` and the bulk-tag route) now dedupe repeated tag ids so the new constraint can't turn a duplicated id in a request into a 500.
- **`pdf-import.spec.ts` no longer times out on real Mistral OCR imports, and now cleans up even on a failed assertion**: the synchronous OCR call at import time can take close to 30s, occasionally exceeding Playwright's default 30s test timeout — the spec now sets a 60s test timeout and registers the created article for `afterEach` cleanup as soon as the response body is parsed (rather than after the success assertion), so a slow-but-successful upload can't leave an orphaned article that fails every later run with a duplicate-URL `409`.
- **`pdf-import.spec.ts` still flaked past its 60s budget on slow real OCR imports**: `mistral-ocr.ts`'s own timeouts are 60s for the file-upload leg plus 120s for the OCR call (`UPLOAD_TIMEOUT_MS` + `DEFAULT_TIMEOUT_MS`), so a single slow-but-successful upload can legitimately take up to 180s — the spec's test timeout is now 200s to cover that worst case plus the journey's own assertions. Separately, the article row is inserted _before_ OCR runs, so a run that never gets an HTTP response back (client-side abort, harness kill) leaves an orphaned row that makes every later run 409 immediately on the duplicate-hash check; the new `uploadFixture` helper self-heals by deleting the conflicting article returned in a `409` body and retrying once.
- **Draft editor no longer reverts a title edit made right after generation finishes**: `handleDone`'s post-generation metadata refresh unconditionally wrote `fresh.title` into the title/last-saved buffers, clobbering a concurrent user edit so the debounced autosave never fired — the cause of the `draft-flow.spec.ts` save-indicator flake (the FOREIGN KEY log line in the issue was unrelated noise; failing runs reproduce without it). The refresh now updates metadata only (generation never changes the title server-side), and the E2E pins the race deterministically by holding the refresh response until after the title edit.

- **Conditionally-skipped test assertions made unconditional**: the global-search XSS-sanitization check now asserts a non-empty result set before checking the snippet (it could silently pass with zero results), the tts-cache chunk assertions use a fail-fast throw narrowing instead of an `if` wrapper, and the same pattern found in `e2e/pdf-import.spec.ts` (page-count checks guarded by `if (article.pageCount)`) and `e2e/search.spec.ts` (zero-results check guarded by `if (searchRes4.ok())`) now asserts the precondition upfront. A lint guard against reintroduction is tracked in TECH_DEBT.md.
- **Migration runners converged** (TECH_DEBT: incompatible tracking schemes): `scripts/migrate.mjs` now reads the drizzle journal and records migrations in drizzle-kit's exact format (sha256 hash + journal `when` millis), normalizing legacy filename-tracked rows on sight — `migrate.mjs` and `npm run db:migrate` now share one tracking scheme on the same DB (4 interop tests). Caveat: FTS5 tables/triggers are still created only by `migrate.mjs`, so a fresh DB bootstrapped with bare `drizzle-kit migrate` lacks search (tracked in TECH_DEBT.md). A new `predev` script migrates before `npm run dev`, so a fresh clone runs without a manual migrate; the Playwright webServer's DB-existence gate is gone.
- **Unvalidated Haiku reformat output could silently overwrite article content** on the non-chunked path: `validateCleanOutput` now guards the Haiku fallback the same way it guards Mistral (`422`, content untouched on failure), matching the chunked path's symmetric validation.
- **CI E2E job failed at webServer startup** ("Cannot open database because the directory does not exist"): on a fresh checkout the gitignored `data/` dir doesn't exist and no migrations have run. When the DB file is missing, the Playwright `webServer` command now runs `scripts/migrate.mjs` (same script Docker uses) before `next dev`; existing DBs are never touched (see TECH_DEBT.md on the two migration trackers). Also pipes webServer stdout so migrate/dev logs show up in CI.

### Changed

- **pdfjs-dist 5.7.284 → 6.1.200**: migrated `preflightPdf` off the removed `PDFDocumentProxy.destroy()` to `loadingTask.destroy()`, now in a `finally` (with a logged, non-masking catch) so the fake worker is also torn down when a PDF is encrypted or malformed. v6 stub audit: dropped the now-dead `ImageData` stub (v6 only touches `DOMMatrix`/`Path2D`/`navigator` at module eval) and replaced the private `PDFWorker._setupFakeWorkerGlobal` patch with pdfjs's public `globalThis.pdfjsWorker` hook. File paths now go through `pathToFileURL()` (a `#`/`%` in `PDF_DATA_DIR` previously misparsed the file URL). The reader's `pdf-viewer.tsx` is unaffected — react-pdf pins its own nested pdfjs-dist 5.4.296 (no v6-compatible react-pdf release yet).

### Security

- **IPv6 SSRF coverage in `validateUrl`/`validateHostname`**: private-range checks are now numeric via Node's `net.BlockList` (was string-prefix matching on IPv4 only). Blocks IPv6 loopback/unique-local (`fc00::/7`)/link-local (`fe80::/10`) literals and IPv4-mapped forms in both serializations, resolves AAAA records (`dns.resolve6`) alongside A records, closes the `127.0.0.0/8` gap (only exact `127.0.0.1` was blocked) and the `0.0.0.0/8` "this network" range (routes to localhost on Linux), and strips a trailing FQDN dot so `10.0.0.1.` can't slip a private literal past `net.isIP` on the raw IMAP-host path. Closes the `TECH_DEBT.md` IPv6 row.
- **Dependency audit**: synced `node_modules` with declared versions (msw 2.14.6, shadcn 4.12.0, vitest 4.1.9) and applied `npm audit fix` — 27 vulnerabilities (6 high) down to 6 moderate, all in dev-only chains with no non-breaking fix (esbuild via drizzle-kit, postcss via next).

### Fixed

- **E2E now gates CI**: fixed the 3 known-failing specs — global-search deep-link (spec destructured the wrong response shape, expected `highlight=undefined`), PDF page-count badge (`readingTime()` now prefers `pageCount` per `docs/modules/pdf-import.md`, so PDF cards show "N pages" instead of "N min read"), save-and-read Archive strict-mode violation (spec now targets the footer button via new `data-testid="archive-footer-button"`) — and removed the `|| echo` mask from `ci.yml` so Playwright failures fail the build.

### Added

- **Built-in authentication (Module 21)**: the app now protects itself instead of relying on reverse-proxy basic auth. New request gate `src/proxy.ts` accepts an HMAC-signed session cookie (30-day, invalidated on password change) or an `Authorization: Basic` header (browser extension/iOS Shortcut unchanged); unauthenticated API calls get 401, pages redirect to the new `/login` page. `POST /api/auth/login` (Zod-validated, per-IP throttled 5 fails/15 min) and `POST /api/auth/logout`. Password is the existing `SETTINGS_AUTH_HASH`; `AUTH_DISABLED=true` escape hatch for VPN-only setups (logged warning). `verifySettingsPassword()` now delegates to the shared `verifyPassword()`; `getClientIp()` moved from `src/lib/settings.ts` to `src/lib/auth.ts`. E2E suite runs with `AUTH_DISABLED=true` unless `E2E_AUTH_PASSWORD` is set (then a login journey spec runs against real auth). See `docs/modules/auth.md`.

- **Turnkey deployment packaging**: committed `docker/compose.yml` (app + optional `--profile tls` Caddy for HTTPS; app binds `127.0.0.1` by default, `APP_BIND` overridable) and `docker/Caddyfile` (TLS + security headers, no basicauth — auth is built into the app now). Fixed the stale `scripts/migrate.mjs` default DB path (`file:/data/db/readwise.db` → `file:./data/gleanary.db`). `package.json` now declares `engines.node >= 22` and the `PolyForm-Noncommercial-1.0.0` license. Infra (needs review before apply): `cloud-init.yml` `.env` now includes `SETTINGS_AUTH_HASH` (single-quoted against dotenv `$`-expansion) and `SETTINGS_ENCRYPTION_KEY`, Caddy basicauth removed (superseded by built-in auth), and the previously missing `jina_api_key` template var is now passed by `main.tf`.

- **License & community files (open-source prep)**: added `LICENSE.md` (PolyForm Noncommercial 1.0.0 — free for personal/noncommercial use, commercial rights reserved), `CONTRIBUTING.md` (DCO sign-off + license grant so contributions can ship in a future commercial edition), `SECURITY.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), and GitHub issue/PR templates. Rewrote `README.md` for newcomers (compose-first quick start, required-vs-optional env table with paid-key flags, security section); moved the AI-assisted development workflow to `docs/development.md`. Refreshed `.env.example` (Gleanary branding, `gleanary.db` path, `AUTH_DISABLED`, single-quote hash guidance, personal domain removed). Fixed `docs/architecture.md` drift: IaC provider is OVH/OpenStack (was "Hetzner") and Caddy is TLS-only now that auth is built in.

- **CI/CD split for open-sourcing**: the owner-specific deploy job (GHCR push, Sentry sourcemaps, SSH deploy) moved from `ci.yml` to `.github/workflows/deploy.yml`, triggered after CI succeeds on main and gated by the `DEPLOY_ENABLED` repository variable so forks and the public repo never attempt it. CI's E2E job now runs the suite in real-auth mode (`E2E_AUTH_PASSWORD` + derived hash), exercising the login gate and journey spec. Added `docs/publish-checklist.md` (fresh-repo export via `git archive`, gitleaks gate, post-publish smoke test). Known-failing E2E specs and the CI failure mask are tracked in `TECH_DEBT.md`.

### Changed

- **CLAUDE.md audit & session workflow externalization**: fixed dead references in `CLAUDE.md` (nonexistent `/batch` command → parallel subagents, `docs/adr/` → `docs/adrs/`, `docs/runbooks/deploy.md` → `README.md` § Deployment Options, phantom "test inventory" → `docs/architecture.md` §11.5) and registry gaps (added `content-pipeline.md`, marked module 9 spec as not yet written). Moved the eight inline session workflows to `docs/sessions/*.md` (matching the existing scaffold pattern) and deduplicated the security checks: `docs/sessions/security-audit.md` is now the canonical list, referenced by the module-build and feature SECURE steps.

- **Open-source prep — secrets & PII scrub**: untracked the committed OVH OpenStack catalog dumps (`output.json`, `infra/output.json`, `infra/catalog` — contained real tenant/project IDs), hardened `.gitignore` (`*.tfvars`, `infra/catalog`, `infra/output.json`), and replaced the personal newsletter ingestion address with `inbox@reader.example.com` in test fixtures and `docs/modules/newslette-ingestion.md`. No behavior change.

- **Mobile sidebar search shortcut**: on mobile (coarse-pointer) devices, tapping the search icon in the sidebar header now navigates directly to the `/search` page (closing the sidebar) instead of opening the desktop `Cmd+K` search palette. Desktop behavior is unchanged. The `/search` page now auto-focuses its search input on load, so the redirect lands with the cursor ready to type.
- **Design-system button adherence**: converted ~80 styled raw `<button>` elements across `src/components/` (and a few `src/app/` pages) to the shared `@/components/ui/button` `Button` component, resolving the `TECH_DEBT.md` row for the "Never style a raw `<button>`" rule. Added a thin `TopBarButton` wrapper (`top-bar.tsx`) over `Button` for the top-bar/tab pill style and removed the `TOP_BAR_BUTTON` className constant (migrated all top-bar buttons and `<Link>`s via `asChild`). Reader-scoped controls (`ai-cleanup-banner`, `undo-toast`, newsletter/PDF view toggles) keep their `--reader-text` colors via `className` overrides. Three controls intentionally stay raw with inline comments: the appearance `role="radio"` radiogroup and search `role="tab"` tablist (ARIA semantics) and the voice-sample disclosure toggle (wraps an editable input). UI-only — no behavior change.
- **Button-adherence follow-up simplifications**: extracted the duplicated full-width picker rows in `message-actions.tsx` into a reusable `OptionRow` component, hoisted the repeated popover-row className in `listen-button.tsx` into a `POPOVER_ITEM_CLASS` constant, and clarified the `TopBarButton` JSDoc (`top-bar.tsx`) to note it is a general pill button, not top-bar-only. No behavior change.
- **Token-first cleanup of remaining raw palette colors**: replaced ~33 raw Tailwind palette utilities used for chrome/status across 7 files with semantic tokens — success/warning/error status text → `text-success`/`text-warning`/`text-destructive` (`settings-page`, `save/page`, `api-key-field`, `ai-cleanup-banner`, `highlight-popover`), and the yellow warning callouts → `bg-tint-amber text-tint-amber-fg` (`settings-page`, `voice-profile-editor`). The voice-profile "Overwrite" button moved from `bg-yellow-600` to the `warning` token. The favorite-heart active state (`fill-red-500 text-red-500`, `reader-toolbar.tsx`) is now sanctioned as a fixed brand accent in CLAUDE.md alongside the highlight `yellow-400` and TTS `blue-400/500`. UI-only — no behavior change.
- **Unify status/semantic colors into token system**: added `--success`/`--warning`/`--info` semantic accents and a 7-hue soft tint scale (`--tint-<hue>` / `--tint-<hue>-fg`: slate, amber, blue, purple, green, red, orange) to `globals.css`, exposed via `@theme inline`. Thesis status (`status-track.tsx`), article status (`reader-toolbar.tsx`), evidence roles (`evidence-section.tsx`), and health-panel dots (`knowledge-health-panel.tsx`) now map onto the shared `tint-*` ramp instead of ad-hoc `*-100/700` Tailwind palette classes; the over-budget meter (`usage-footer.tsx`) and budget readout (`usage-section.tsx`) use `text-warning`/`bg-warning`. All status surfaces read as one family and flip cleanly between themes. The highlight `yellow-400` and TTS/reading-progress `blue-400/500` remain the only fixed raw accents. CLAUDE.md design-system section updated to match.
- **Apply Prettier formatting to pre-existing files**: reformatted `src/lib/models.ts`, `src/lib/pricing.ts`, and two `.claude/skills/*/SKILL.md` files that were failing `prettier --check` at HEAD (no logic changes).
- **Wire `web_search_requests` into `webSearchCount`**: `callClaude` and `callClaudeStreaming` in `src/lib/ai.ts` now read `response.usage.server_tool_use?.web_search_requests` instead of hardcoding 0. Web search calls now record accurate counts in `ai_usage` (field was always 0 due to stale SDK 0.39.0 comment; fixed on 0.105.0).
- **Single source of truth for Claude model registry**: `ALL_CLAUDE_MODELS` in `src/lib/models.ts` is now the one place to add a model — `ANTHROPIC_MODELS`, `DRAFT_MODELS`, `DRAFT_MODEL_IDS`, and the `MODEL_PRICING` Claude entries in `pricing.ts` all derive from it automatically. Adding a future model requires one array entry; forgetting pricing is no longer possible.
- **Bump chat and draft model selectors to Opus 4.8**: replaced Opus 4.6 (chat) and Opus 4.7 (draft) with Opus 4.8 (current recommended Opus tier, same $5/$25 MTok price, 1M context window). `MODEL_PRICING` now includes `claude-opus-4-8`. Corrected `contextWindow` for Sonnet 4.6 to 1M tokens. Closed `TECH_DEBT.md` entry for `web_search_count`.

- **Pin Mistral OCR model to `mistral-ocr-4-0`**: replaced floating alias `mistral-ocr-latest` (now resolves to OCR 4) with the pinned id. Updated page-based pricing to $0.004/page (doubled from $0.002). `callMistralOcr` now records the sent constant as the stored model rather than the API echo — guaranteeing the pricing map key always matches by construction. Historical `ai_usage` rows under `mistral-ocr-latest` price at the old $0.002 rate and are unaffected.

- **Simplify pass (Module 20)**: Import `isV2Anchor` from lib in backfill (removed local duplicate), flatten `locateQuote` ternary to `||` chain, reduce `recoverAnchorFromText` loop to `reduce`, remove dead `rows.length` guard in reanchor route, inline v2 fast-path in `applyHighlightsToDOM` using cached `articleText`.

### Added

- **Claude design MCP server config (`.mcp.json`)**: connects Claude Code to the Claude design system MCP (`https://api.anthropic.com/v1/design/mcp`) so design-adherence work can reference the shared design source. Config only, no secrets.

- **Highlight anchoring — reader rewiring + reanchor route + orphan badge (Module 20, session 2)**: Wired v2 anchoring into `highlight-layer.tsx`: `applyHighlightsToDOM` now resolves v2 anchors via `anchorToRange` (fast path → fuzzy) and returns `{orphaned, drifted}` descriptors; the calling effect fires fire-and-forget PATCHes to persist orphan flags and refreshed anchors, guarded against active edits. New `describeRange` used at all four highlight-create/edit callsites (replacing `serializeRangeClean`). New route `POST /api/articles/[id]/reanchor-highlights` re-anchors all highlights for an article against its current `content_html` using jsdom (same core, same DOM structure as the reader) and returns `{reanchored, orphaned, unchanged}`. Orphaned highlights are badged "Needs re-anchoring" in the highlight library (`highlight-card.tsx`). Integration tests cover all reanchor route branches (unchanged, drifted v2, orphaned, v1 upgrade, idempotent). E2E test (`e2e/highlight-survives-reformat.spec.ts`) verifies the fuzzy-path round-trip end-to-end.

- **Highlight anchoring — core, schema, backfill (Module 20, session 1)**: Implemented the environment-agnostic v2 text-quote anchoring core in `src/lib/highlight-anchoring.ts` (`getRootText`, `describeRange`, `anchorToRange`, `recoverAnchorFromText`). Resolution is exact-primary: a position fast path for unchanged content (idempotent — no offset drift), then fuzzy matching of the quote via `approx-string-match` with the error budget sized to the quote so context drift never orphans an intact quote; duplicates are disambiguated by Sørensen–Dice context agreement then proximity. Added `highlights.anchor_status` (`anchored`/`orphaned`, migration `0020`), `TextQuoteAnchor`/`AnchorStatus` types, `positionDataStringSchema` (accepts v2 or transitional v1), and `scripts/backfill-highlight-anchors.ts` (jsdom v1→v2 upgrade, fuzzy text recovery, orphan fallback). Reader rendering and the re-anchor route follow in session 2. **Operational note: do not run the backfill in production until session 2's dual v1/v2 reader ships** — upgrading rows to v2 first would un-render existing highlights.

- **Highlight anchoring spec** — added `docs/modules/highlight-anchoring.md`: text-quote + text-position anchoring model (W3C-style `exact`/`prefix`/`suffix` + char offsets) to replace fragile child-index DOM paths, so highlights survive content reformatting. Spec only; implementation tracked across two module-build sessions.

- **Global Search — UI (Module 19, session 2)**: Command palette (`Cmd/Ctrl+K`, sidebar Search icon) with WAI-ARIA combobox + listbox pattern, 200ms debounce, AbortController stale-guard, auto-activated first result, no-wrap arrow nav, mobile full-screen, and "See all N results →" footer. `/search` page with URL-driven state, type tabs with counts, filter row, reuse of existing card components (snippet slots), and per-type load-more. Reader `?highlight=<id>` deep-link with `scrollIntoView` + pulse animation, consumed exactly once via `hasScrolledToDeepLinkRef`. Unit tests for the palette reducer; E2E tests for the full journey.

- **Global Search — backend (Module 19, session 1)**: Extended `GET /api/search` with a new grouped `SearchResponse` shape covering articles, highlights, theses, and drafts. Added `drafts_fts` FTS5 virtual table with insert/update/delete sync triggers and unconditional startup rebuild. Implemented `mode=palette` with 5-result cap, prefix matching via `applyPrefixStar()`, and filter-isolation. Snippet XSS safety via the §6.1 sentinel pipeline (`buildSnippet` in `src/lib/search-snippets.ts`). Per-type BM25 ranking (articles: title weighted 3×). All existing search callers and E2E tests migrated to the new response shape.

### Changed

- **Removed `read` article status** — finishing an article now means archiving it. The "Read" button in the reader toolbar has been removed; the Archive button is the sole finish action and now stamps `readAt` on first archive. The "Read" filter tab has been removed from the inbox. Existing articles with `status='read'` are migrated to `archived`. Readwise imports now land in Archived instead of the old Read state.

- **Reader: consolidated "Open original" link** — removed the top-bar `ExternalLink` icon button and the "Original" link from the article header; replaced with an "Open original" item in the `…` dropdown menu (below "Reset reading progress"). The item is hidden for articles with internal-scheme URLs (`newsletter://`), including orphaned newsletter articles whose source row has been deleted. PDF uploads open `/api/articles/{id}/original`; web articles open the source URL directly. The item renders as a native `<a>` element (via `asChild`) to support right-click and middle-click.

### Fixed

- **Mobile search palette mispositioned** — the full-screen mobile search dialog inherited the base `DialogContent` centering. It only reset `translate-y`, so the 100vw-wide palette was shifted half off-screen to the left (tapping Search showed an empty dark panel); and the inherited `grid` + `h-full` stretched the single track, vertically centering the search bar and making it jump to the top once results appeared. Added `max-sm:translate-x-0` (fills the viewport) and `max-sm:content-start` (packs the input to the top with results directly below). Also added a mobile-only close (`X`) button in the search input row, since the full-screen palette has no overlay to tap and no `Escape` key on a phone. Desktop layout is unchanged.

- **Disabled mobile pinch/double-tap zoom** — the root `viewport` export now sets `maximumScale: 1` and `userScalable: false`, so the app behaves like a native shell on phones instead of allowing the page to zoom in/out.

- **Search result navigation closes the sidebar on mobile** — activating a search result now retracts the open sidebar on touch devices (mirrors the existing sidebar-nav behavior via `isMobileDevice`), so the opened article/highlight/thesis/draft isn't left covered by the sidebar. Desktop keeps the sidebar open.

- **Chunked reformat: Haiku fallback validation too strict** — relaxed `validateCleanOutput` minimum output ratio from 60% to 40% of input length (cleaning noisy HTML legitimately removes div soup, causing valid output to fail the old threshold); raised `MISTRAL_CHUNK_TIMEOUT_MS` from 90s to 150s to handle large unsplittable chunks without prematurely falling back; added `stopReason`, `inputLen`, and `outputLen` to the `reformat_chunk_haiku_validation_failed` log event for better diagnostics.

- **Images failing in production (ERR_FAILED)**: inject `referrerpolicy="no-referrer"` directly into the HTML string before `dangerouslySetInnerHTML` renders it, replacing the previous `useEffect`-based approach which fired too late (after browsers had already started fetching images with the Referer header, triggering CDN hotlink-protection blocks).

- **Code review fixes for chunked reformat** — parent HTML elements (tables, lists) now correctly wrap their sub-chunks after recursion; `fallback:true` is no longer emitted when the provider is explicitly set to `anthropic`; `ChunkOutcome` type moved to `src/types/`; redundant JSDoc removed from private helpers.
- **Usage view: runId grouping** — chunked reformat rows in Settings → Usage are now collapsed into a single line item per reformat run showing aggregate tokens, cost, and per-model chunk counts (e.g. "mistral×3 + haiku×1").
- **Docs and debt**: Phase 4 section added to `docs/modules/content-pipeline.md`; TECH_DEBT.md updated with SSE progress streaming, configurable thresholds, and per-chunk fallback-rate observability entries.
- **Parallel chunked reformat for long articles** — `POST /api/ai/clean` now splits articles over 35k chars into ~25k chunks and reformats them in parallel. Each chunk follows the same Mistral-primary / Haiku-fallback pipeline. On partial failure the original HTML for failed chunks is preserved and the reader banner shows "Reformatted with AI (X/N sections; M kept original)". All-fail returns 422 leaving content unchanged. All chunks share a `runId` for per-chunk telemetry grouping. See ADR-008.
- **Mistral chat provider for HTML article reformat** — `POST /api/ai/clean` (HTML branch) now uses Ministral 3 8B via Mistral's first-party API by default, with automatic fallback to Claude Haiku on validation failure or provider error. Roughly 10× cheaper on output and ~1.5× faster throughput. Provider switchable via the new `reformat_provider` setting. See ADR-007 and `docs/modules/content-pipeline.md` §3.
- **Reformat reliability for large articles** — raised Mistral timeout to 300s and Haiku timeout to 240s (with no retries) to handle articles near the 50k-char reformat limit; stripped markdown code-fence wrapping that Mistral occasionally adds around HTML output; updated `AI_CLEAN_PROMPT` to explicitly forbid code fences; added `@anthropic-ai/sdk` to `serverExternalPackages` to prevent Turbopack from rebundling it.

### Fixed

- **PDF import (canvas warnings)**: stub `ImageData` and `Path2D` on `globalThis` before loading `pdfjs-dist` so it no longer attempts to load the absent `@napi-rs/canvas` native package in Docker, eliminating the "Cannot polyfill" warnings. Guards added so global stubs and the fake-worker `Object.defineProperty` are only applied once per process.
- **PDF import (production crash)**: add `pdfjs-dist` to `serverExternalPackages` so Next.js does not bundle it via webpack; without this, pdfjs-dist's module-level canvas setup ran at server startup before `ensureBrowserGlobals()` could install the stubs, causing `app exited with code 0`. The remaining "Cannot load @napi-rs/canvas" warning is harmless — our stubs satisfy the globals pdfjs-dist falls back to, and we never use canvas rendering.
- **PDF import (Alpine navigator crash)**: stub `globalThis.navigator` via `Object.defineProperty` before loading pdfjs-dist. Alpine Linux has no locale, so `navigator.language` is `''`; pdfjs-dist unconditionally tries `globalThis.navigator = {...}` when language is falsy, which throws `TypeError: Cannot set property navigator of #<Object> which has only a getter` in Node.js 21+ (where `navigator` is a getter-only property). The `Object.defineProperty` call pre-populates it with `language: 'en-US'` so pdfjs-dist skips the assignment entirely.
- **PDF import (OOM / process killed)**: lower `--max-old-space-size` from 2048 MB to 1024 MB. The previous limit exceeded the server's 1.875 GiB of RAM; V8's major GC cycle can briefly use 1.5–2× the live heap, causing the Linux OOM killer to SIGKILL the process (which Docker reports as exit code 0 on Alpine). 1024 MB provides enough headroom for a 50 MB PDF at 5× overhead while staying well under the physical RAM limit.
- **PDF import (heap pressure — preflight)**: `preflightPdf` now accepts an absolute file path in addition to a `Buffer`/`Uint8Array`. Upload and parse routes store the PDF to disk first, then run preflight via `pdfjs.getDocument({ url: 'file://...' })` so pdfjs reads through the OS page cache instead of copying the full file into V8 heap. On preflight failure (encrypted PDF, parse error, or page-count exceeded), the stored file is deleted before the error propagates.
- **PDF import (heap pressure — Mistral OCR)**: `callMistralOcr` now accepts an absolute file path and uploads the PDF to the Mistral Files API via multipart form data (raw bytes) instead of embedding a base64 data URI in the JSON request body. For a 50 MB PDF this eliminates ~200 MB of intermediate V8 string allocations (base64 string + template literal + JSON body). The uploaded file is deleted from Mistral after OCR regardless of success or failure. Response images are now processed sequentially with each base64 string freed after the decoded bytes are written to disk. Upload and parse routes null the request buffer after `storePdf` so it is GC-eligible before OCR runs.
- **PDF dropzone**: dropping a file on the dropzone div no longer triggers two simultaneous upload requests (the div's `onDrop` and the document-level `onDocDrop` both fired, causing a race condition that showed a brief "Upload error" before the successful redirect).

### Changed

- **PDF upload entry point**: replaced the standalone `/upload` page and separate Upload icon button in the sidebar with a unified `+` dropdown (`AddContentButton`) offering "URL" and "PDF" options. The URL option opens the existing save-by-URL modal; the PDF option opens an inline upload modal with drag-and-drop. Removed `PdfDropZone` from the homepage, `save-article-modal.tsx`, `upload-pdf-form.tsx`, and `src/app/upload/page.tsx`. `useHandlePdfUpload` gains an `onSuccess` callback so the modal closes before navigation.

### Changed

- **PDF Import (Phase 3 — Mistral OCR at import time)**: PDFs are now extracted via Mistral OCR synchronously on upload, replacing the previous two-step UX (pdfjs/Jina cascade → optional "AI cleanup" button). New `src/lib/pdf-preflight.ts` handles encryption detection + metadata via pdfjs; new `src/lib/pdf-processor.ts` orchestrates the OCR call, image side-effects, and HTML pipeline. Upload/parse routes insert a placeholder article row with `extraction_tier='failed'`, run OCR, and update the row on success. Mistral failures (missing key, network/API errors, empty output) still create the article with `extraction_tier='failed'` so the user can retry from the reader. `/api/ai/clean` PDF branch collapses to a retry-only delegation. `MAX_PDF_PAGES = 1000` is enforced at preflight before any disk write. Removed: `src/lib/pdf-extractor.ts` (tier-1 pdfjs text extraction, tier-2 Jina file upload), `LowQualityExtractionError`, `needsAiCleanup` flag, and the `pendingConfirmation` dialog in the cleanup banner. The legacy `extraction_tier='pdfjs'|'jina'` articles are left as-is.

### Added

- **PDF Import (Phase 2 — Mistral OCR)**: Replace Claude-based PDF AI cleanup with Mistral OCR (`mistral-ocr-latest`); 1000-page limit (up from 200), no confirmation gate; `callMistralOcr()` in `src/lib/mistral-ocr.ts` posts PDF as base64 data URI; markdown response converted via `marked` + `postProcessHtml({ isPdfContext: true })`; two new post-processor passes: `stripPageNumbers` (page-number `<p>` removal) and `stripRepeatingHeaders` (running header/footer dedup, ≥3 occurrences); `recordPageBasedUsage()` added to `ai-usage.ts` for per-page cost tracking; `PAGE_BASED_PRICING` added to `pricing.ts`; `pagesProcessed` column added to `ai_usage` table (migration 0018); `extraction_tier` value `claude` → `mistral`; `mistral_api_key` added to encrypted settings with UI field and test-connection button; `AiCleanupBanner` simplified — confirmation dialog removed; `ExternalServiceError` gains `statusCode` field

- **PDF Import (Session 7 — upload UI)**: `/upload` page with `UploadPdfForm` (drag-drop, keyboard accessible, 50MB client-side check, redirect on success/duplicate); `PdfDropZone` client island on home page with document-level drop activation and non-PDF drop error; `useHandlePdfUpload` shared hook (`src/lib/use-pdf-upload.ts`) eliminates upload logic duplication; `validatePdfUpload()` + `isPdfFile()` + `MAX_UPLOAD_BYTES` extracted to `src/lib/upload-validation.ts`; `uploadPdf()` helper in `article-api.ts` with network-error handling; `ArticleCard` gains `FileText` PDF icon badge and `text-destructive` "No text extracted" indicator for `extractionTier === 'failed'`; Upload icon link added to sidebar header (scope extension beyond spec); `docs/architecture.md` §16.2 CSP corrected to include `worker-src 'self' blob:` (missing since Session 5); README "Importing PDFs" section added; 12 unit tests

- **PDF Import (Session 6 — Claude AI cleanup)**: PDF branch in `POST /api/ai/clean` sends raw PDF bytes as a native Claude document block; page-count guards (>200 pages → 422, >100 or unknown → `requiresConfirmation` response requiring `confirmed: true`); `aiCleanupAvailable` flag computed via `fs.stat` in the reader RSC page (file > 32MB → button disabled before click); `'ai_clean_pdf'` feature added to `AI_USAGE_FEATURES` and `aiUsage` schema enum; `callClaudeWithDocument()` added to `src/lib/ai.ts`; `cleanArticleSchema` extended with `confirmed?: boolean`, `revertArticleSchema` split out; revert blocked server-side for PDF articles (guard in `POST /api/ai/revert`); `AiCleanupBanner` extended with "No text detected" variant for `extractionTier === 'failed'` and inline confirmation dialog for long PDFs; `detectFormattingIssues()` gains `pageCount` param and two new PDF signals (`scoreLowTextPerPage` +20, `scoreShortParagraphDensity` +15); `MAX_PDF_BYTES_FOR_CLAUDE` exported from `pdf-storage.ts`; 7 integration tests + 8 unit tests

- **PDF Import (Session 5 — reader view)**: inline PDF viewer (`PdfViewer`) using react-pdf with lazy page rendering (IntersectionObserver), responsive width (ResizeObserver), text layer for native selection; "Original PDF" toggle persisted per-article in localStorage via `useSyncExternalStore`; page count shown in article cards, inbox, and reader header via extended `readingTime(wordCount, pageCount)`; `worker-src 'self' blob:` added to CSP; localStorage toggle store extracted to `createPersistedToggleStore` factory (`src/lib/local-storage-toggle.ts`); `pageCount`, `originalFilePath`, `extractionTier` added to GET /api/articles SELECT; E2E test covering upload → page count → toggle → text selection → toggle back
- **PDF Import (Session 4 — HTTP routes)**: `POST /api/upload` (multipart PDF upload with 50 MB limit, SHA-256 dedup, 422 for encrypted PDFs); `GET /api/articles/[id]/original` (RFC 7233 Range-request streaming); PDF branch in `POST /api/articles/parse` (magic-byte detection on prefetched buffer, cross-flow dedup via `content_hash`); `scheduleConceptIndex` helper extracted to `ai.ts`; `isPdfCleanupNeeded` extracted to `content-quality.ts`; `sanitizeTitle` added to `text-utils.ts`; network-error fallback in parse route preserves Jina path; 26 integration tests
- **PDF Import (Session 3 — extraction engine)**: `pdf-extractor.ts` with Tier 1 (pdfjs-dist in-process text extraction) and Tier 2 (Jina Reader file-upload fallback) cascade; paragraph reconstruction heuristic; quality threshold; `EncryptedPdfError`, `LowQualityExtractionError`, `ParsingError` error classes; `safeFetch` extended with `method`/`body` options for POST support; binary PDF test fixtures + 28 unit tests
- **PDF Import (Session 2 — storage layer)**: storage layer + magic-byte validation (`pdf-storage.ts`, `validatePdfMagicBytes`) — utility foundation for Session 3 extractor and Session 4 upload route
- **PDF Import (Session 1 — schema)**: extend DB schema for PDF ingestion — add `upload` source type, `original_file_path`, `page_count`, `extraction_tier` columns to articles; migration `0016_special_silver_surfer.sql`

### Fixed

- **PDF tables missing from Mistral OCR output**: `MistralOcrPage.tables` was typed as `{ id; content }` but the Mistral API returns `{ id; html }`. Every table lookup returned `undefined`, leaving marker links in place of rendered tables. Fixed field name in interface, splicer, and test fixtures.

- **Math equations in reader view**: LaTeX equations extracted by Mistral OCR (e.g. `$E = mc^2$`, `$$\int_0^\infty$$`) now render as formatted math in the reader. KaTeX auto-render is lazy-loaded and runs after the article HTML is mounted; supports `$`, `$$`, `\(`, `\[` delimiters; `throwOnError: false` so malformed equations fall back to raw text. Applies to both the reader view and the TTS immersion reading view (both use `ArticleContent`).

- **PDF Import (Session 10 — Mistral OCR quality params)**: Enable `extract_header: true`, `extract_footer: true`, `table_format: 'html'`, and `image_min_size: 100` in Mistral OCR requests. Running headers/footers are now extracted to separate per-page fields and discarded from article body (previously landed in body text). HTML tables with `colspan`/`rowspan` are preserved verbatim in reader content; `appendPageTables()` replaces positional markers (`[tbl-N](tbl-N.html)`) with actual HTML at the correct position, with an append fallback for unmatched tables. `colspan` and `rowspan` added to DOMPurify `ALLOWED_ATTR`. Per-page processing pipeline in `POST /api/ai/clean` replaces flat markdown join. `MISTRAL_IMAGE_MIN_SIZE = 100` constant added to `mistral-ocr.ts`. `MistralOcrPage` interface exported. `stripPageNumbers`/`stripRepeatingHeaders` retained as defensive backstops.

- **PDF Import (Session 9 — Mistral OCR images)**: Images embedded in Mistral OCR responses are now extracted, saved to `data/originals/images/<sha256>/`, and served via `GET /api/articles/[id]/images/[name]` (immutable, 1-year cache). Markdown `![alt](img-N.ext)` references are rewritten to point at the new endpoint; orphan refs (names not stored) are stripped. Re-running AI cleanup overwrites stale images atomically. Article deletion now cleans up both the source PDF and all associated images. `isValidPdfImageName` guards against path traversal with a strict allowlist regex.

- **PDF Import — post-review hardening**: (1) `POST /api/articles/parse` now propagates the prefetched response's `ok` flag to `parseArticleFromUrl` so non-2xx HTML error pages trigger the Jina fallback again (regression introduced in Session 4 vs the `bd94f51` security fix). (2) `GET /api/articles/[id]/original` clamps explicit `bytes=N-M` `end` to `total - 1` per RFC 7233 — react-pdf and other range-aware clients previously saw inflated `Content-Length` headers when requesting past EOF. (3) `POST /api/ai/clean` PDF branch now derives `contentText` (via `stripHtml`) and `wordCount` from the cleaned HTML so FTS5 search, TTS, and reading-time labels reflect the Claude re-extraction. (4) `POST /api/articles/parse` no longer reads up to 50 MB into memory for non-PDF URL saves — the prefetch cap is 5 MB by default and only escalates to 50 MB for `.pdf` URLs or `application/pdf` content-type responses. (5) `parseArticleByUrl` now propagates `existingId` from 409 responses so the save page can deep-link to the existing article.

- **P0 SSRF bypass via Jina fallback** — `parseArticleFromUrl` now validates the URL before the try/catch block so a `ValidationError` for private/blocked URLs propagates to the caller instead of being swallowed and re-attempted via Jina Reader. Also fixed `safeFetch` to follow redirects manually (`redirect: 'manual'`) and SSRF-validate each `Location` hop, capped at 3 redirects. Additionally `validateHostname` now blocks literal private IP addresses (e.g. `10.x.x.x`) directly without requiring DNS resolution.

- **AI Reformat truncation** — `POST /api/ai/clean` now raises `max_tokens` from 8192 → 32768 and checks `stop_reason`; if Claude truncates the output it returns HTTP 422 and leaves `content_html` unchanged instead of silently overwriting the article with partial content.

### Added

- **AI Usage Tracking (Module 17, UI)** — `UsageFooter` in sidebar shows monthly spend + optional budget progress bar; clicking links to Settings → Usage. `UsageSection` in Settings adds time-range selector (Today/7d/30d/All time), spend header card, budget input, by-feature and by-model breakdown tables, and top-calls table. `SettingsSidebar` gains "Usage" nav item. `settings-page.tsx` respects `?tab=usage` URL param (used by sidebar footer link).

- **AI Usage Tracking (Module 17, API routes + pub-sub)** — Six new routes under `/api/usage/`: `summary` (spend + budget), `breakdown` (by feature or model), `top-calls` (most expensive, limit 1-50), `runs/[runId]` (multi-call operations), `estimate` (pre-flight cost), `budget` (GET + PATCH). `src/lib/usage-events.ts` exports `emitUsageChanged()` for cross-tree pub-sub via native DOM CustomEvent. Chat and draft streaming routes emit `emitUsageChanged()` on completion. 25 new integration tests.

- **AI Usage Tracking (Module 17, wiring)** — All 19 `callClaude` and `callClaudeStreaming` call sites now pass a `TrackingContext` (`{ feature, resourceType?, resourceId? }`). `callClaude`'s former `purpose` string param replaced by required `ctx: TrackingContext` (intentional refactor). `callClaudeStreaming`'s `StreamParams` similarly gains required `ctx`. `extractKeywords` gains optional `sessionId?: number` (one-off; future utilities should accept `TrackingContext` directly). Every AI call now writes a row to `ai_usage` automatically.

- **AI Usage Tracking (Module 17, trackAiCall)** — New `src/lib/ai-usage.ts` with `trackAiCall<T>` generic wrapper that writes to `ai_usage` on both success and error (DB insert in finally; failure swallowed so it never masks the original SDK error). Error classification via `instanceof` on SDK error classes: `rate_limit`, `timeout`, `network`, `api_error`. Partial usage extraction from error body for rate-limit responses. `newRunId()` for grouping multi-call operations. 8 unit tests. TECH_DEBT entry added for `web_search_count` (always 0 until SDK exposes the field).

- **AI Usage Tracking (Module 17, pricing)** — New `src/lib/pricing.ts` with `MODEL_PRICING` rate card (Opus 4.7/4.6, Sonnet 4.6, Haiku 4.5), `computeCost()`, `aggregateCost()`, and `estimateCost()` for pre-flight cost estimation. Costs computed at read time — no cost column in DB. 9 unit tests.

- **AI Usage Tracking (Module 17, schema + types)** — New `ai_usage` table (migration 0015) with 16 columns tracking every Anthropic API call: feature, model, status, token counts (input/output/cache read/cache write), web search count, run ID (for multi-call grouping), loose resource reference, and duration. Three indexes on `created_at`, `feature`, and `run_id`. New `AiUsageFeature` and `AiUsageResourceType` types in `src/types/index.ts`. New `monthly_budget_usd` setting key added.

- **Draft model selection** — Users can now choose the Claude model (Haiku 4.5, Sonnet 4.6, Opus 4.7) when creating a draft (step 2 of the picker dialog) and can change it on the draft editor page. The selected model is persisted in a new `drafts.model` column (migration 0014) and used for all generation calls, replacing the previously hardcoded Sonnet 4.6.

- **Content Templates (Module 16)** — Turn a thesis into a publishable draft by combining a channel-specific template (blog, LinkedIn, YouTube) with the user's voice profile. Full implementation: `drafts` table with cascade-delete from theses (migration 0013); types, Zod schemas, and template library with opinionated `instructions` prose for each channel; `generateDraft()` async-generator pipeline that assembles system prompt (voice profile + matched samples + template instructions) and user prompt (claim + highlights by role + research + optional angle steer), streams via Claude Sonnet 4.6, and persists on completion; five CRUD routes (`POST /api/drafts`, `GET /api/drafts`, `GET/PATCH/DELETE /api/drafts/[id]`) with Zod validation and Drizzle queries; SSE generation endpoint (`POST /api/drafts/[id]/generate`) with 409 guard for regeneration after manual edits; thesis-page Drafts section with two-step picker dialog (template → context/angle selection); `/drafts/[id]` editor with streaming live-fill, debounced auto-save, preview toggle, regenerate with force-confirm, copy markdown/HTML, status toggle, and delete; cross-thesis `/drafts` list page with template and status filters; publishing auto-advances parent thesis to `used`; E2E happy-path test covering the full create → stream → publish → delete flow via mocked SSE. 89 unit and integration tests total.

- **Voice Profile (Module 15)** — New `/settings` → Voice tab for managing a structured writing voice profile. Adds `voice_profile` and `voice_samples` tables. CRUD API routes (`GET/PUT /api/voice/profile`, `POST /api/voice/profile/extract`, `GET/POST /api/voice/samples`, `PATCH/DELETE /api/voice/samples/[id]`). AI-powered extraction via Claude Sonnet analyzes ≥3 writing samples and produces an 8-dimension markdown profile (rhythm, vocabulary, argument construction, anti-patterns, etc.). UI includes a markdown viewer/editor, sample cards with word count and tags, file upload (.txt/.md), and inline edit/delete. Settings page restructured with left sidebar navigation (General / Integrations / Voice). Shared `renderMarkdown()` utility extracted from chat pipeline for reuse by the voice profile editor.
- **Vitest pool switched to `forks`** — fixes a worker thread initialization hang when running `voice-extraction.test.ts` in isolation, and incidentally stabilizes feed-poller unit tests.

### Added

- **Knowledge Linting (Module 14 Phase 3)** — New `POST /api/chat/lint` SSE endpoint runs four on-demand health checks across the knowledge base: **connections** (hybrid topic clustering of unlinked highlights via `aiIndex` topics, then Haiku validation), **contradictions** (Haiku-detected note conflicts plus auto-explained supporting/opposing thesis pairs), **gaps** (per-thesis Haiku gap analysis for `developing`/`researched` theses), and **stale** (pure SQL: neglected theses, stuck reading articles, overdue mature highlights). New collapsible "Knowledge Health" panel above the chat session list streams suggestions with action buttons (create thesis, review, resume, etc.). Daily review cards gain an "Explore" link that opens a prefilled `/chat/new` scoped to the highlight's parent article. All LLM calls use Haiku. Shared types `LINT_CHECKS`, `LintCheck`, `LintSuggestion` in `src/types/index.ts`. New `assertHighlightsExist` helper in `src/lib/db-helpers.ts`. `POST /api/theses` now optionally accepts `highlightIds` and links them transactionally.
- **Deterministic HTML post-processor for all ingestion paths** — Extracted shared transforms (tracking pixel removal, empty element stripping, layout table unwrapping, consecutive image grid wrapping, redundant wrapper collapse) from `email-preprocessor.ts` into new `src/lib/html-post-processor.ts`. Now runs on URL-parsed articles, Readwise imports, and newsletters (previously email-only). New `wrapConsecutiveImages` transform wraps 4+ consecutive `<img>` elements in `<div class="image-grid">`.
- **Content pipeline Phase 3: AI cleanup on demand** — New `detectFormattingIssues()` heuristic in `src/lib/content-quality.ts` scores article HTML (0–100) for layout issues (consecutive images, empty elements, layout tables, high markup ratio, newsletter bonus). Articles scoring ≥50 show a subtle "Reformat with AI" banner in the reader view. `POST /api/ai/clean` sends article HTML to Claude Haiku for reformatting, sanitizes the output, and stores the cleaned content. `POST /api/ai/revert` re-runs Defuddle on stored `content_original_html` to restore original extraction. Banner and revert option appear in both regular and newsletter reader views.
- **Content pipeline Phase 2: email preprocessing + original view** — New `preprocessEmailHtml()` in `src/lib/email-preprocessor.ts` cleans raw email HTML before extraction: strips MSO conditionals, removes tracking pixels (1×1 dimensions or known tracking domains), collapses spacer elements, and unwraps layout tables (`role="presentation"` or 3+ nesting levels). Integrated into newsletter IMAP poller between raw storage and DOMPurify sanitization, so `content_original_html` always preserves the untouched email. Newsletter articles in reader view now show an "Original" toggle button that renders the raw email HTML (re-sanitized via DOMPurify); highlighting is disabled in original view and the preference is persisted per source in localStorage.
- **Content pipeline unification (Phase 1)** — Jina Reader API path now uses `x-respond-with: html` and runs through the same Defuddle → DOMPurify extraction pipeline as the direct-fetch path. Three new columns on `articles`: `content_original_html` (raw pre-extraction HTML for all sources), `content_markdown` (turndown-converted markdown for AI context), `ai_cleaned_at` (reserved for Phase 3). All AI features (`summarize`, `tag`, `explain`, `index`, `chat`) now prefer `content_markdown` over `content_text`. Backfill script: `npx tsx scripts/backfill-content-markdown.ts`.

### Fixed

- **Progress bar not resetting when "Reset progress" is clicked** — the visual bar stayed at the current scroll position when `article.readingProgress` was already `0` in context (e.g. first reading session before the first save). Fixed by introducing a `progressResetKey` counter in `ArticleContext` that increments on each reset; `ReadingProgressBar` detects the change via derived-state-during-render and zeroes the bar immediately. Also removed dead `clearPendingUpdates` / `forceUpdate` / `scrollHandlerEnabled` code from the reader components, and converted the scroll-to-top effect in `ArticleReader` to use `progressResetKey` so it no longer fires on every context re-render when progress is 0.
- **"Reformat with AI" always returns "External service unavailable"** — Anthropic SDK timeout was 30s, too short for large-content cleanup calls (up to 100K chars input + 8192 output tokens). Increased to 120s.
- **Newsletter and RSS polling stops after server restart** — added `src/instrumentation.ts` (Next.js startup hook) so `initFeedScheduler` and `initNewsletterScheduler` run on every server start, not only when settings are saved.
- **Newsletter pending articles no longer visible** — `GET /api/articles` now always excludes `pending_review` articles; previously clicking the "All" tab surfaced newsletter emails from unapproved senders.

### Added

- **Home page redesign** — `/` now shows a Reading row (horizontal scroll of in-progress articles with progress bar and time remaining) and an Inbox preview (10 most recent articles with "See all →" link). Full paginated inbox moved to `/inbox`. Sidebar gains a "Home" item and all Library/feed links updated to point to `/inbox`.
- **Newsletter IMAP config moved to Settings UI** — IMAP credentials and poll interval are now configured at `/settings` → "Newsletter (IMAP)" instead of env vars. Includes Test Connection button, Poll Now shortcut, TLS toggle, and incomplete-config warning. New `POST /api/settings/test-imap` endpoint validates connectivity and returns mailbox list.
- **Dynamic RSS and IMAP poll intervals** — changing `rss_poll_interval` or `imap_poll_interval` in Settings now immediately restarts the respective cron scheduler without an app restart.
- **`validateHostname()` utility** — extracted shared SSRF hostname validation from `url-validator.ts` for reuse across HTTP and IMAP connection paths.

### Removed

- `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD` environment variables — replaced by encrypted DB-backed settings.

- **Module 14: Knowledge Chat (Phase 2)** — scoping + filing actions for the knowledge chat
  - Three new chat scopes: `thesis:{id}` (thesis + linked highlights grouped by role + research entries), `tag:{name}` (tagged highlights + parent articles), `recent:{days}` (articles saved in last N days)
  - Filing actions API: `POST /api/chat/[id]/file` — save as thesis, add research to existing thesis, annotate highlight, bookmark messages
  - Filing UI: action dropdown menu on assistant messages (hover-visible) with dialogs for thesis creation, thesis selection, and highlight annotation
  - Searchable scope selector for new chats with thesis/tag dropdowns fetched from API
  - "Chat about this thesis" button on thesis detail page → scoped chat session
  - "Chat about this" icon on highlight cards → article-scoped chat with pre-filled question
  - Thesis citation support: `[thesis:ID]` markers validated and rendered as clickable links
  - New `bookmarked_at` column on `chat_messages` for message bookmarking
  - URL-based scope/prefill for `/chat/new?scope=thesis:5&prefill=...`
- **Knowledge Chat: model selector** — per-session Anthropic model selection (Haiku 4.5 / Sonnet 4.6 / Opus 4.6) stored on `chat_sessions.model`; token budgets are now percentage-based per model context window; utility calls (keyword extraction, title generation) hardcoded to Haiku
- **Module 14: Knowledge Chat (Phase 1)** — conversational Q&A across the reading knowledge base with FTS5 retrieval + LLM synthesis
  - Chat sessions with `all` and `article:{id}` scoping
  - Two-stage retrieval: LLM keyword expansion (Claude) → FTS5 search across `articles_fts` (with `ai_index`) + `highlights_fts` → context assembly with token budget management
  - Streaming responses via SSE with citation markers `[article:N]`, `[highlight:N]` validated against DB
  - Auto-title generation after first exchange (sent as `event: title` SSE event for live UI update)
  - Conversation history sliding window (first 2 + last 6-8 messages) for long conversations
  - Full CRUD: `POST /api/chat` (create + stream), `POST /api/chat/[id]` (send + stream), `GET /api/chat`, `GET /api/chat/[id]`, `PATCH /api/chat/[id]`, `DELETE /api/chat/[id]`
  - Chat UI: `/chat` session list, `/chat/new` new conversation, `/chat/[id]` conversation view with streaming, citation chips, markdown rendering
  - New schema tables: `chat_sessions`, `chat_messages`; FTS5 table `chat_messages_fts`
  - Sidebar navigation item (Chat after Theses)
- **Module 14 (partial): Article concept index** — new `ai_index` column on `articles`; `POST /api/ai/index` to generate a structured concept index (topics, entities, arguments, related concepts) per article; `POST /api/ai/index/backfill` SSE endpoint for batch-indexing existing articles; `articles_fts` rebuilt to include `ai_index` so FTS5 search automatically matches concept-level terms; auto-trigger in the parse route generates the index after each new article save
- **Readwise Import (Reader API)** — rewrote import to use Readwise Reader API (`/api/v3/list/?withHtmlContent=true`); articles now include inline HTML content without additional fetching; highlights imported as child documents with `parent_id` linkage; incremental sync via `updatedAfter`; dedup by `externalId` and URL; tag mapping; SSE progress streaming; encrypted token storage in Settings; Test Connection button; last-synced display
- **Module 13: Thesis Tracker** — bridge between highlights and publishing with structured arguments
  - Thesis CRUD with status workflow (nascent → developing → researched → ready → used)
  - Highlight-to-thesis linking with role tagging (supporting / opposing / context)
  - Research entries per thesis (manual or AI-generated)
  - AI-powered thesis suggestions from unlinked highlights (`POST /api/theses/suggest`)
  - AI-powered highlight suggestions for an existing thesis (`POST /api/theses/[id]/suggest-highlights`)
  - Auto-advancement: nascent→developing when claim added or first highlight linked; developing→researched when first research entry added
  - FTS5 full-text search across title, claim, counterarguments, implications, notes
  - "Link to thesis" action added to daily review cards
  - Theses sidebar navigation item
  - New pages: `/theses`, `/theses/new`, `/theses/[id]`, `/theses/suggest`
  - New schema tables: `theses`, `thesis_highlights`, `thesis_research`; added `thesis_id` column to `highlights`

### Fixed

- **Sidebar toggle on reader page** — the hamburger button to open the left panel now displays on the reader page (`/reader/[id]`) on desktop; remains hidden on mobile as intended

- **Appearance mode setting** — choose between Automatic (system preference), Light, and Dark in Settings › Appearance; preference persisted in DB and `localStorage` for FOUC-free page loads

- **Settings system** — DB-backed settings with AES-256-GCM encryption for API keys, admin UI at `/settings` with collapsible sections, password-protected secret updates, API key test connections, auto-migration from `.env`, in-memory cache, and audit log. Designed for future multi-user support.
- **TTS audio caching** — cache synthesized audio to disk (`/data/tts-cache/`) to avoid re-calling Inworld API for previously listened articles, with 5 GB LRU eviction, cache stats endpoint (`GET /api/tts/cache`), and automatic cleanup on article deletion
- **TTS resume from last position** — save playback position on pause/stop and offer "Resume where you left off" prompt when returning to the same article
- **Module 12: Text-to-Speech with Immersion Reading** — listen to articles with real-time word highlighting
  - Inworld TTS API integration with streaming audio via SSE
  - Word-by-word highlighting synced to audio playback (blue highlight)
  - Playback controls: play/pause, skip ±15s, speed 0.5x–1.5x, keyboard shortcuts (P, arrows, comma/period)
  - Gapless paragraph-to-paragraph audio buffering via Web Audio API
  - Auto-language detection (English/French) with per-language default voices
  - Feature gracefully hidden when `INWORLD_API_KEY` is not configured
- **Sidebar navigation**: retractable left sidebar replaces per-page header nav, with push animation, swipe gestures, keyboard shortcut (Cmd/Ctrl+\), and auto-hide in reader view
- **Emails filter**: sidebar "Emails" item filters inbox by newsletter source type; hover menu links to newsletter management
- **Sidebar save button**: "+" button in sidebar header opens save-article-by-URL modal; removed from article list
- **Reader view**: restore scroll position when returning to a partially read article
- **Module 11: Newsletter Email Ingestion** — receive newsletters as articles via IMAP polling
  - IMAP mailbox polling every 5 minutes (configurable via `IMAP_HOST` env vars)
  - Allowlist mode: new senders are held in pending state until approved via UI
  - Pending articles hidden from inbox; moved to inbox on approve, deleted on block
  - Newsletter management page at `/newsletters` with status tabs (All/Approved/Pending/Blocked)
  - Block/unblock/approve newsletter senders via `PATCH /api/newsletters/[id]`
  - List newsletter sources with article counts and pending badge via `GET /api/newsletters`
  - Manual poll trigger via `POST /api/newsletters/poll`
  - Duplicate detection via email Message-ID
  - HTML email sanitization through DOMPurify (same pipeline as article parser)
  - Plain text email support (wrapped in `<p>` tags)
  - Large email protection (>5MB skipped)
  - Extracted `stripHtml` and `truncate` utilities to shared `text-utils.ts`
- **Module 10: Mobile Save** — save articles from mobile devices
  - Save page (`/save`) with URL input, auto-save from `?url=` query param, and status feedback
  - PWA manifest with Android Web Share Target — install as app to get native share sheet integration
  - iOS Shortcut setup instructions on the save page (browser-based and advanced API-direct options)
  - Improved URL-only parsing: direct server-side fetch + Defuddle first (richer metadata), Jina Reader API fallback for JS-heavy/bot-protected pages
  - SPA shell detection to avoid parsing empty mount points (falls back to Jina)
  - Minimal service worker for PWA installability (fetch passthrough, no caching)
  - PWA metadata in layout (manifest, theme-color, apple-web-app)

### Fixed

- **TTS**: fix word highlighting drift and duration display jump with real Inworld API — timestamps were double-offset across multi-chunk NDJSON responses
- **TTS**: improve initial duration estimate using word count (~150 WPM) instead of blanket 30s/paragraph
- Fix jsdom peer dependency conflict: add npm overrides so defuddle uses the project's jsdom@28 instead of requiring jsdom@24
- Fix flaky e2e tests: use unique titles and ID-based locators in save-and-read tests, increase waitForMarks timeout for parallel load, add local retry for SQLite contention

### Changed

- Replace @mozilla/readability + linkedom with Defuddle + jsdom for article extraction (cleaner output on complex sites like Le Monde)
- Rename "Done" button to "Read" in reader toolbar
- Add basic auth support to browser extension (username/password in options)
- Rework highlight system: text selection immediately creates a highlight and enters edit mode with draggable handles and popover (replaces old select-mode toolbar flow)
- Exit edit mode (click outside or Escape) saves changes via PATCH (preserves highlight ID, creation date, review history, tags) instead of delete+create
- Overlapping highlights auto-merge with union range, combined notes, and 5-second undo toast
- Mobile: auto-creates highlight on selection via `selectionchange` (replaces floating "Highlight" button)
- Remove 'h' keyboard shortcut (unnecessary since selection auto-creates)
- Remove select-mode toolbar (`select-mode-toolbar.tsx`) — replaced by popover in edit mode
- Remove unused highlight color styles (green, blue, pink) from CSS — only yellow is used

### Added

- Desktop: selection handles appear on highlight hover (col-resize cursor); dragging a handle enters edit mode and saves on release
- Undo toast component for merge operations with auto-dismiss
- PATCH support for `text` and `positionData` fields on highlights API
- Auto-scroll when dragging selection handles near viewport edges (40px zone, 2-8px/frame)
- Draggable selection handles at start/end of highlight in edit mode, enabling precise boundary adjustment on both desktop and mobile
- Mobile: custom selection handles appear when tapping existing highlights in edit mode
- Mobile: popover displays vertically on right edge of screen; pending selection shows popover before highlight creation
- Mobile: long-press selection allows adjustment before confirming; tapping outside saves without entering edit mode
- Mobile: tap between lines of multi-line highlights enters edit mode (bounding box hit-testing)
- Article text uses muted colors (#616c77 light / #c1c7ce dark); highlighted text uses full black/white for contrast
- Selection handles styled yellow with larger grip for better visibility

### Fixed

- `validateUrl` now blocks IPv6 loopback `[::1]` (was bypassing SSRF check due to bracket-wrapped hostname)
- ReviewCard missing `key` prop causing React state to persist across card transitions

### Refactored

- Extract `getHighlightMarks()` utility — consolidates 7 inline mark queries
- Extract `getElementsBoundingBox()` and `createRangeFromMarks()` to shared utils
- Remove duplicate `ReviewAction` type from `spaced-repetition.ts` (canonical definition in `@/types`)
- Extract `isMobileDevice` constant to `src/lib/is-mobile.ts`
- Fix `express-rate-limit` high vulnerability in shadcn devDependency (8.2.1 → 8.3.0)

### Added

- Unit tests for `url-validator.ts` — SSRF prevention (blocked hosts, private IP ranges, protocol validation)
- Unit tests for `sanitize.ts` — XSS prevention (allowed/forbidden tags, event handlers, data attributes, javascript: URIs)
- Unit tests for `search.ts` — FTS5 query escaping (special characters, quotes, edge cases)
- Unit tests for `text-utils.ts` — word count, reading time, date formatting
- Unit tests for `api-error-handler.ts` — error type to HTTP status mapping, info leak prevention
- SessionStart hook auto-creates `.env`, data directory, and runs DB migrations for Claude Code web sessions
- Playwright config auto-detects Chromium binary in sandboxed/web environments
- E2E tests for save-and-read critical journey: inbox appearance, reader view, status update, highlight persistence
- E2E tests for highlight search critical journey: FTS5 search for highlights and articles, combined type=all search
- E2E tests for daily review critical journey: card reveal/action flow, spaced repetition interval mechanics
- E2E tests (`npx playwright test`) now mandatory in every session's pre-commit verification
- Documentation freshness check added to mandatory pre-commit steps (API, schema, setup, module behavior)

### Changed

- Full documentation audit (pass 2): updated `architecture.md` §5 (added `highlight_tags` junction table, `etag`/`last_modified` source columns), §6 API routes (added 8 undocumented routes: `/articles/parse`, `/feeds/poll`, `/highlights/bulk-delete`, `/highlights/bulk-tag`, `/ai/explain`, `/sources/[id]`, `/tags/[id]`, `/health`), §11 testing (updated test pyramid counts, file inventory to match 16 unit + 11 integration + 4 E2E actual files)
- Updated all 7 module specs to match implementation: `article-parser.md` (Jina Reader pipeline, 60s timeout, `marked` dependency), `reader-view.md` (auto-highlight on selection, select-mode toolbar, yellow-only, additional components), `data-layer.md` (yellow-only colors, monotonic reading progress), `rss-engine.md` (batch dedup, concurrency guard, `safeFetchText`), `ai-features.md` (`cached` field in summarize response), `browser-extension.md` (plain JS, test location), `highlight-library.md` (yellow-only color filter)
- Full documentation audit (pass 1): updated CLAUDE.md Module Registry (all modules now reflect actual status), README.md (features list, setup steps, env vars), project structure (all 21 lib files documented, all API routes including sub-routes), removed unused `SENTRY_DSN` from `.env.example`

### Fixed

- Reader view: creating multiple highlights in sequence failed because `adjustingRef` was only cleared asynchronously via `useEffect`; now cleared synchronously in `cancelAdjusting()`

### Previous

- Reader view: auto-highlight on text selection — selecting text immediately creates a highlight and shows the select mode toolbar (confirm/delete), replacing the old yellow button popover
- Reader view: double-click (desktop) or double-tap (mobile) on a paragraph to highlight the entire block with yellow, then enter select mode to adjust boundaries
- Reader view: click an existing highlight to enter select mode — adjust start/end, then click outside to cancel or press Escape to cancel
- Reader view: select mode toolbar now shows a delete (trash) button to remove the highlight directly
- Reader view: select mode toolbar positioned to the right of the highlighted text with vertical button layout; selection persists through scrolling with viewport-clamped positioning on both axes
- Reader view: yellow `::selection` color during select mode for consistent visual feedback across browsers
- E2E tests for highlight feature: text selection, double-click paragraph, select mode, color change, persistence, keyboard shortcut, multiple highlights
- E2E tests for mobile touch double-tap: native selection, toolbar-driven highlight creation, no-duplicate on existing highlight

### Fixed

- Reader view: double-tap on mobile Android now uses native text selection (with system handles) instead of immediately creating a highlight, letting users adjust the selection before highlighting
- Highlight library: add AbortController to cancel stale fetch requests on rapid filter/page changes, with unmount cleanup
- Highlight library: "Load more" button now shows loading state via dedicated `isLoadingMore` (no longer shares `isPending` with filter transitions)
- Inbox article list now refreshes on mount to pick up status changes (e.g., un-archiving) made during client-side navigation
- Highlight library now refreshes on mount to pick up changes made during client-side navigation

### Changed

- Extract `useRefreshOnMount` hook (`src/hooks/use-refresh-on-mount.ts`) — shared mount-refetch logic for article list and highlight library
- Reading progress bar is now monotonic — only increases, never decreases when scrolling back up; API also enforces server-side guard
- Archive/unarchive button in reader view now toggles instead of disappearing when archived

### Added

- Favorites tab in inbox: filter articles by favorite status with heart icon indicator on article cards

- Initial project scaffold (Next.js 14+, TypeScript strict, Tailwind CSS, shadcn/ui)
- Database schema with Drizzle ORM (sources, articles, highlights, tags)
- Health check API endpoint
- Project tooling: ESLint, Prettier, Vitest, Playwright
- Boilerplate utilities: logger, sanitizer, URL validator, FTS5 escaping, error classes
- Test infrastructure: MSW mocks, fixtures, integration test DB factory
- **Module 1: Data Layer + API**
  - FTS5 virtual tables (`articles_fts`, `highlights_fts`) with automatic sync triggers
  - Zod validation schemas for all API inputs (`src/lib/validators.ts`)
  - Articles CRUD: POST, GET (list/filter/paginate/sort), GET by ID (with highlights), PATCH, DELETE
  - Highlights CRUD: POST (with tag linking), GET (list/filter), PATCH (note/color/tags), DELETE
  - Sources CRUD: GET (list all), POST, DELETE (articles preserved)
  - Tags: GET (with highlight counts), POST (unique name enforcement)
  - Full-text search via FTS5: search across articles and highlights with type filtering
  - 93 tests (31 unit + 62 integration) covering all endpoints and edge cases
- **Module 2: Article Parser**
  - Article parser library (`src/lib/article-parser.ts`) using @mozilla/readability + linkedom
  - Two entry points: `parseArticleFromUrl()` (fetch + parse) and `parseArticleFromHtml()` (parse only)
  - Relative URL resolution (img src, a href) after Readability extraction, before DOMPurify sanitization
  - Metadata extraction from meta tags (author, published_time, og:image, og:site_name)
  - SSRF-validated fetching with 10s timeout, 5MB size limit, HTML-only Content-Type check
  - API route `POST /api/articles/parse` — parse URL and save article (idempotent on URL)
  - Browser extension support: accepts pre-fetched HTML for paywalled content
  - 27 tests (18 unit + 9 integration) covering parsing, sanitization, edge cases, and API
- **Module 3: RSS Feed Engine**
  - Feed poller library (`src/lib/feed-poller.ts`) — polls RSS/Atom feeds, deduplicates by URL, saves new articles
  - `pollFeed(source)` — polls a single feed with ETag/Last-Modified conditional headers for efficiency
  - `pollAllFeeds()` — finds and polls all feeds that are due based on their `pollInterval`
  - Feed scheduler (`src/lib/feed-scheduler.ts`) — node-cron job running every minute, polls due feeds automatically
  - API route `POST /api/feeds/poll` — manual poll trigger (all due feeds or specific sourceId)
  - SSRF validation on all feed URLs before fetching
  - Graceful error handling: continues polling remaining feeds/items when one fails
  - 304 Not Modified support for bandwidth efficiency
  - Module spec at `docs/modules/rss-engine.md`
  - 34 tests (26 unit + 8 integration) covering polling, dedup, error handling, scheduling, and API

- **Module 4: Reader View — Highlighting**
  - Highlight anchoring library (`src/lib/highlight-anchoring.ts`) — DOM range serialization/deserialization using child-index paths
  - Position data format: `{ startContainerPath, startOffset, endContainerPath, endOffset, text }` stored as JSON in `position_data` column
  - Text selection toolbar (`src/components/reader/selection-toolbar.tsx`) — floating color picker (yellow/green/blue/pink) on text selection
  - Highlight popover (`src/components/reader/highlight-popover.tsx`) — edit note, change color, delete on click
  - Highlight layer (`src/components/reader/highlight-layer.tsx`) — manages rendering, creation, and editing of highlights
  - DOM-based highlight rendering with `<mark>` elements, supporting same-element and cross-element ranges
  - Keyboard shortcut: `h` to highlight current selection with yellow
  - Client-side API helpers (`src/lib/article-api.ts`) — `createHighlight`, `deleteHighlight`, `updateHighlight`
  - Highlight styles in `globals.css` with light/dark mode support
  - Reader page fetches and passes highlights to highlight layer
  - 28 tests (20 unit + 8 integration) covering anchoring round-trips, position persistence, CRUD operations

- **Module 5: Highlight Library**
  - Enhanced `GET /api/highlights` — returns article context (title, url, siteName) and tags with each highlight
  - New filters: `sourceId` (filter by article source), `dateFrom`/`dateTo` (date range)
  - Bulk operations: `POST /api/highlights/bulk-delete` (delete up to 100 highlights), `POST /api/highlights/bulk-tag` (add/replace tags on up to 100 highlights)
  - Tag management: `PATCH /api/tags/[id]` (update name/color), `DELETE /api/tags/[id]` (with cascade)
  - Validation schemas for all new endpoints (`bulkDeleteHighlightsSchema`, `bulkTagHighlightsSchema`, `updateTagSchema`)
  - Library page (`/library`) — server-rendered with client-side interactivity
  - Highlight card component with color-coded border, article context, tag badges, expand/collapse
  - Filter bar: color toggle, tag filter, date range, sort options
  - Bulk selection with checkbox per highlight, bulk tag and bulk delete with confirmation
  - Empty state messaging
  - Module spec at `docs/modules/highlight-library.md`
  - 19 integration tests covering enhanced GET, bulk operations, tag CRUD, cascading

- **Module 6: Daily Review (Spaced Repetition)**
  - Spaced repetition library (`src/lib/spaced-repetition.ts`) — simplified SM-2 algorithm with configurable intervals
  - `calculateNextReview()` — "Got it" doubles interval, "Review again" resets to 1 day
  - `getDueHighlights(limit)` — queries highlights where interval has elapsed, random order, with article context and tags
  - API route `GET /api/review` — returns due highlights for review session (default 15, max 50)
  - API route `POST /api/review` — records review action, updates spaced repetition fields, returns remaining count
  - Review page (`/review`) — card-based review session with progress indicator
  - Review card with colored border, "Reveal source" button showing article title, site name, and user note
  - Session complete/empty states with navigation back to inbox
  - Zod validation schemas (`listReviewSchema`, `submitReviewSchema`)
  - Review link added to inbox and library navigation
  - Module spec at `docs/modules/daily-review.md`
  - 20 tests (7 unit + 13 integration) covering algorithm, API, edge cases

- **Module 7: AI Features**
  - Claude API integration library (`src/lib/ai.ts`) — singleton Anthropic client, system prompts, content truncation, response parsing
  - `callClaude()` — generic Claude API wrapper with structured logging, timeout (30s), and error handling
  - `truncateContent()` — truncates long articles to ~100K chars with notice
  - `parseTagsResponse()` — parses Claude's JSON tag suggestions with deduplication, case normalization, and robustness
  - API route `POST /api/ai/summarize` — summarize an article (cached in `ai_summary` column)
  - API route `POST /api/ai/tag` — auto-tag an article using existing tag vocabulary, creates new tags as needed
  - API route `POST /api/ai/explain` — explain or analyze importance of a highlighted passage
  - Zod validation schemas (`summarizeSchema`, `autoTagSchema`, `explainSchema`)
  - MSW-based integration tests with mock Claude API responses
  - Module spec at `docs/modules/ai-features.md`
  - 32 tests (13 unit + 19 integration) covering all endpoints, caching, error handling, edge cases

- **Module 8: Browser Extension**
  - Chrome extension (Manifest V3) in `extension/` directory — save articles with one click
  - Popup UI: auto-saves current page on open, shows status (Saved/Already saved/Error), link to reader view
  - Options page: configure API base URL, toggle "Send page HTML" for paywalled content, test connection
  - Background service worker: keyboard shortcut `Alt+Shift+S` to save without opening popup (with notification)
  - API client (`extension/lib/api-client.js`): `saveArticle()`, `checkHealth()`, `isValidTabUrl()`
  - URL validation: rejects `chrome://`, `about:`, `javascript:`, `data:`, `file:` schemes
  - HTML size limit: 5MB client-side check before sending (matches server limit)
  - Content script injection only when user enables "Send page HTML" (for paywalled articles)
  - CSP: `script-src 'self'; object-src 'none'` — no inline scripts, no eval
  - Zero npm dependencies — vanilla JS with ES modules
  - Module spec at `docs/modules/browser-extension.md`
  - 22 unit tests covering API client, URL validation, response handling

### Added

- **Article Inbox Page** (`/`)
  - Article list with status filtering tabs (All/Inbox/Reading/Read/Archived)
  - Article cards with title, site name, reading time, excerpt, reading progress
  - Client-side pagination with "Load more"
  - AbortController to prevent stale responses on rapid tab switching
  - Restricted column selection (excludes contentHtml/contentText) for efficient list queries

### Changed (Phase 4 Refactoring)

- Extract `getArticleOrThrow()`, `getHighlightOrThrow()`, `getSourceOrThrow()` helpers to `src/lib/db-helpers.ts` — eliminates repeated "fetch entity or throw NotFound" pattern across 6 call sites
- Restrict `GET /api/articles` list response to exclude `contentHtml`/`contentText` columns — reduces payload size for list views
- Remove unused devDependencies `@logtail/pino` and `@testing-library/react` — attack surface reduction

### Changed (Phase 3 Refactoring — Pass 2)

- Extract `readingTime()` and `formatDate()` from `article-header.tsx` to `src/lib/text-utils.ts` — consistent formatting between inbox and reader views
- Add `ArticleListItem` type to `src/types/index.ts` — lightweight article type for list views
- Update DOMPurify 3.3.1 → 3.3.2 (fixes GHSA-v2wj-7wpq-c8vv)

### Changed (Phase 3 Refactoring)

- Extract `parseIdParam()` into `src/lib/validators.ts` — eliminates duplicated `idParamSchema.parse({ id: (await context.params).id })` across 8 call sites in 4 route files
- Extract `partialWithAtLeastOne()` Zod helper — replaces 3 identical `.partial().refine()` chains in update schemas (`updateArticleSchema`, `updateHighlightSchema`, `updateTagSchema`)
- Extract `HIGHLIGHT_COLOR_OPTIONS` into `src/lib/highlight-colors.ts` — shared color palette for reader selection toolbar and highlight popover (was duplicated in 2 components)
- Add rawtext elements (`noscript`, `xmp`, `noembed`, `noframes`) to DOMPurify FORBID_TAGS — defense-in-depth mitigation for GHSA-v2wj-7wpq-c8vv (no upstream patch available)
- Remove unused `@types/jsdom` and `playwright` devDependencies

### Changed (Phase 2 Refactoring)

- Extract `safeFetch()` and `safeFetchText()` into `src/lib/fetch-utils.ts` — shared SSRF validation, timeout, and size limit logic used by article-parser and feed-poller
- Extract `computeWordCount()` into `src/lib/text-utils.ts` — single word count implementation replacing two slightly inconsistent copies
- Normalize ZodError API response shape to `{ error: "Validation failed", details: [...] }` instead of raw `{ error: [...] }`
- Consolidate hardcoded reader colors (`#1A1A1A`, `#E8E6E3`, `#FAFAF7`) across 8 files into CSS custom properties (`--reader-text`, `--reader-bg`) — eliminates 10+ `@media (prefers-color-scheme: dark)` blocks
- Add `safeImageUrl` Zod validator for `imageUrl` and `iconUrl` fields — rejects `javascript:`, `data:`, and non-HTTP URIs
- Replace unsafe `as` type assertions in status filtering with Zod enum validation at parse time (`listArticlesSchema.status` now returns typed array)
- Reuse shared `articleStatusEnum` across `createArticleSchema`, `updateArticleSchema`, `listArticlesSchema`, and `parseArticleSchema`

### Fixed (Phase 2)

- DB singleton lazy initialization via Proxy — `src/db/index.ts` no longer connects at import time, fixing `npm run build` failures when `data/` directory is absent
- Feed poll integration test expected 404 for non-RSS source; corrected to 422 (matches `ValidationError` thrown by route)

### Changed (Phase 1 Refactoring)

- Extract shared `handleApiError()` in `src/lib/api-error-handler.ts` — consolidates error-to-HTTP mapping across all 10 API route files (~150 lines removed)
- Extract `RouteContext`, `ArticleFtsRow`, `HighlightFtsRow` types to `src/types/index.ts`
- Convert relative imports to `@/` alias in `src/lib/article-parser.ts` and `src/db/index.ts`
- Update `@mozilla/readability` 0.5.0 → 0.6.0 (fixes DoS via regex vulnerability)
- `validateUrl()` now throws `ValidationError` instead of plain `Error` (returns 422 instead of 500 for SSRF blocks)
- `handleApiError` returns generic "External service unavailable" for `ExternalServiceError` (no internal detail leakage to clients)
