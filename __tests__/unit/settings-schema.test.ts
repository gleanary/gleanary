import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SETTINGS_SCHEMA, ENCRYPTED_KEYS } from '@/lib/settings-schema';
import type { SettingKey, SettingMeta } from '@/lib/settings-schema';

describe('settings-schema', () => {
  it('exports SETTINGS_SCHEMA with expected keys and metadata shape', () => {
    expect(SETTINGS_SCHEMA.anthropic_api_key).toEqual({
      envVar: 'ANTHROPIC_API_KEY',
      encrypted: true,
      defaultValue: null,
      section: 'ai',
    });
    expect(SETTINGS_SCHEMA.tts_default_speed).toEqual({
      envVar: null,
      encrypted: false,
      defaultValue: '1.0',
      section: 'reading',
    });
  });

  it('ENCRYPTED_KEYS is exactly the set of schema keys whose meta.encrypted is true', () => {
    const expected = new Set<SettingKey>(
      (Object.entries(SETTINGS_SCHEMA) as [SettingKey, SettingMeta][])
        .filter(([, meta]) => meta.encrypted)
        .map(([key]) => key),
    );
    expect(ENCRYPTED_KEYS).toEqual(expected);
    // Spot-check known members and non-members.
    expect(ENCRYPTED_KEYS.has('anthropic_api_key')).toBe(true);
    expect(ENCRYPTED_KEYS.has('imap_password')).toBe(true);
    expect(ENCRYPTED_KEYS.has('tts_default_speed')).toBe(false);
    expect(ENCRYPTED_KEYS.has('appearance_mode')).toBe(false);
  });

  it('re-exports SETTINGS_SCHEMA and ENCRYPTED_KEYS from settings.ts for back-compat', async () => {
    const settings = await import('@/lib/settings');
    expect(settings.SETTINGS_SCHEMA).toBe(SETTINGS_SCHEMA);
    expect(settings.ENCRYPTED_KEYS).toBe(ENCRYPTED_KEYS);
  });

  it('boundary guard: validators.ts imports ENCRYPTED_KEYS from settings-schema, not settings', () => {
    const src = readFileSync(resolve(__dirname, '../../src/lib/validators.ts'), 'utf-8');
    expect(src).toMatch(/import\s*\{\s*ENCRYPTED_KEYS\s*\}\s*from\s*'@\/lib\/settings-schema'/);
    expect(src).not.toMatch(/from\s*'@\/lib\/settings'/);
  });
});
