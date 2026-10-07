/**
 * Browser extension API client.
 * Communicates with the reader app backend to save articles and check health.
 * @module api-client
 */

/** Maximum HTML payload size in bytes (5MB, matches server limit) */
const MAX_HTML_SIZE = 5 * 1024 * 1024;

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Builds an Authorization header for basic auth if credentials are provided.
 * @param {{ username?: string, password?: string }} [auth]
 * @returns {Record<string, string>}
 */
function buildAuthHeaders(auth) {
  // The server only checks the password; default the username so leaving it
  // blank in the options page still authenticates.
  if (auth?.password) {
    return { Authorization: 'Basic ' + btoa((auth.username || 'reader') + ':' + auth.password) };
  }
  return {};
}

/**
 * Strips trailing slashes from a URL.
 * @param {string} url
 * @returns {string}
 */
export function normalizeBaseUrl(url) {
  return url.replace(/\/+$/, '');
}

/**
 * Checks if a tab URL is saveable (not a browser internal page).
 * @param {string} url - The tab URL to check
 * @returns {boolean} True if the URL can be saved
 */
export function isValidTabUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Gets the page HTML from the active tab via scripting API.
 * @param {number} tabId
 * @returns {Promise<string|null>}
 */
export async function getPageHtml(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    return results[0]?.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Result of saving an article.
 * @typedef {Object} SaveResult
 * @property {'created'|'duplicate'|'error'} status
 * @property {number} [articleId] - ID of created/existing article
 * @property {string} [error] - Error message if status is 'error'
 */

/**
 * Saves an article by URL (and optionally HTML) to the reader backend.
 * @param {string} apiBaseUrl - The base URL of the reader API (e.g., "https://reader.example.com")
 * @param {string} url - The article URL to save
 * @param {string} [html] - Optional page HTML for paywalled content
 * @param {{ username?: string, password?: string }} [auth] - Optional basic auth credentials
 * @returns {Promise<SaveResult>}
 */
export async function saveArticle(apiBaseUrl, url, html, auth) {
  const body = { url };
  if (html) {
    // Enforce size limit (TextEncoder measures UTF-8 bytes, matching JSON serialization)
    if (new TextEncoder().encode(html).byteLength > MAX_HTML_SIZE) {
      return { status: 'error', error: 'Page HTML exceeds 5MB limit' };
    }
    body.html = html;
  }

  const endpoint = `${normalizeBaseUrl(apiBaseUrl)}/api/articles/parse`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(auth) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 201) {
    const data = await response.json();
    return { status: 'created', articleId: data.article?.id };
  }

  if (response.status === 409) {
    return { status: 'duplicate' };
  }

  // Error cases
  const data = await response.json().catch(() => ({}));
  const errorMsg = data.error || `Server error (${response.status})`;
  return { status: 'error', error: errorMsg };
}

/**
 * Checks if the reader backend is reachable.
 * @param {string} apiBaseUrl - The base URL of the reader API
 * @param {{ username?: string, password?: string }} [auth] - Optional basic auth credentials
 * @returns {Promise<boolean>} True if the server responds with 200
 */
export async function checkHealth(apiBaseUrl, auth) {
  const base = normalizeBaseUrl(apiBaseUrl);
  const response = await fetch(`${base}/api/health`, {
    method: 'GET',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return false;
  // /api/health is public, so also hit an auth-gated endpoint to verify the
  // configured credentials actually work.
  const authed = await fetch(`${base}/api/tags`, {
    method: 'GET',
    headers: { ...buildAuthHeaders(auth) },
    signal: AbortSignal.timeout(5000),
  });
  return authed.ok;
}
