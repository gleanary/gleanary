# ADR-003: IMAP Credentials in DB Settings vs Environment Variables

**Status**: Accepted
**Date**: 2026-04

## Context

Newsletter email ingestion (Module 11) was initially configured via environment variables (`IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD`). This meant changing the mailbox required an app restart and editing `docker-compose.yml` or the host env.

The Settings module (built alongside Module 12) introduced a DB-backed settings store with AES-256-GCM encryption for secret values, a `/settings` admin UI, and an in-memory cache.

## Decision

Move all IMAP configuration to DB settings, managed via the Settings UI:

- Keys: `imap_host`, `imap_port`, `imap_user`, `imap_password` (encrypted), `imap_use_tls`, `imap_poll_interval`
- Changing these values immediately restarts the IMAP polling cron without an app restart
- A "Test Connection" button validates connectivity before committing changes
- `IMAP_*` env vars are removed from `.env.example` and no longer read at startup

## Rationale

1. **Runtime reconfigurability** — credentials can be updated via the UI without touching Docker config or redeploying
2. **Consistent ops pattern** — all operational secrets (Claude API key, Inworld API key, IMAP credentials, Readwise token) live in one place (Settings) rather than split across env and DB
3. **Encryption at rest** — AES-256-GCM encryption is already wired into the settings store; env vars have no equivalent protection in Docker secrets-lite setups
4. **Dynamic scheduler restart** — the settings change hook can directly restart the node-cron job, which isn't possible with env vars without a process restart

## Consequences

- The app requires `SETTINGS_ENCRYPTION_KEY` (32-byte hex) and `SETTINGS_AUTH_HASH` env vars for settings store to function
- First-run setup must configure IMAP via the UI or a seed script; no silent fallback to env vars
- Follows the same pattern established for RSS poll interval (`rss_poll_interval`) — future integrations with runtime config should use the settings store
