# ADR-004: FTS5 Virtual Tables via Runtime Initialization

**Date**: 2026-04
**Status**: Accepted

## Context

The app requires full-text search across articles, highlights, theses, and chat messages. SQLite's FTS5 extension provides efficient tokenized search. The question is how to manage the lifecycle of these virtual tables alongside schema migrations.

Two approaches were considered:

1. **Drizzle migrations**: Express FTS5 tables as raw SQL in numbered migration files (e.g. `0002_fts.sql`).
2. **Runtime initialization**: Manage FTS5 tables in `src/db/fts.ts`, called once at DB startup via `initFts()`.

## Decision

Use runtime initialization (`src/db/fts.ts`) rather than Drizzle migration files.

## Rationale

1. **FTS5 does not support `ALTER TABLE`**: when a column needs to be added to an FTS5 table (e.g. adding `ai_index` to `articles_fts`), the table must be dropped and recreated. There is no incremental migration path. This makes sequential numbered migrations awkward — a new migration must drop and recreate the entire table, losing the ability to reason about incremental schema state.

2. **Drizzle has no FTS5 type support**: FTS5 virtual tables cannot be expressed in the Drizzle schema DSL. All FTS SQL would be raw strings in migration files anyway, with no type-level connection to the tables they shadow.

3. **Runtime initialization handles evolution cleanly**: `initFts()` detects the current FTS state (e.g. checks whether `ai_index` exists in `articles_fts` via `pragma table_info`) and rebuilds if needed. This is idempotent and self-healing — a server restart after a schema change always produces a consistent FTS state without requiring a separate migration.

4. **Content tables are authoritative**: FTS5 tables use `content='articles'` mode, meaning they are indexes over the content tables (not separate stores). Sync triggers maintain consistency on insert/update/delete. Rebuilding an FTS table from scratch is always safe.

## Consequences

- FTS5 tables are not visible in `src/db/schema.ts` or migration files. Developers must look at `src/db/fts.ts` to understand the FTS schema.
- Adding a new column to an FTS table requires updating `initFts()`, not creating a new migration.
- `initFts()` is called once at server startup (via `src/db/index.ts`), before any queries. It is a no-op when the tables are already in the correct state.
- All four FTS tables follow this pattern: `articles_fts`, `highlights_fts`, `theses_fts`, `chat_messages_fts`.
