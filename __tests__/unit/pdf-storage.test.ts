import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import {
  validatePdfMagicBytes,
  getPdfPath,
  storePdf,
  readPdf,
  pdfExists,
  deletePdf,
  isValidPdfImageName,
  storePdfImage,
  readPdfImage,
  pdfImageExists,
  deletePdfImages,
} from '@/lib/pdf-storage';
import { NotFoundError } from '@/lib/errors';

let testDir: string;

beforeEach(() => {
  testDir = path.join(os.tmpdir(), `pdf-storage-test-${randomUUID()}`);
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// --- validatePdfMagicBytes ---

describe('validatePdfMagicBytes', () => {
  it('accepts a buffer starting with %PDF-1.4', () => {
    expect(validatePdfMagicBytes(Buffer.from('%PDF-1.4 rest of header'))).toBe(true);
  });

  it('accepts exactly the 5 magic bytes', () => {
    expect(validatePdfMagicBytes(Buffer.from('%PDF-'))).toBe(true);
  });

  it('rejects when %PDF- appears only in the middle of the buffer', () => {
    expect(validatePdfMagicBytes(Buffer.from('JUNK%PDF-1.4'))).toBe(false);
  });

  it('rejects empty buffer', () => {
    expect(validatePdfMagicBytes(Buffer.alloc(0))).toBe(false);
  });

  it('rejects buffer shorter than 5 bytes', () => {
    expect(validatePdfMagicBytes(Buffer.from('%PDF'))).toBe(false);
  });

  it('rejects zip/docx magic bytes', () => {
    expect(validatePdfMagicBytes(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(false);
  });

  it('rejects PNG magic bytes', () => {
    expect(validatePdfMagicBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(false);
  });
});

// --- getPdfPath ---

describe('getPdfPath', () => {
  it('returns <dir>/<hash>.pdf', () => {
    expect(getPdfPath('abc123', '/some/dir')).toBe('/some/dir/abc123.pdf');
  });
});

// --- storePdf ---

describe('storePdf', () => {
  it('returns the correct SHA-256 hex hash', async () => {
    const buf = Buffer.from('%PDF-1.4 hello');
    const expected = createHash('sha256').update(buf).digest('hex');
    const hash = await storePdf(buf, testDir);
    expect(hash).toBe(expected);
  });

  it('writes the file to getPdfPath(hash, dir)', async () => {
    const buf = Buffer.from('%PDF-1.4 test content');
    const hash = await storePdf(buf, testDir);
    expect(await pdfExists(hash, testDir)).toBe(true);
  });

  it('creates the directory if absent', async () => {
    const nested = path.join(testDir, 'nested', 'sub');
    const buf = Buffer.from('%PDF-1.4 nested');
    const hash = await storePdf(buf, nested);
    expect(await pdfExists(hash, nested)).toBe(true);
  });

  it('is idempotent when called twice with the same buffer', async () => {
    const buf = Buffer.from('%PDF-1.4 idempotent');
    const hash1 = await storePdf(buf, testDir);
    const hash2 = await storePdf(buf, testDir);
    expect(hash1).toBe(hash2);
  });
});

// --- readPdf ---

describe('readPdf', () => {
  it('round-trips: stored bytes match read bytes', async () => {
    const buf = Buffer.from('%PDF-1.4 round trip content');
    const hash = await storePdf(buf, testDir);
    const result = await readPdf(hash, testDir);
    expect(result).toEqual(buf);
  });

  it('throws NotFoundError (not ENOENT) for an unknown hash', async () => {
    await mkdir(testDir, { recursive: true });
    await expect(readPdf('deadbeef'.repeat(8), testDir)).rejects.toBeInstanceOf(NotFoundError);
  });
});

// --- pdfExists ---

describe('pdfExists', () => {
  it('returns true after storePdf', async () => {
    const buf = Buffer.from('%PDF-1.4 exists');
    const hash = await storePdf(buf, testDir);
    expect(await pdfExists(hash, testDir)).toBe(true);
  });

  it('returns false for an unknown hash', async () => {
    await mkdir(testDir, { recursive: true });
    expect(await pdfExists('unknown'.repeat(9), testDir)).toBe(false);
  });

  it('returns false after deletePdf', async () => {
    const buf = Buffer.from('%PDF-1.4 delete me');
    const hash = await storePdf(buf, testDir);
    await deletePdf(hash, testDir);
    expect(await pdfExists(hash, testDir)).toBe(false);
  });
});

// --- deletePdf ---

describe('deletePdf', () => {
  it('removes the file', async () => {
    const buf = Buffer.from('%PDF-1.4 to delete');
    const hash = await storePdf(buf, testDir);
    await deletePdf(hash, testDir);
    expect(await pdfExists(hash, testDir)).toBe(false);
  });

  it('is idempotent: no error when called twice', async () => {
    const buf = Buffer.from('%PDF-1.4 double delete');
    const hash = await storePdf(buf, testDir);
    await deletePdf(hash, testDir);
    await expect(deletePdf(hash, testDir)).resolves.toBeUndefined();
  });
});

// --- isValidPdfImageName ---

describe('isValidPdfImageName', () => {
  it.each(['img-0.jpeg', 'img-0.jpg', 'img-99.png', 'img-123.jpeg'])(
    'accepts valid name: %s',
    (name) => {
      expect(isValidPdfImageName(name)).toBe(true);
    },
  );

  it.each(['../../etc/passwd', '..\\..\\windows\\system32', '/etc/passwd', 'img-0.jpeg/../other'])(
    'rejects traversal attempt: %s',
    (name) => {
      expect(isValidPdfImageName(name)).toBe(false);
    },
  );

  it.each([
    ['empty string', ''],
    ['missing digit after dash', 'img-.jpeg'],
    ['wrong extension gif', 'img-0.gif'],
    ['uppercase extension', 'img-0.JPEG'],
    ['uppercase prefix', 'IMG-0.jpeg'],
    ['1000-char name', 'img-' + '1'.repeat(1000) + '.jpeg'],
    ['leading dot', '.img-0.jpeg'],
    ['letter in digit position', 'img-0a.jpeg'],
    ['double dash before digit', 'img--1.jpeg'],
    ['double dot in extension', 'img-0..jpeg'],
  ])('rejects invalid: %s', (_label, name) => {
    expect(isValidPdfImageName(name)).toBe(false);
  });
});

// --- storePdfImage / readPdfImage ---

describe('storePdfImage / readPdfImage', () => {
  const hash = 'b'.repeat(64);

  it('round-trips: stored bytes match read bytes', async () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    await storePdfImage(hash, 'img-0.jpeg', buf, testDir);
    const result = await readPdfImage(hash, 'img-0.jpeg', testDir);
    expect(result).toEqual(buf);
  });

  it('returns null for a missing image', async () => {
    await mkdir(testDir, { recursive: true });
    const result = await readPdfImage(hash, 'img-99.jpeg', testDir);
    expect(result).toBeNull();
  });

  it('creates the hash subdirectory if absent', async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await storePdfImage(hash, 'img-0.png', buf, testDir);
    expect(await pdfImageExists(hash, 'img-0.png', testDir)).toBe(true);
  });
});

// --- pdfImageExists ---

describe('pdfImageExists', () => {
  const hash = 'c'.repeat(64);

  it('returns true after storePdfImage', async () => {
    await storePdfImage(hash, 'img-0.jpeg', Buffer.from([0]), testDir);
    expect(await pdfImageExists(hash, 'img-0.jpeg', testDir)).toBe(true);
  });

  it('returns false before any write', async () => {
    await mkdir(testDir, { recursive: true });
    expect(await pdfImageExists(hash, 'img-0.jpeg', testDir)).toBe(false);
  });
});

// --- deletePdfImages ---

describe('deletePdfImages', () => {
  const hash = 'd'.repeat(64);

  it('removes the entire hash subdirectory', async () => {
    await storePdfImage(hash, 'img-0.jpeg', Buffer.from([1]), testDir);
    await storePdfImage(hash, 'img-1.png', Buffer.from([2]), testDir);
    await deletePdfImages(hash, testDir);
    expect(await pdfImageExists(hash, 'img-0.jpeg', testDir)).toBe(false);
    expect(await pdfImageExists(hash, 'img-1.png', testDir)).toBe(false);
  });

  it('is idempotent: no error when directory is already absent', async () => {
    await mkdir(testDir, { recursive: true });
    await expect(deletePdfImages(hash, testDir)).resolves.toBeUndefined();
    await expect(deletePdfImages(hash, testDir)).resolves.toBeUndefined();
  });
});
