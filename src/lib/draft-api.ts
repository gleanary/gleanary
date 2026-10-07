import type { DraftModelId } from '@/lib/models';
import type { Draft, DraftStatus, TemplateId, VoiceProfile } from '@/types';

/** Payload accepted by PATCH /api/drafts/[id] — all fields optional. */
export interface PatchDraftInput {
  title?: string;
  content?: string;
  angle?: string | null;
  model?: DraftModelId;
  status?: DraftStatus;
}

/** Row shape returned by GET /api/drafts (summary projection, joined with thesis title). */
export interface DraftListItem {
  id: number;
  thesisId: number;
  thesisTitle: string;
  templateId: TemplateId;
  title: string;
  angle: string | null;
  status: DraftStatus;
  generatedAt: string | null;
  lastEditedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Payload accepted by POST /api/drafts (mirrors server-side Zod schema). */
export interface CreateDraftInput {
  thesisId: number;
  templateId: TemplateId;
  model?: DraftModelId;
  angle?: string;
  includedHighlightIds: number[];
  includedResearchIds: number[];
}

async function extractError(res: Response): Promise<string> {
  const data = await res.json().catch(() => null);
  const message = (data as { error?: unknown } | null)?.error;
  if (typeof message === 'string' && message.length > 0) return message;
  return `Request failed (${res.status})`;
}

/**
 * Fetches drafts for a given thesis. Server sorts by createdAt desc.
 * Throws on non-2xx responses.
 */
export async function listDrafts(thesisId: number): Promise<DraftListItem[]> {
  const res = await fetch(`/api/drafts?thesisId=${thesisId}`, { method: 'GET' });
  if (!res.ok) throw new Error(await extractError(res));
  const body = (await res.json()) as { drafts: DraftListItem[] };
  return body.drafts;
}

/**
 * Fetches all drafts across all theses with optional filters.
 * Server sorts by createdAt desc.
 * Throws on non-2xx responses.
 */
export async function listAllDrafts(filters?: {
  templateId?: TemplateId;
  status?: DraftStatus;
}): Promise<DraftListItem[]> {
  const params = new URLSearchParams();
  if (filters?.templateId) params.set('templateId', filters.templateId);
  if (filters?.status) params.set('status', filters.status);
  const query = params.toString();
  const res = await fetch(`/api/drafts${query ? `?${query}` : ''}`, { method: 'GET' });
  if (!res.ok) throw new Error(await extractError(res));
  const body = (await res.json()) as { drafts: DraftListItem[] };
  return body.drafts;
}

/**
 * Creates a new draft shell. On validation failure (422) or any other error,
 * throws with the server's `error` string only — never the `details` array.
 */
export async function createDraft(input: CreateDraftInput): Promise<Draft> {
  const res = await fetch('/api/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await extractError(res));
  const body = (await res.json()) as { draft: Draft };
  return body.draft;
}

/**
 * Fetches the current voice profile or null when none is configured.
 * Network/parse errors are re-thrown; callers decide how to degrade.
 */
export async function getVoiceProfile(): Promise<VoiceProfile | null> {
  const res = await fetch('/api/voice/profile', { method: 'GET' });
  if (!res.ok) throw new Error(await extractError(res));
  const body = (await res.json()) as { profile: VoiceProfile | null };
  return body.profile;
}

/**
 * Fetches a single draft by id. Returns only the raw `Draft` row — the editor
 * page does not need the resolved highlights/research that GET also returns.
 * Throws on non-2xx responses (including 404).
 */
export async function getDraft(id: number): Promise<Draft> {
  const res = await fetch(`/api/drafts/${id}`, { method: 'GET' });
  if (!res.ok) throw new Error(await extractError(res));
  const body = (await res.json()) as { draft: Draft };
  return body.draft;
}

/**
 * Patches a draft with any subset of editable fields. Server sets
 * `lastEditedAt` automatically when `content` is included.
 * Throws on non-2xx responses.
 */
export async function patchDraft(id: number, input: PatchDraftInput): Promise<Draft> {
  const res = await fetch(`/api/drafts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await extractError(res));
  const body = (await res.json()) as { draft: Draft };
  return body.draft;
}

/**
 * Hard-deletes a draft by id. Throws on non-2xx responses.
 */
export async function deleteDraft(id: number): Promise<void> {
  const res = await fetch(`/api/drafts/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await extractError(res));
}
