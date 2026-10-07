# SESSION: docs

**Trigger**: "Update documentation", "Write ADR for `<decision>`", or "Reconcile docs" — run every 2-3 modules or when docs feel stale.

Reconcile module specs, architecture doc, and registry against the actual code.

## Workflow

1. **RECONCILE SCHEMA** — Read `src/db/schema.ts`. For every `docs/modules/*.md`, check that the tables listed in its status block actually exist in the schema. Flag any mismatch.

2. **RECONCILE CHANGELOG** — Read `CHANGELOG.md`. Verify the Module Registry table in `CLAUDE.md` matches what's listed as built. Update any stale status entries.

3. **UPDATE MODULE STATUS BLOCKS** — For each module spec that was reconciled or found stale, update its status block (top of file):

   ```
   **Status**: Done | Partial | Not started
   **Last verified against code**: YYYY-MM (session name)
   **Schema tables**: `table1`, `table2`
   **Unimplemented sections**: none | [list]
   ```

4. **UPDATE ARCHITECTURE DOC** — If `docs/architecture.md` §5 (data model) is out of sync with `src/db/schema.ts`, update it. Requires human approval before committing.

5. **CREATE ADRS** — For any non-obvious decision made since the last docs session that lacks an ADR, create one in `docs/adrs/`.

6. **VERIFY LINKS** — Scan all internal `[text](path)` links in `docs/` and `CLAUDE.md`. Report any broken paths.

7. **COMMIT** — `docs: reconcile module specs and architecture` — no code changes in this session.
