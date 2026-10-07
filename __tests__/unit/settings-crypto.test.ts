import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Store original env
const originalEnv = process.env.SETTINGS_ENCRYPTION_KEY;

describe('settings-crypto', () => {
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
    } else {
      process.env.SETTINGS_ENCRYPTION_KEY = originalEnv;
    }
    vi.resetModules();
  });

  describe('isEncryptionAvailable', () => {
    it('returns true when valid 64-char hex key is set', async () => {
      process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64);
      const { isEncryptionAvailable } = await import('@/lib/settings-crypto');
      expect(isEncryptionAvailable()).toBe(true);
    });

    it('returns false when key is not set', async () => {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
      const { isEncryptionAvailable } = await import('@/lib/settings-crypto');
      expect(isEncryptionAvailable()).toBe(false);
    });

    it('returns false when key is too short', async () => {
      process.env.SETTINGS_ENCRYPTION_KEY = 'abcdef';
      const { isEncryptionAvailable } = await import('@/lib/settings-crypto');
      expect(isEncryptionAvailable()).toBe(false);
    });
  });

  describe('encrypt/decrypt roundtrip', () => {
    beforeEach(() => {
      // 32 random bytes as hex
      process.env.SETTINGS_ENCRYPTION_KEY =
        'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344';
    });

    it('encrypts and decrypts a string correctly', async () => {
      const { encrypt, decrypt } = await import('@/lib/settings-crypto');
      const plaintext = 'sk-ant-api03-mysecretkey123';
      const encrypted = encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted).toContain(':'); // iv:authTag:ciphertext format
      const decrypted = decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });

    it('produces different ciphertexts for the same input (random IV)', async () => {
      const { encrypt } = await import('@/lib/settings-crypto');
      const plaintext = 'same-input';
      const a = encrypt(plaintext);
      const b = encrypt(plaintext);
      expect(a).not.toBe(b);
    });

    it('returns hex format iv:authTag:ciphertext', async () => {
      const { encrypt } = await import('@/lib/settings-crypto');
      const encrypted = encrypt('test');
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);
      // IV is 12 bytes = 24 hex chars
      expect(parts[0]).toHaveLength(24);
      // Auth tag is 16 bytes = 32 hex chars
      expect(parts[1]).toHaveLength(32);
      // Ciphertext is non-empty
      expect(parts[2]!.length).toBeGreaterThan(0);
    });
  });

  describe('encrypt without key', () => {
    it('throws ValidationError when SETTINGS_ENCRYPTION_KEY is not set', async () => {
      delete process.env.SETTINGS_ENCRYPTION_KEY;
      const { encrypt } = await import('@/lib/settings-crypto');
      expect(() => encrypt('test')).toThrow('SETTINGS_ENCRYPTION_KEY');
    });
  });

  describe('decrypt with invalid format', () => {
    beforeEach(() => {
      process.env.SETTINGS_ENCRYPTION_KEY =
        'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344';
    });

    it('throws on invalid format', async () => {
      const { decrypt } = await import('@/lib/settings-crypto');
      expect(() => decrypt('not-valid')).toThrow('Invalid encrypted value format');
    });
  });
});
