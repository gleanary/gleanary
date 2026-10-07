import type { SettingKey } from '@/types';

export type { SettingKey };

// --- Settings schema: maps each known key to its metadata ---

export interface SettingMeta {
  envVar: string | null;
  encrypted: boolean;
  defaultValue: string | null;
  section: 'ai' | 'reading' | 'feeds' | 'appearance';
}

export const SETTINGS_SCHEMA: Record<SettingKey, SettingMeta> = {
  inworld_api_key: {
    envVar: 'INWORLD_API_KEY',
    encrypted: true,
    defaultValue: null,
    section: 'ai',
  },
  inworld_voice_en: {
    envVar: 'INWORLD_DEFAULT_VOICE_EN',
    encrypted: false,
    defaultValue: 'Dennis',
    section: 'ai',
  },
  inworld_voice_fr: {
    envVar: 'INWORLD_DEFAULT_VOICE_FR',
    encrypted: false,
    defaultValue: 'Marie',
    section: 'ai',
  },
  anthropic_api_key: {
    envVar: 'ANTHROPIC_API_KEY',
    encrypted: true,
    defaultValue: null,
    section: 'ai',
  },
  mistral_api_key: {
    envVar: 'MISTRAL_API_KEY',
    encrypted: true,
    defaultValue: null,
    section: 'ai',
  },
  tts_default_speed: { envVar: null, encrypted: false, defaultValue: '1.0', section: 'reading' },
  daily_review_batch_size: {
    envVar: null,
    encrypted: false,
    defaultValue: '15',
    section: 'reading',
  },
  rss_poll_interval: { envVar: null, encrypted: false, defaultValue: '30', section: 'feeds' },
  imap_host: { envVar: null, encrypted: false, defaultValue: null, section: 'feeds' },
  imap_port: { envVar: null, encrypted: false, defaultValue: '993', section: 'feeds' },
  imap_user: { envVar: null, encrypted: true, defaultValue: null, section: 'feeds' },
  imap_password: { envVar: null, encrypted: true, defaultValue: null, section: 'feeds' },
  imap_tls: { envVar: null, encrypted: false, defaultValue: 'true', section: 'feeds' },
  imap_mailbox: { envVar: null, encrypted: false, defaultValue: 'INBOX', section: 'feeds' },
  imap_poll_interval: { envVar: null, encrypted: false, defaultValue: '5', section: 'feeds' },
  appearance_mode: {
    envVar: null,
    encrypted: false,
    defaultValue: 'automatic',
    section: 'appearance',
  },
  readwise_api_token: {
    envVar: 'READWISE_API_TOKEN',
    encrypted: true,
    defaultValue: null,
    section: 'ai',
  },
  readwise_last_import: {
    envVar: null,
    encrypted: false,
    defaultValue: null,
    section: 'ai',
  },
  monthly_budget_usd: {
    envVar: null,
    encrypted: false,
    defaultValue: null,
    section: 'ai',
  },
  reformat_provider: {
    envVar: 'REFORMAT_PROVIDER',
    encrypted: false,
    defaultValue: 'mistral',
    section: 'ai',
  },
};

/** Set of keys that are encrypted */
export const ENCRYPTED_KEYS = new Set<SettingKey>(
  (Object.entries(SETTINGS_SCHEMA) as [SettingKey, SettingMeta][])
    .filter(([, meta]) => meta.encrypted)
    .map(([key]) => key),
);
