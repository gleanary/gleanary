# Security Policy

Gleanary is a self-hosted, single-user application. It handles untrusted
external content (fetched articles, RSS feeds, newsletter emails, PDFs), so
security reports are taken seriously.

## Supported versions

Only the latest release / `main` branch is supported.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting ("Report a vulnerability" under
the repository's Security tab). Include reproduction steps and the impact you
see. You should get an initial response within a week.

## Scope notes for self-hosters

- The app's built-in authentication protects all routes, but the app serves
  plain HTTP — always put TLS in front of an internet-exposed instance (the
  shipped compose `tls` profile does this).
- `AUTH_DISABLED=true` removes all authentication and is only safe on private
  networks.
- API keys configured in Settings are encrypted at rest with
  `SETTINGS_ENCRYPTION_KEY`; protect your `.env` and database file backups
  accordingly.
