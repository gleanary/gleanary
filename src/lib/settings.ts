import 'server-only';
import { eq, and, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { verifyPassword } from '@/lib/auth';
import { db } from '@/db';
import { settings } from '@/db/schema';
import { encrypt, decrypt, isEncryptionAvailable } from '@/lib/settings-crypto';
import { ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  SETTINGS_SCHEMA,
  ENCRYPTED_KEYS,
  type SettingMeta,
  type SettingKey,
} from '@/lib/settings-schema';

// Re-export the pure schema definitions for back-compat with existing importers.
export { SETTINGS_SCHEMA, ENCRYPTED_KEYS };
export type { SettingKey, SettingMeta } from '@/lib/settings-schema';

// --- In-memory cache ---

const cache = new Map<string, string | null>();
let envMigrated = false;

function cacheKey(key: string, userId: number): string {
  return `${userId}:${key}`;
}

// --- Core CRUD ---

/**
 * Get a single setting value, decrypted if needed.
 * @param key - The setting key
 * @param userId - User ID (default 1 for single-user)
 * @returns The setting value or null if not set
 */
export function getSetting(key: string, userId = 1): string | null {
  const ck = cacheKey(key, userId);
  if (cache.has(ck)) return cache.get(ck) ?? null;

  const row = db
    .select()
    .from(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, key)))
    .get();

  if (!row) {
    cache.set(ck, null);
    return null;
  }

  const value = row.isEncrypted ? decrypt(row.value) : row.value;
  cache.set(ck, value);
  return value;
}

/**
 * Set a setting value, encrypting if specified.
 * @param key - The setting key
 * @param value - The plaintext value
 * @param options - Whether to encrypt, and the user ID
 */
export function setSetting(
  key: string,
  value: string,
  options?: { encrypted?: boolean; userId?: number },
): void {
  const userId = options?.userId ?? 1;
  const shouldEncrypt = options?.encrypted ?? false;

  if (shouldEncrypt && !isEncryptionAvailable()) {
    throw new ValidationError(
      'Cannot store encrypted settings: SETTINGS_ENCRYPTION_KEY is not configured.',
    );
  }

  const storedValue = shouldEncrypt ? encrypt(value) : value;

  db.insert(settings)
    .values({ userId, key, value: storedValue, isEncrypted: shouldEncrypt })
    .onConflictDoUpdate({
      target: [settings.userId, settings.key],
      set: {
        value: storedValue,
        isEncrypted: shouldEncrypt,
        updatedAt: sql`(datetime('now'))`,
      },
    })
    .run();

  // Invalidate cache for this key
  cache.set(cacheKey(key, userId), value);
}

/**
 * Get all settings for a user, with encrypted values decrypted.
 * @param userId - User ID (default 1)
 * @returns Record of key → decrypted value
 */
export function getAllSettings(
  userId = 1,
): Record<string, { value: string; isEncrypted: boolean }> {
  const rows = db.select().from(settings).where(eq(settings.userId, userId)).all();

  const result: Record<string, { value: string; isEncrypted: boolean }> = {};
  for (const row of rows) {
    const value = row.isEncrypted ? decrypt(row.value) : row.value;
    result[row.key] = { value, isEncrypted: row.isEncrypted };
    cache.set(cacheKey(row.key, userId), value);
  }
  return result;
}

/**
 * Delete a setting.
 * @param key - The setting key
 * @param userId - User ID (default 1)
 */
export function deleteSetting(key: string, userId = 1): void {
  db.delete(settings)
    .where(and(eq(settings.userId, userId), eq(settings.key, key)))
    .run();
  cache.delete(cacheKey(key, userId));
}

// --- Config bridge (Tier 2) ---

/**
 * Get a configuration value with fallback chain: settings DB → env var → default.
 * This is the primary function consumers should use instead of config.*.
 * @param key - A known setting key
 * @returns The resolved value, or empty string if no value found
 */
export function getConfig(key: SettingKey): string {
  if (!envMigrated) {
    migrateFromEnv();
  }

  const dbValue = getSetting(key);
  if (dbValue !== null) return dbValue;

  const meta = SETTINGS_SCHEMA[key];
  if (meta.envVar) {
    const envValue = process.env[meta.envVar];
    if (envValue !== undefined && envValue !== '') return envValue;
  }

  return meta.defaultValue ?? '';
}

/**
 * Mask a secret value for display: show only last 4 chars.
 * @param value - The secret value
 * @returns Masked string like '••••••••xxxx'
 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return '••••••••';
  return '••••••••' + value.slice(-4);
}

// --- Env migration ---

/**
 * On first boot, import existing env var values into the settings table.
 * Runs once, inside a transaction, only if the settings table is empty.
 */
function migrateFromEnv(): void {
  envMigrated = true;

  // Check if settings table already has data
  const count = db.select({ id: settings.id }).from(settings).limit(1).get();
  if (count) return; // Already has settings, skip migration

  const entries = Object.entries(SETTINGS_SCHEMA) as [SettingKey, SettingMeta][];
  const toMigrate = entries.filter(([, meta]) => {
    if (!meta.envVar) return false;
    const val = process.env[meta.envVar];
    return val !== undefined && val !== '';
  });

  if (toMigrate.length === 0) return;

  // Skip encrypted values if encryption is not available
  const canEncrypt = isEncryptionAvailable();

  let migrated = 0;
  for (const [key, meta] of toMigrate) {
    const value = process.env[meta.envVar!]!;
    if (meta.encrypted && !canEncrypt) {
      logger.warn(
        { event: 'settings_migration_skip', key },
        'Skipping encrypted setting migration: SETTINGS_ENCRYPTION_KEY not set',
      );
      continue;
    }
    setSetting(key, value, { encrypted: meta.encrypted });
    migrated++;
  }

  if (migrated > 0) {
    logger.info(
      { event: 'settings_migrated_from_env', count: migrated },
      'Migrated settings from environment variables',
    );
  }
}

/**
 * Build a masked settings response for API consumers.
 * Returns all known keys with encrypted values masked (last 4 chars).
 * @param userId - User ID (default 1)
 * @returns Record of key → { value, isEncrypted, section }
 */
export function getMaskedSettingsResponse(
  userId = 1,
): Record<string, { value: string | null; isEncrypted: boolean; section: string }> {
  const stored = getAllSettings(userId);
  const result: Record<string, { value: string | null; isEncrypted: boolean; section: string }> =
    {};
  for (const [key, meta] of Object.entries(SETTINGS_SCHEMA)) {
    const entry = stored[key];
    let displayValue: string | null = entry?.value ?? null;
    if (meta.encrypted && displayValue) {
      displayValue = maskSecret(displayValue);
    }
    result[key] = {
      value: displayValue,
      isEncrypted: meta.encrypted,
      section: meta.section,
    };
  }
  return result;
}

/**
 * Verify the confirm_password against the SETTINGS_AUTH_HASH env var.
 * @param password - The password to verify
 * @returns NextResponse with 403 if invalid, or null if valid
 */
export async function verifySettingsPassword(password: string): Promise<NextResponse | null> {
  if (!process.env.SETTINGS_AUTH_HASH) {
    throw new ValidationError('SETTINGS_AUTH_HASH is not configured. Cannot verify password.');
  }
  const valid = await verifyPassword(password);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 403 });
  }
  return null;
}

/**
 * Clear the in-memory cache. Useful for testing.
 */
export function clearSettingsCache(): void {
  cache.clear();
  envMigrated = false;
}
