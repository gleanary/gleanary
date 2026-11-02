import type { Article, AutoTagResponse, GenerateKind, Highlight, SummarizeResponse } from '@/types';

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

interface GenerateConfig {
  endpoint: string;
  /** The article update for a successful response, or null when it carries nothing. */
  toUpdate: (data: unknown) => Partial<Article> | null;
  emptyError: string;
}

const GENERATE_CONFIG: Record<GenerateKind, GenerateConfig> = {
  summary: {
    endpoint: '/api/ai/summarize',
    toUpdate: (data) => {
      const { summary } = data as SummarizeResponse;
      return summary ? { aiSummary: summary } : null;
    },
    emptyError: 'No summary was generated',
  },
  tags: {
    endpoint: '/api/ai/tag',
    toUpdate: (data) => {
      const { tags } = data as AutoTagResponse;
      return tags?.length ? { aiTags: JSON.stringify(tags) } : null;
    },
    emptyError: 'No tags were suggested for this article',
  },
};

/**
 * Generates an article's AI summary or tags. The server also stores the result on the
 * article, so the request is safe to leave running after the caller goes away.
 * @param kind - Which AI field to generate
 * @param articleId - The article to generate it for
 * @returns The article update to apply (`aiSummary`, or `aiTags` as a JSON array string)
 * @throws Error with the API message on a non-OK response or a network failure, or when
 *   the response carries nothing to apply
 */
export async function generateArticleAi(
  kind: GenerateKind,
  articleId: number,
): Promise<Partial<Article>> {
  const config = GENERATE_CONFIG[kind];
  const res = await fetch(config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleId }),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data as { error?: string } | null)?.error || `Failed (${res.status})`);
  }
  const update = data ? config.toUpdate(data) : null;
  if (!update) throw new Error(config.emptyError);
  return update;
}
