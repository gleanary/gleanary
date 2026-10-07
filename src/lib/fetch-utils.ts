import { ExternalServiceError } from '@/lib/errors';
import { validateUrl } from '@/lib/url-validator';

/** Options for a validated, timeout-limited fetch */
export interface SafeFetchOptions {
  /** Timeout in milliseconds (default 10_000) */
  timeoutMs?: number;
  /** Maximum response size in bytes (default 5MB) */
  maxBytes?: number;
  /** Custom headers to include */
  headers?: Record<string, string>;
  /** User-Agent header value */
  userAgent?: string;
  /**
   * Whether to validate the initial URL for SSRF (default true).
   * Redirect targets are ALWAYS validated regardless of this flag.
   */
  validateSsrf?: boolean;
  /** HTTP method (default 'GET') */
  method?: string;
  /** Request body (only used when method is POST/PUT/PATCH) */
  body?: BodyInit | ArrayBufferView;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_REDIRECTS = 3;

/**
 * Performs a fetch with SSRF validation, timeout, and size limits.
 * @param url - The URL to fetch
 * @param opts - Fetch options (timeout, size limit, headers, etc.)
 * @returns The fetch Response object
 * @throws ExternalServiceError if fetch fails, times out, or exceeds size limit
 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    headers = {},
    userAgent,
    validateSsrf = true,
    method = 'GET',
    body,
  } = opts;

  if (validateSsrf) {
    await validateUrl(url);
  }

  let currentUrl = url;
  let redirectsLeft = MAX_REDIRECTS;

  for (;;) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method,
        body: body as BodyInit,
        signal: controller.signal,
        headers: {
          ...(userAgent ? { 'User-Agent': userAgent } : {}),
          ...headers,
        },
        redirect: 'manual',
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ExternalServiceError('fetch', `Request timed out after ${timeoutMs}ms`);
      }
      throw new ExternalServiceError('fetch', `Failed to fetch URL: ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirectsLeft === 0) {
        throw new ExternalServiceError('fetch', `Too many redirects (max ${MAX_REDIRECTS})`);
      }
      redirectsLeft--;
      const location = response.headers.get('location');
      if (!location) {
        throw new ExternalServiceError('fetch', 'Redirect response missing Location header');
      }
      currentUrl = new URL(location, currentUrl).toString();
      await validateUrl(currentUrl); // always SSRF-check redirect targets
      await response.body?.cancel().catch(() => undefined);
      continue;
    }

    // Check Content-Length before reading body
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      throw new ExternalServiceError(
        'fetch',
        `Response too large: ${contentLength} bytes (max ${maxBytes})`,
      );
    }

    return response;
  }
}

/**
 * Fetches a URL and returns the response body as text, enforcing size limits.
 * @param url - The URL to fetch
 * @param opts - Fetch options
 * @returns The response text and the Response object
 * @throws ExternalServiceError if the body exceeds maxBytes
 */
export async function safeFetchText(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<{ text: string; response: Response }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const response = await safeFetch(url, opts);

  const text = await response.text();
  if (text.length > maxBytes) {
    throw new ExternalServiceError(
      'fetch',
      `Response too large: ${text.length} bytes (max ${maxBytes})`,
    );
  }

  return { text, response };
}
