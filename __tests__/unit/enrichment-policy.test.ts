import { describe, it, expect } from 'vitest';
import { resolveEnrichMode, resolveEnrichModel } from '@/lib/enrichment-core';
import { ANTHROPIC_MODELS, DEFAULT_ENRICH_MODEL, ENRICH_MODEL_IDS } from '@/lib/models';
import { SETTINGS_SCHEMA } from '@/lib/settings-schema';
import type { SettingKey } from '@/types';

/** A getter over a plain record that falls back to the schema default like getConfig does. */
function lookup(values: Partial<Record<SettingKey, string>>): (key: SettingKey) => string {
  return (key) => values[key] ?? SETTINGS_SCHEMA[key].defaultValue ?? '';
}

/** A getter that throws for any key outside the given record. */
function strictLookup(values: Partial<Record<SettingKey, string>>): (key: SettingKey) => string {
  return (key) => {
    if (!(key in values)) throw new TypeError(`unexpected key ${key}`);
    return values[key]!;
  };
}

const RETIRED = 'claude-sonnet-4-20250514';
const otherModel = ENRICH_MODEL_IDS.find((id) => id !== DEFAULT_ENRICH_MODEL)!;

describe('resolveEnrichMode', () => {
  it('uses the per-type default when nothing is stored (lazy for RSS, auto otherwise)', () => {
    expect(resolveEnrichMode(lookup({}), 'rss_feed')).toBe('lazy');
    expect(resolveEnrichMode(lookup({}), 'web_save')).toBe('auto');
    expect(resolveEnrichMode(lookup({}), 'newsletter')).toBe('auto');
    expect(resolveEnrichMode(lookup({}), 'readwise')).toBe('auto');
    expect(resolveEnrichMode(lookup({}), 'upload')).toBe('auto');
  });

  it('honours a stored override', () => {
    expect(resolveEnrichMode(lookup({ enrich_mode_rss_feed: 'batch' }), 'rss_feed')).toBe('batch');
  });

  it('treats an invalid stored value as absent', () => {
    expect(resolveEnrichMode(lookup({ enrich_mode_rss_feed: 'sometimes' }), 'rss_feed')).toBe(
      'lazy',
    );
  });

  it('never queries a per-type key for types without a policy', () => {
    for (const type of ['manual', 'browser_extension', 'remarkable'] as const) {
      expect(resolveEnrichMode(strictLookup({}), type)).toBe('auto');
    }
  });
});

describe('resolveEnrichModel', () => {
  it('prefers the per-type override, then the global default, then the hard default', () => {
    expect(
      resolveEnrichModel(
        lookup({ enrich_model_upload: otherModel, enrich_default_model: DEFAULT_ENRICH_MODEL }),
        'upload',
      ),
    ).toEqual({ model: otherModel, fallbacks: [] });
    expect(resolveEnrichModel(lookup({ enrich_default_model: otherModel }), 'upload')).toEqual({
      model: otherModel,
      fallbacks: [],
    });
    expect(resolveEnrichModel(lookup({}), 'upload')).toEqual({
      model: DEFAULT_ENRICH_MODEL,
      fallbacks: [],
    });
  });

  it("treats '' as inherit without reporting a fallback", () => {
    expect(
      resolveEnrichModel(
        lookup({ enrich_model_upload: '', enrich_default_model: otherModel }),
        'upload',
      ),
    ).toEqual({ model: otherModel, fallbacks: [] });
  });

  it('falls back from a retired per-type override to a valid global default and reports it', () => {
    expect(
      resolveEnrichModel(
        lookup({ enrich_model_rss_feed: RETIRED, enrich_default_model: otherModel }),
        'rss_feed',
      ),
    ).toEqual({
      model: otherModel,
      fallbacks: [{ key: 'enrich_model_rss_feed', rejected: RETIRED }],
    });
  });

  it('falls back two levels when both the override and the global default are retired', () => {
    expect(
      resolveEnrichModel(
        lookup({ enrich_model_rss_feed: RETIRED, enrich_default_model: 'claude-nope' }),
        'rss_feed',
      ),
    ).toEqual({
      model: DEFAULT_ENRICH_MODEL,
      fallbacks: [
        { key: 'enrich_model_rss_feed', rejected: RETIRED },
        { key: 'enrich_default_model', rejected: 'claude-nope' },
      ],
    });
  });

  it('rejects an id that is in ANTHROPIC_MODELS but not in ENRICH_MODEL_IDS like a retired one', () => {
    const nonEligible = ANTHROPIC_MODELS.map((m) => m.id).find(
      (id) => !(ENRICH_MODEL_IDS as readonly string[]).includes(id),
    );
    // Every active model accepts forced tool use today; the rule is exercised when one does not.
    if (!nonEligible) return;
    expect(resolveEnrichModel(lookup({ enrich_default_model: nonEligible }), 'upload')).toEqual({
      model: DEFAULT_ENRICH_MODEL,
      fallbacks: [{ key: 'enrich_default_model', rejected: nonEligible }],
    });
  });

  it('starts the chain at the global default for types without a policy', () => {
    for (const type of ['manual', 'browser_extension', 'remarkable'] as const) {
      expect(resolveEnrichModel(strictLookup({ enrich_default_model: otherModel }), type)).toEqual({
        model: otherModel,
        fallbacks: [],
      });
    }
  });
});
