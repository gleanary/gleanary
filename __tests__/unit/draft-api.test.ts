import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { listDrafts, createDraft, getVoiceProfile } from '@/lib/draft-api';

// vi.restoreAllMocks() (per-describe afterEach) resets the mock but does NOT undo
// vi.stubGlobal, so the fetch stub outlives this file and would exempt later files
// from the MSW tripwire. Unstub globals once after every test in this file.
afterAll(() => {
  vi.unstubAllGlobals();
});

describe('listDrafts', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /api/drafts with thesisId query and returns drafts array', async () => {
    const payload = { drafts: [{ id: 1 }, { id: 2 }], total: 2 };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve(payload),
    });

    const result = await listDrafts(42);

    expect(mockFetch).toHaveBeenCalledWith('/api/drafts?thesisId=42', expect.any(Object));
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('throws when the request fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal server error' }),
    });

    await expect(listDrafts(1)).rejects.toThrow('Internal server error');
  });
});

describe('createDraft', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const input = {
    thesisId: 5,
    templateId: 'blog' as const,
    angle: 'contrarian',
    includedHighlightIds: [1, 2],
    includedResearchIds: [3],
  };

  it('POSTs JSON to /api/drafts and returns the created draft', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ draft: { id: 99, ...input } }),
    });

    const draft = await createDraft(input);

    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('/api/drafts');
    expect(call[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(call[1].body)).toEqual(input);
    expect(draft.id).toBe(99);
  });

  it('throws with server-provided error message on 422', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: () =>
        Promise.resolve({
          error: 'Validation failed',
          details: [{ path: 'includedHighlightIds', message: 'not in thesis' }],
        }),
    });

    await expect(createDraft(input)).rejects.toThrow('Validation failed');
  });

  it('never surfaces the details array in the thrown message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: () =>
        Promise.resolve({
          error: 'Validation failed',
          details: [{ path: 'x', message: 'secret detail' }],
        }),
    });

    try {
      await createDraft(input);
      throw new Error('expected createDraft to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('secret detail');
      expect((err as Error).message).not.toContain('details');
    }
  });

  it('falls back to a generic message when response body is not JSON', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not JSON')),
    });

    await expect(createDraft(input)).rejects.toThrow(/500/);
  });
});

describe('getVoiceProfile', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when profile is null', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ profile: null, sampleCount: 0 }),
    });

    const result = await getVoiceProfile();
    expect(result).toBeNull();
  });

  it('returns the profile object when present', async () => {
    const profile = {
      id: 1,
      userId: 1,
      profile: 'warm, punchy',
      updatedAt: '2026-04-19T00:00:00Z',
    };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ profile, sampleCount: 3 }),
    });

    const result = await getVoiceProfile();
    expect(result).toEqual(profile);
  });
});
