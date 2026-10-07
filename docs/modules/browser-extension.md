# Module 8: Browser Extension

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `articles`, `sources` (via API — no direct DB access)
**Unimplemented sections**: none

## Purpose

Chrome extension (Manifest V3) to save the current page to the reader app with one click. Sends the URL (and optionally the page HTML for paywalled content) to the existing `POST /api/articles/parse` endpoint.

## Architecture

```
extension/
├── manifest.json          # Manifest V3 config
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic (save page, show status)
├── options.html           # Options page UI
├── options.js             # Options page logic (configure API URL)
├── background.js          # Service worker (keyboard shortcut handler)
├── lib/
│   └── api-client.js      # Shared API communication logic
└── icons/
    ├── icon-16.png
    ├── icon-32.png
    ├── icon-48.png
    └── icon-128.png
```

The extension is a standalone project with no build step — plain JavaScript with ES modules. It does **not** share code with the Next.js app. Unit tests for the API client are in `__tests__/unit/browser-extension.test.ts` (in the main project test directory, not in the extension folder).

## Features

### 1. One-Click Save (Popup)

- User clicks extension icon → popup opens
- Popup immediately saves the current tab's URL to the API
- Shows status: "Saving..." → "Saved!" (with link to reader) or error message
- Option to include page HTML (toggle in popup) for paywalled content

### 2. Keyboard Shortcut

- `Alt+Shift+S` (configurable) triggers save without opening popup
- Uses background service worker to execute
- Shows Chrome notification for success/failure

### 3. Options Page

- Configure API base URL (e.g., `https://reader.example.com`)
- Toggle "Send page HTML" (default: off)
- Test connection button (hits `GET /api/health`)

## API Contract

### Save Article

Uses the existing endpoint:

```
POST {apiBaseUrl}/api/articles/parse
Content-Type: application/json

{
  "url": "https://example.com/article",
  "html": "<html>...</html>"  // optional, only if "Send page HTML" is enabled
}
```

**Responses**:

- `201`: Article created → show "Saved!" with link
- `409`: Duplicate → show "Already saved" (not an error)
- `422`: Validation error
- `502`: Backend couldn't fetch the URL
- Other: Generic error message

### Health Check

```
GET {apiBaseUrl}/api/health
```

Returns `200` if the server is reachable.

## Dependencies

- **Chrome APIs**: `storage.sync`, `tabs`, `scripting`, `notifications`
- **Backend**: `POST /api/articles/parse` (Module 2), `GET /api/health` (scaffold)
- **No npm dependencies** — vanilla JS/TS, no framework

## Edge Cases

- **No API URL configured**: Show "Configure API URL in options" in popup
- **Server unreachable**: Show error with retry button
- **Paywalled content**: When "Send page HTML" is on, inject content script to grab `document.documentElement.outerHTML`
- **Duplicate article**: Treat 409 as success ("Already saved"), link to existing article
- **Tab without URL**: Ignore `chrome://`, `chrome-extension://`, `about:` pages
- **Very large HTML**: Limit to 5MB before sending (matches server-side limit)

## Security

- API URL stored in `chrome.storage.sync` (synced across devices)
- No secrets stored in the extension (server has no auth — network-level protection)
- Content script injection only when user explicitly enables "Send page HTML"
- CSP in manifest prevents inline scripts
- Only `activeTab` permission (no broad host access) unless HTML capture is enabled
