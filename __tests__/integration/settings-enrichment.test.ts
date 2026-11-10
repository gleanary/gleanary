import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { setupAuthEnv } from '../mocks/auth-env';
import { GET, PATCH } from '@/app/api/settings/route';
import { clearSettingsCache, getConfig } from '@/lib/settings';
import { DEFAULT_ENRICH_MODEL, ENRICH_MODEL_IDS } from '@/lib/models';

function patch(settings: Record<string, string>) {
  return PATCH(
    new NextRequest(new URL('/api/settings', 'http://localhost:3000'), {
      method: 'PATCH',
      body: JSON.stringify({ settings }),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

describe('enrichment settings', () => {
  setupAuthEnv();

  beforeEach(() => {
    dbMock.setup();
    clearSettingsCache();
  });

  it('exposes the enrichment keys with their defaults', async () => {
    const res = await GET();
    const body = await res.json();
    expect(body.settings.enrich_default_model).toBeDefined();
    expect(getConfig('enrich_default_model')).toBe(DEFAULT_ENRICH_MODEL);
    expect(getConfig('enrich_language')).toBe('en');
    expect(getConfig('enrich_mode_rss_feed')).toBe('lazy');
    expect(getConfig('enrich_mode_web_save')).toBe('auto');
    expect(getConfig('enrich_model_rss_feed')).toBe('');
    expect(getConfig('enrich_batch_min_articles')).toBe('20');
    expect(getConfig('enrich_batch_max_age_days')).toBe('1');
    expect(getConfig('enrich_bulk_threshold')).toBe('25');
    expect(getConfig('enrich_max_input_tokens')).toBe('150000');
  });

  it('accepts valid values', async () => {
    const other = ENRICH_MODEL_IDS.find((id) => id !== DEFAULT_ENRICH_MODEL)!;
    const res = await patch({
      enrich_default_model: other,
      enrich_language: 'fr',
      enrich_mode_rss_feed: 'batch',
      enrich_model_upload: other,
      enrich_batch_min_articles: '500',
      enrich_batch_max_age_days: '30',
      enrich_bulk_threshold: '1000',
      enrich_max_input_tokens: '10000',
    });
    expect(res.status).toBe(200);
    expect(getConfig('enrich_default_model')).toBe(other);
    expect(getConfig('enrich_language')).toBe('fr');
    expect(getConfig('enrich_mode_rss_feed')).toBe('batch');
    expect(getConfig('enrich_model_upload')).toBe(other);
    expect(getConfig('enrich_max_input_tokens')).toBe('10000');
  });

  it("accepts '' (inherit) for a per-type model", async () => {
    const res = await patch({ enrich_model_rss_feed: '' });
    expect(res.status).toBe(200);
    expect(getConfig('enrich_model_rss_feed')).toBe('');
  });

  it.each([
    ['out-of-range batch minimum', { enrich_batch_min_articles: '0' }],
    ['out-of-range batch age', { enrich_batch_max_age_days: '31' }],
    ['out-of-range bulk threshold', { enrich_bulk_threshold: '1001' }],
    ['input tokens below the minimum', { enrich_max_input_tokens: '9999' }],
    ['input tokens above the maximum', { enrich_max_input_tokens: '500001' }],
    ['a non-integer', { enrich_batch_min_articles: '2.5' }],
    ['an invalid language code', { enrich_language: 'english' }],
    ['an upper-case language code', { enrich_language: 'FR' }],
    ['an unknown default model', { enrich_default_model: 'claude-nope' }],
    ['a retired per-type model', { enrich_model_upload: 'claude-sonnet-4-20250514' }],
    ["'' for the default model", { enrich_default_model: '' }],
    ['an unknown mode', { enrich_mode_upload: 'sometimes' }],
  ])('rejects %s with 422', async (_name, settings) => {
    const res = await patch(settings);
    expect(res.status).toBe(422);
  });
});
