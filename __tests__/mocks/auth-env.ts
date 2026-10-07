import { beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { clearAuthCaches } from '@/lib/auth';

export const TEST_PASSWORD = 'test-password-123';
export const TEST_ENCRYPTION_KEY =
  'aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344';

/**
 * Registers beforeEach/afterEach hooks that provision the auth env vars
 * (SETTINGS_AUTH_HASH for TEST_PASSWORD, SETTINGS_ENCRYPTION_KEY) and reset
 * the in-memory auth caches around each test.
 */
// One hash serves every test — bcrypt output for the same input is interchangeable
let cachedHash: string | null = null;

export function setupAuthEnv(): void {
  beforeEach(async () => {
    cachedHash ??= await bcrypt.hash(TEST_PASSWORD, 4); // Low rounds for fast tests
    process.env.SETTINGS_AUTH_HASH = cachedHash;
    process.env.SETTINGS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    delete process.env.AUTH_DISABLED;
    clearAuthCaches();
  });

  afterEach(() => {
    delete process.env.SETTINGS_AUTH_HASH;
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    delete process.env.AUTH_DISABLED;
    clearAuthCaches();
  });
}
