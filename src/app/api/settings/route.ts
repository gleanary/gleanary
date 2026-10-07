import { NextRequest, NextResponse } from 'next/server';
import { withRoute } from '@/lib/api-error-handler';
import { logger } from '@/lib/logger';
import { ValidationError } from '@/lib/errors';
import { patchSettingsSchema, validateSettingValue } from '@/lib/validators';
import {
  setSetting,
  getMaskedSettingsResponse,
  verifySettingsPassword,
  SETTINGS_SCHEMA,
  ENCRYPTED_KEYS,
} from '@/lib/settings';
import { getClientIp, isAuthActive } from '@/lib/auth';
import { isEncryptionAvailable } from '@/lib/settings-crypto';
import { logAudit } from '@/lib/audit';
import type { SettingKey } from '@/types';

/**
 * GET /api/settings — Returns all settings with encrypted values masked.
 */
export const GET = withRoute('GET /api/settings', async () => {
  const result = getMaskedSettingsResponse();
  const encryptionAvailable = isEncryptionAvailable();
  return NextResponse.json({ settings: result, encryptionAvailable, authActive: isAuthActive() });
});

/**
 * PATCH /api/settings — Update settings. Requires confirm_password for encrypted keys.
 */
export const PATCH = withRoute('PATCH /api/settings', async (req: NextRequest) => {
  const body = await req.json();
  const data = patchSettingsSchema.parse(body);

  // Check if any encrypted keys are being updated
  const hasEncrypted = Object.keys(data.settings).some((k) => ENCRYPTED_KEYS.has(k as SettingKey));

  // Verify password if updating encrypted settings
  if (hasEncrypted) {
    const denied = await verifySettingsPassword(data.confirm_password!);
    if (denied) return denied;
  }

  const ipAddress = getClientIp(req);
  const updated: string[] = [];
  const savedValues: Record<string, string> = {};

  for (const [key, value] of Object.entries(data.settings)) {
    const meta = SETTINGS_SCHEMA[key as SettingKey];
    if (!meta) {
      throw new ValidationError(`Unknown setting key: ${key}`);
    }

    const validatedValue = validateSettingValue(key, value);

    if (meta.encrypted && !isEncryptionAvailable()) {
      throw new ValidationError(
        'Cannot store encrypted settings: SETTINGS_ENCRYPTION_KEY is not configured.',
      );
    }

    setSetting(key, validatedValue, { encrypted: meta.encrypted });

    const action = meta.encrypted ? 'api_key_changed' : 'setting_updated';
    logAudit(action, key, { ipAddress: ipAddress ?? undefined });
    updated.push(key);
    savedValues[key] = validatedValue;
  }

  logger.info({ event: 'settings_updated', keys: updated }, 'Settings updated');

  // Restart schedulers if poll interval settings changed
  if (updated.includes('imap_poll_interval')) {
    const { startNewsletterScheduler } = await import('@/lib/newsletter-scheduler');
    startNewsletterScheduler(parseInt(savedValues['imap_poll_interval']!) || 5);
  }
  if (updated.includes('rss_poll_interval')) {
    const { startFeedScheduler } = await import('@/lib/feed-scheduler');
    startFeedScheduler(parseInt(savedValues['rss_poll_interval']!) || 1);
  }

  const result = getMaskedSettingsResponse();
  return NextResponse.json({ settings: result, updated });
});
