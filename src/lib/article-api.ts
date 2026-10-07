import type { Highlight } from '@/types';

/** Result of attempting to upload a PDF file */
export interface UploadPdfResult {
  ok: boolean;
  duplicate: boolean;
  existingId?: number;
  article?: { id: number; title: string; extractionTier: string };
  error?: string;
}

/**
 * Uploads a PDF file via the upload API. Handles duplicate detection (409)
 * and network/error extraction from the response body.
 * @param file - The PDF File object to upload
 * @returns Result with ok/duplicate status and article data or error message
 */
export async function uploadPdf(file: File): Promise<UploadPdfResult> {
  const form = new FormData();
  form.append('file', file);
  // Do NOT set Content-Type — browser sets the multipart boundary automatically
  let res: Response;
  try {
    res = await fetch('/api/upload', { method: 'POST', body: form });
  } catch {
    return {
      ok: false,
      duplicate: false,
      error: 'Network error — check your connection and try again.',
    };
  }
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, duplicate: true, existingId: (data as { existingId?: number }).existingId };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      duplicate: false,
      error: (data as { error?: string }).error ?? `Error ${res.status}`,
    };
  }
  return {
    ok: true,
    duplicate: false,
    article: (data as { article: UploadPdfResult['article'] }).article,
  };
}

/** Result of attempting to save an article by URL */
export interface ParseArticleResult {
  ok: boolean;
  duplicate: boolean;
  existingId?: number;
  article?: { id: number; [key: string]: unknown };
  error?: string;
}

/**
 * Saves an article by URL via the parse API. Handles duplicate detection (409)
 * and error extraction from the response body.
 * @param url - The article URL to save
 * @returns Result with ok/duplicate status and article data or error message
 */
export async function parseArticleByUrl(url: string): Promise<ParseArticleResult> {
  const res = await fetch('/api/articles/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, duplicate: true, existingId: (data as { existingId?: number }).existingId };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return {
      ok: false,
      duplicate: false,
      error: (data as { error?: string }).error ?? `Error ${res.status}`,
    };
  }
  return { ok: true, duplicate: false, article: (data as { article: { id: number } }).article };
}

/**
 * Client-side helper for patching article fields via the API.
 * @param articleId - The article ID to update
 * @param updates - Object with fields to update (status, isFavorite, readingProgress, etc.)
 * @param options - Optional fetch options (e.g., keepalive for beforeunload)
 */
export function patchArticle(
  articleId: number,
  updates: Record<string, unknown>,
  options?: { keepalive?: boolean },
): Promise<Response> {
  return fetch(`/api/articles/${articleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
    keepalive: options?.keepalive,
  });
}

/**
 * Creates a highlight on an article via the API.
 * @param data - Highlight creation data
 * @returns The created highlight
 */
export async function createHighlight(data: {
  articleId: number;
  text: string;
  note?: string;
  positionData?: string;
}): Promise<Highlight> {
  const res = await fetch('/api/highlights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Failed to create highlight: ${res.status}`);
  }
  const json = await res.json();
  return json.highlight;
}

/**
 * Deletes a highlight via the API.
 * @param highlightId - The highlight ID to delete
 */
export async function deleteHighlight(highlightId: number): Promise<void> {
  const res = await fetch(`/api/highlights/${highlightId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`Failed to delete highlight: ${res.status}`);
  }
}

/**
 * Deletes an article and all its highlights via the API.
 * @param articleId - The article ID to delete
 */
export async function deleteArticle(articleId: number): Promise<void> {
  const res = await fetch(`/api/articles/${articleId}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(`Failed to delete article: ${res.status}`);
  }
}

/**
 * Updates a highlight (note, color, tags) via the API.
 * @param highlightId - The highlight ID to update
 * @param updates - Fields to update
 * @returns The updated highlight
 */
export async function updateHighlight(
  highlightId: number,
  updates: {
    text?: string;
    note?: string;
    positionData?: string;
    anchorStatus?: import('@/types').AnchorStatus;
    tagIds?: number[];
  },
): Promise<Highlight> {
  const res = await fetch(`/api/highlights/${highlightId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    throw new Error(`Failed to update highlight: ${res.status}`);
  }
  const json = await res.json();
  return json.highlight;
}
