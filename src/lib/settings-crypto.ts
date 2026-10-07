import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ValidationError } from '@/lib/errors';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Check whether the SETTINGS_ENCRYPTION_KEY env var is set and valid.
 * @returns true if a 32-byte hex key is available
 */
export function isEncryptionAvailable(): boolean {
  const key = process.env.SETTINGS_ENCRYPTION_KEY;
  return typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key);
}

let _cachedKey: Buffer | null = null;
let _cachedKeySource: string | undefined;

function getKey(): Buffer {
  const hex = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) {
    throw new ValidationError(
      'SETTINGS_ENCRYPTION_KEY is not set or invalid. Must be a 64-char hex string (32 bytes).',
    );
  }
  if (_cachedKey && _cachedKeySource === hex) return _cachedKey;
  _cachedKey = Buffer.from(hex, 'hex');
  _cachedKeySource = hex;
  return _cachedKey;
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param plaintext - The value to encrypt
 * @returns Colon-separated hex string: iv:authTag:ciphertext
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an AES-256-GCM encrypted value.
 * @param encryptedValue - Colon-separated hex string: iv:authTag:ciphertext
 * @returns The original plaintext
 */
export function decrypt(encryptedValue: string): string {
  const key = getKey();
  const parts = encryptedValue.split(':');
  if (parts.length !== 3) {
    throw new ValidationError('Invalid encrypted value format');
  }
  const iv = Buffer.from(parts[0]!, 'hex');
  const authTag = Buffer.from(parts[1]!, 'hex');
  const ciphertext = Buffer.from(parts[2]!, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
